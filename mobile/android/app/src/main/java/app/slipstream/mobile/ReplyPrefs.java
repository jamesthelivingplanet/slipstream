package app.slipstream.mobile;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * FLO-151: SharedPreferences contract holding the daemon URL + bearer token
 * the background {@link ReplyReceiver} needs to POST an inline reply to
 * {@code POST /inline-reply} — WITHOUT the WebView/JS bridge running, since a
 * RemoteInput reply can fire while the app process is dead.
 *
 * Writer: {@code AppControlPlugin.saveReplyCredentials(url, token)}, driven
 * from src/lib/nativeStorage.ts whenever the token or daemon URL changes (so
 * the two never drift out of sync with what the SPA is actually using).
 * Reader: {@link ReplyReceiver}.
 *
 * ⚠️ Security trade-off (prototype): the bearer token is the app's actual
 * secret, and it lives here in plaintext MODE_PRIVATE SharedPreferences
 * (unreadable by other apps, but readable by a same-uid reader). That matches
 * the documented at-rest threat model (docs/SECURITY.md §6: secrets at rest
 * do not defend against a same-uid reader), but it is a step DOWN from the
 * Keystore-backed {@code @aparajita/capacitor-secure-storage} the token
 * otherwise uses. Production hardening is to read the token back out of
 * Keystore in the receiver instead of keeping this copy — left as a follow-up
 * so the prototype can confirm RemoteInput actually works end-to-end first.
 */
final class ReplyPrefs {

    static final String PREFS_NAME = "SlipstreamReply";
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

    static SharedPreferences open(Context context) {
        return context.getApplicationContext()
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private ReplyPrefs() {}
}
