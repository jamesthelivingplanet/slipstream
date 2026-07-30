package app.slipstream.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;

/**
 * TASK-I9S44: the daemon URL is a runtime preference, not just the build-time
 * constant baked into capacitor.config.ts/capacitor.config.json.
 *
 * The @capacitor/preferences plugin (used from src/lib/nativeStorage.ts, key
 * `slipstream.daemonUrl`) persists into the `CapacitorStorage` SharedPreferences
 * group. We read that directly here — the Preferences plugin itself isn't
 * initialized this early in onCreate() — and, if a valid http(s) URL is
 * present, override the server URL via CapConfig.Builder before the bridge
 * is created. Absent/invalid pref => this.config stays null => Bridge falls
 * back to CapConfig.loadDefault(), i.e. today's baked
 * capacitor.config.json server.url. Existing installs are unaffected.
 */
public class MainActivity extends BridgeActivity {

    private static final String PREFS_GROUP = "CapacitorStorage";
    private static final String DAEMON_URL_KEY = "slipstream.daemonUrl";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppControlPlugin.class);

        CapConfig override = resolveRuntimeServerUrl();
        if (override != null) {
            this.config = override;
        }

        super.onCreate(savedInstanceState);

        // Capacitor's own Bridge.initWebView() never sets these two, so they
        // default to false. Without them the WebView ignores the SPA's
        // <meta name="viewport" content="width=device-width"> (index.html)
        // and lays out at a wide desktop-style width, scaled down to fit —
        // which also breaks the SPA's own mobile/drawer layout, since those
        // are driven by matchMedia against that same (wrongly wide) viewport
        // (see src/lib/responsive.ts's MOBILE_BREAKPOINT/DRAWER_BREAKPOINT).
        WebSettings settings = getBridge().getWebView().getSettings();
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);

        // Cold start from a widget row tap (see AgentWidgetService).
        stashWidgetAction(getIntent());
    }

    /**
     * TASK-CQFRV: android:launchMode="singleTask" (manifest) means a widget
     * tap while the app is already running arrives here, not onCreate.
     */
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        stashWidgetAction(intent);
    }

    /**
     * FLO-162: stashes a widget row tap's sessionId/action into WidgetPrefs
     * for the SPA to pick up via AppControlPlugin.consumePendingWidgetAction().
     *
     * This replaces an earlier approach that dispatched a
     * 'slipstream:widget-open' DOM CustomEvent straight into the WebView via
     * evaluateJavascript(): nothing in the SPA ever listened for that event,
     * and even if something had, a cold start runs this before the page has
     * loaded, so the event would be dispatched into an empty document and
     * lost. Writing to SharedPreferences instead works identically for cold
     * start (the SPA reads the stash once it's up) and warm start (onNewIntent
     * fires while the SPA is already running and can poll immediately) — see
     * WidgetPrefs for the pending-action trio and its TTL.
     *
     * No-op if the intent didn't come from a widget tap (no sessionId extra).
     * A missing "action" extra defaults to "open" so an older widget instance
     * — built before Stop/Restart existed — still deep-links correctly.
     */
    private void stashWidgetAction(Intent intent) {
        if (intent == null) {
            return;
        }
        String sessionId = intent.getStringExtra("sessionId");
        if (sessionId == null || sessionId.isEmpty()) {
            return;
        }
        String action = intent.getStringExtra("action");
        if (action == null || action.isEmpty()) {
            action = "open";
        }

        SharedPreferences prefs = getSharedPreferences(WidgetPrefs.PREFS_NAME, Context.MODE_PRIVATE);
        prefs
            .edit()
            .putString(WidgetPrefs.PENDING_ACTION_KEY, action)
            .putString(WidgetPrefs.PENDING_SESSION_ID_KEY, sessionId)
            .putLong(WidgetPrefs.PENDING_AT_KEY, System.currentTimeMillis())
            .apply();
    }

    private CapConfig resolveRuntimeServerUrl() {
        SharedPreferences prefs = getSharedPreferences(PREFS_GROUP, Context.MODE_PRIVATE);
        String url = prefs.getString(DAEMON_URL_KEY, null);
        if (url == null) {
            return null;
        }
        url = url.trim();
        if (url.isEmpty() || !isValidHttpUrl(url)) {
            return null;
        }

        return new CapConfig.Builder(this).setServerUrl(url).create();
    }

    private static boolean isValidHttpUrl(String url) {
        Uri parsed = Uri.parse(url);
        String scheme = parsed.getScheme();
        if (scheme == null) {
            return false;
        }
        String lowerScheme = scheme.toLowerCase();
        boolean httpScheme = lowerScheme.equals("http") || lowerScheme.equals("https");
        return httpScheme && parsed.getHost() != null && !parsed.getHost().isEmpty();
    }
}
