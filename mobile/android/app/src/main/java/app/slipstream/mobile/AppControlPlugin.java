package app.slipstream.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * TASK-I9S44: minimal app-control bridge used by src/lib/nativeStorage.ts
 * (Settings > Server) after the daemon URL preference changes. restart()
 * recreates the Activity on the UI thread — MainActivity.onCreate() re-reads
 * the preference and rebuilds the Bridge with the new server URL — without
 * killing the process, so the change takes effect immediately.
 *
 * TASK-DM25C: syncWidget() mirrors a JSON snapshot of running agents (from
 * src/lib/widgetSync.ts) into plain SharedPreferences the AgentWidgetProvider
 * reads at render time. Deliberately no auth token here — session titles and
 * statuses are exactly what the widget is FOR showing on the home screen; the
 * auth token is the actual secret and stays behind secure storage, never
 * touching this plugin. See WidgetPrefs for the shared key contract.
 *
 * FLO-159: biometricAvailability()/biometricAuthenticate() gate the SPA's
 * stored daemon bearer token (the Keystore-backed
 * {@code @aparajita/capacitor-secure-storage} value src/lib/nativeStorage.ts
 * reads on boot) behind a fingerprint/biometric check on app open, using
 * AndroidX BiometricPrompt directly rather than a separate Capacitor plugin.
 * Deliberate residual gap: the ReplyPrefs token stash (FLO-151, used by the
 * background ReplyReceiver for inline replies when the app process is dead)
 * is NOT behind this gate. That copy lives in this app's own private-mode
 * SharedPreferences, which the threat actor this gate defends against
 * (someone holding the unlocked phone, poking at the UI) cannot read —
 * reading it requires the same OS-level same-uid access the documented
 * at-rest threat model already excludes (docs/SECURITY.md §6). Gating it too
 * would require a live fingerprint check inside a headless BroadcastReceiver
 * with no UI to prompt against, which would just break background inline
 * reply outright.
 */
@CapacitorPlugin(name = "AppControl")
public class AppControlPlugin extends Plugin {

