package app.slipstream.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import java.io.IOException;
import java.security.GeneralSecurityException;

/**
 * FLO-151 (hardened per docs/UX-GO-NO-GO.md B6): SharedPreferences contract
 * holding the daemon URL + bearer token the background {@link ReplyReceiver}
 * needs to POST an inline reply to {@code POST /inline-reply} — WITHOUT the
 * WebView/JS bridge running, since a RemoteInput reply can fire while the app
 * process is dead.
 *
 * Writer: {@code AppControlPlugin.saveReplyCredentials(url, token)}, driven
 * from src/lib/nativeStorage.ts whenever the token or daemon URL changes (so
 * the two never drift out of sync with what the SPA is actually using).
 * Reader: {@link ReplyReceiver}.
 *
 * ⚠️ Security posture: the bearer token is the app's actual secret. It is
 * stored in {@link EncryptedSharedPreferences} (file {@link #SECURE_PREFS_NAME}),
 * with a {@link MasterKey} whose raw key material lives in the AndroidKeyStore
 * and never lands in this app's own storage — so the on-disk file holds only
 * AES-256-GCM ciphertext, not the token itself. The key is deliberately NOT
 * bound to user presence or biometric auth: {@link ReplyReceiver} runs
 * unattended from a BroadcastReceiver, often with no Activity/UI to prompt
 * against, so a presence-gated key would make inline reply fail outright.
 * That still matches the documented at-rest threat model
 * (docs/SECURITY.md §6: encryption at rest does not defend against a
 * same-uid reader) — a rooted device, an OS-level backup of app data, or a
 * compromised copy of this app's own process can call the same Keystore API
 * this class does and get the plaintext back out, same as before. What DOES
 * change relative to the old plaintext MODE_PRIVATE copy: a plain file read
 * (an adb/OS backup of app data, a second app exploiting a path-traversal or
 * content-provider bug to read this app's files directly, a copied-off
 * device image) no longer yields the token — only same-uid code execution
 * does.
 *
 * Migration: installs upgrading from the FLO-151 prototype have the token
 * sitting in a plaintext {@code MODE_PRIVATE} file under
 * {@link #LEGACY_PREFS_NAME}. The first time either the writer or the reader
 * calls {@link #open}, any value still there is copied into the encrypted
 * store and the plaintext file is cleared — see {@link #migrateLegacyIfPresent}.
 *
 * Failure mode: if {@link EncryptedSharedPreferences} can't be initialized on
 * a given device (Keystore unavailable/corrupted, etc.), {@link #open}
 * returns {@code null}. Callers MUST treat that as "no credentials available"
 * — inline reply degrades to failing gracefully (see
 * {@code ReplyReceiver#onReceive}) — and must NEVER fall back to reading or
 * writing the plaintext file, which would defeat this entire change.
 */
final class ReplyPrefs {

    private static final String TAG = "ReplyPrefs";

    /** Legacy (FLO-151 prototype) plaintext MODE_PRIVATE prefs file. Only
     *  ever read once, for migration, then cleared — never written again. */
    private static final String LEGACY_PREFS_NAME = "SlipstreamReply";
    private static final String LEGACY_DAEMON_URL_KEY = "daemonUrl";
    private static final String LEGACY_TOKEN_KEY = "token";

    /** Encrypted-at-rest prefs file: values are AES-256-GCM ciphertext, keyed
     *  by a MasterKey whose key material lives in the AndroidKeyStore. */
    static final String SECURE_PREFS_NAME = "SlipstreamReplySecure";
    static final String DAEMON_URL_KEY = "daemonUrl";
    static final String TOKEN_KEY = "token";

    /** Per-session notification id derived from the sessionId, so each needs
     *  ask gets its own replaceable shade entry and none collides with the
     *  ongoing status notification's stable id (ONGOING_NOTIF_ID = 1). */
    static int notificationIdFor(String sessionId) {
        // Avoid the low ids reserved for other notifications; offset into a
        // range that won't collide with ONGOING_NOTIF_ID.
        return 1000 + Math.abs(sessionId.hashCode() % 1_000_000);
    }

    /**
     * Opens the encrypted reply-credentials store, migrating over any
     * leftover plaintext value from the old prototype prefs first. Returns
     * {@code null} if EncryptedSharedPreferences can't be initialized on
     * this device — see the class doc's Failure mode note.
     */
    static SharedPreferences open(Context context) {
        Context appContext = context.getApplicationContext();
        SharedPreferences secure = openSecure(appContext);
        if (secure == null) {
            return null;
        }
        migrateLegacyIfPresent(appContext, secure);
        return secure;
    }

    /**
     * Clears stashed reply credentials (logout / token rotation). Always
     * attempts to wipe the legacy plaintext file too, independent of
     * whether the encrypted store initialized successfully — a logout must
     * not leave an old plaintext copy behind on a device where Keystore
     * happens to be unavailable.
     */
    static void clearAll(Context context) {
        Context appContext = context.getApplicationContext();
        SharedPreferences secure = openSecure(appContext);
        if (secure != null) {
            secure.edit().clear().apply();
        }
        appContext.getSharedPreferences(LEGACY_PREFS_NAME, Context.MODE_PRIVATE).edit().clear().apply();
    }

    private static SharedPreferences openSecure(Context appContext) {
        try {
            MasterKey masterKey = new MasterKey.Builder(appContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();
            return EncryptedSharedPreferences.create(
                appContext,
                SECURE_PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
        } catch (GeneralSecurityException | IOException e) {
            // Do NOT fall back to plaintext here — see class doc's Failure
            // mode note. Callers treat a null return as "no credentials".
            Log.e(TAG, "EncryptedSharedPreferences unavailable; inline reply will be disabled on this device", e);
            return null;
        }
    }

    /** One-time upgrade path: if the old plaintext prefs file still has a
     *  url/token, copy them into the encrypted store and clear the
     *  plaintext file, so an upgrade doesn't silently break inline reply or
     *  leave the old plaintext copy sitting on disk. Idempotent — a no-op
     *  once the legacy file has been cleared. */
    private static void migrateLegacyIfPresent(Context appContext, SharedPreferences secure) {
        SharedPreferences legacy = appContext.getSharedPreferences(LEGACY_PREFS_NAME, Context.MODE_PRIVATE);
        String legacyUrl = legacy.getString(LEGACY_DAEMON_URL_KEY, null);
        String legacyToken = legacy.getString(LEGACY_TOKEN_KEY, null);
        if (legacyUrl == null && legacyToken == null) {
            return;
        }
        SharedPreferences.Editor secureEdit = secure.edit();
        if (legacyUrl != null) secureEdit.putString(DAEMON_URL_KEY, legacyUrl);
        if (legacyToken != null) secureEdit.putString(TOKEN_KEY, legacyToken);
        secureEdit.apply();
        legacy.edit().clear().apply();
        Log.i(TAG, "Migrated reply credentials from plaintext prefs into EncryptedSharedPreferences");
    }

    private ReplyPrefs() {}
}