    @PluginMethod
    public void restart(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No activity available to restart");
            return;
        }
        activity.runOnUiThread(activity::recreate);
        call.resolve();
    }

    @PluginMethod
    public void syncWidget(PluginCall call) {
        String sessionsJson = call.getString("sessionsJson");
        Long updatedAt = call.getLong("updatedAt");
        if (sessionsJson == null || updatedAt == null) {
            call.reject("sessionsJson and updatedAt are required");
            return;
        }

        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences(WidgetPrefs.PREFS_NAME, Context.MODE_PRIVATE);
        prefs
            .edit()
            .putString(WidgetPrefs.SESSIONS_JSON_KEY, sessionsJson)
            .putLong(WidgetPrefs.UPDATED_AT_KEY, updatedAt)
            .apply();

        AgentWidgetProvider.requestUpdate(context);
        call.resolve();
    }

    /** FLO-151: stash the daemon URL + bearer token the background
     *  ReplyReceiver needs to POST an inline reply when the app isn't
     *  running. Driven from src/lib/nativeStorage.ts whenever either value
     *  changes. See ReplyPrefs for the security trade-off. */
    @PluginMethod
    public void saveReplyCredentials(PluginCall call) {
        String url = call.getString("url");
        String token = call.getString("token");
        if (url == null || url.isEmpty() || token == null || token.isEmpty()) {
            call.reject("url and token are required");
            return;
        }
        ReplyPrefs.open(getContext())
            .edit()
            .putString(ReplyPrefs.DAEMON_URL_KEY, url)
            .putString(ReplyPrefs.TOKEN_KEY, token)
            .apply();
        call.resolve();
    }

    /** FLO-151: drop the stashed credentials (logout / token rotation). */
    @PluginMethod
    public void clearReplyCredentials(PluginCall call) {
        ReplyPrefs.open(getContext()).edit().clear().apply();
        call.resolve();
    }

    /** FLO-159: reports whether biometric/device-credential unlock is usable
     *  right now, without prompting. Never rejects — the JS side treats any
     *  failure to determine availability as "unavailable" and just skips the
     *  gate. */
    @PluginMethod
    public void biometricAvailability(PluginCall call) {
        AuthenticatorCheck check = resolveAuthenticators();

        JSObject ret = new JSObject();
        ret.put("available", check.status == BiometricManager.BIOMETRIC_SUCCESS);
        ret.put("status", biometricStatusToString(check.status));
        call.resolve(ret);
    }

    /** FLO-159: prompts for a fingerprint (or device credential fallback,
     *  where allowed) to unlock use of the saved daemon bearer token. Always
     *  resolves with a discriminated result — never rejects — so a device
     *  quirk can't leave the JS promise hanging. */
    @PluginMethod
    public void biometricAuthenticate(PluginCall call) {
        String title = call.getString("title", "Unlock Slipstream");
        String subtitle = call.getString("subtitle", "Confirm it's you to use your saved server token");

        Activity activity = getActivity();
        if (activity == null) {
            JSObject ret = new JSObject();
            ret.put("authenticated", false);
            ret.put("error", "No activity available");
            ret.put("code", "no-activity");
            call.resolve(ret);
            return;
        }

        // Reuse the exact same authenticator set biometricAvailability()
        // resolved, so what we told the caller was possible is what we
        // actually prompt with.
        int authenticators = resolveAuthenticators().authenticators;
        AtomicBoolean resolved = new AtomicBoolean(false);

        activity.runOnUiThread(() -> {
            try {
                FragmentActivity fragmentActivity = (FragmentActivity) activity;
                Executor executor = ContextCompat.getMainExecutor(getContext());
                BiometricPrompt prompt = new BiometricPrompt(
                    fragmentActivity,
                    executor,
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                            if (resolved.compareAndSet(false, true)) {
                                JSObject ret = new JSObject();
                                ret.put("authenticated", true);
                                call.resolve(ret);
                            }
                        }

                        @Override
                        public void onAuthenticationError(int errorCode, CharSequence errString) {
                            if (resolved.compareAndSet(false, true)) {
                                JSObject ret = new JSObject();
                                ret.put("authenticated", false);
                                ret.put("error", errString != null ? errString.toString() : "Authentication error");
                                ret.put("code", biometricErrorCodeToString(errorCode));
                                call.resolve(ret);
                            }
                        }

                        @Override
                        public void onAuthenticationFailed() {
                            // A single rejected fingerprint/face — the prompt
                            // stays up and the user can retry. Do NOT resolve
                            // the call here; only succeeded/error terminate it.
                        }
                    }
                );

                BiometricPrompt.PromptInfo.Builder promptInfo = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setAllowedAuthenticators(authenticators);

                // BiometricPrompt throws IllegalArgumentException if a
                // negative button is set together with DEVICE_CREDENTIAL in
                // the allowed authenticators — the system supplies its own
                // "use PIN"/cancel affordance in that case, so only add ours
                // when DEVICE_CREDENTIAL isn't part of the resolved set.
                if ((authenticators & BiometricManager.Authenticators.DEVICE_CREDENTIAL) == 0) {
                    promptInfo.setNegativeButtonText("Cancel");
                }

                prompt.authenticate(promptInfo.build());
            } catch (Exception e) {
                if (resolved.compareAndSet(false, true)) {
                    JSObject ret = new JSObject();
                    ret.put("authenticated", false);
                    ret.put("error", e.getMessage());
                    ret.put("code", "error");
                    call.resolve(ret);
                }
            }
        });
    }

    /** FLO-159: BiometricManager.canAuthenticate() with
     *  BIOMETRIC_STRONG | DEVICE_CREDENTIAL is unsupported on API 28/29
     *  (Android 9/10) — it returns BIOMETRIC_ERROR_UNSUPPORTED there instead
     *  of a real availability answer. Falls back to
     *  BIOMETRIC_WEAK | DEVICE_CREDENTIAL, then plain BIOMETRIC_STRONG, and
     *  reports back whichever authenticator set actually produced a real
     *  status so biometricAuthenticate() prompts with the very same set. */
    private AuthenticatorCheck resolveAuthenticators() {
        BiometricManager manager = BiometricManager.from(getContext());

        int authenticators =
            BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        int status = manager.canAuthenticate(authenticators);

        if (status == BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED) {
            authenticators =
                BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
            status = manager.canAuthenticate(authenticators);
        }
        if (status == BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED) {
            authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG;
            status = manager.canAuthenticate(authenticators);
        }

        return new AuthenticatorCheck(status, authenticators);
    }

    private static String biometricStatusToString(int status) {
        switch (status) {
            case BiometricManager.BIOMETRIC_SUCCESS:
                return "available";
            case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                return "no-hardware";
            case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                return "hw-unavailable";
            case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                return "none-enrolled";
            case BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED:
                return "security-update-required";
            case BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED:
                return "unsupported";
            case BiometricManager.BIOMETRIC_STATUS_UNKNOWN:
                return "unknown";
            default:
                return "unknown";
        }
    }

    private static String biometricErrorCodeToString(int errorCode) {
        switch (errorCode) {
            case BiometricPrompt.ERROR_USER_CANCELED:
            case BiometricPrompt.ERROR_NEGATIVE_BUTTON:
                return "user-canceled";
            case BiometricPrompt.ERROR_LOCKOUT:
            case BiometricPrompt.ERROR_LOCKOUT_PERMANENT:
                return "lockout";
            case BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL:
                return "no-credential";
            case BiometricPrompt.ERROR_CANCELED:
                return "canceled";
            default:
                return "error";
        }
    }

    /** Result of {@link #resolveAuthenticators()}: the BiometricManager
     *  status code alongside the authenticator bitmask that produced it, so
     *  callers never have to re-run (or duplicate) the API-level fallback
     *  ladder themselves. */
    private static final class AuthenticatorCheck {

        final int status;
        final int authenticators;

        AuthenticatorCheck(int status, int authenticators) {
            this.status = status;
            this.authenticators = authenticators;
        }
    }
}
