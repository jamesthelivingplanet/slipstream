package app.slipstream.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import org.json.JSONObject;

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
        forwardWidgetSessionId(getIntent());
    }

    /**
     * TASK-CQFRV: android:launchMode="singleTask" (manifest) means a widget
     * tap while the app is already running arrives here, not onCreate.
     */
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        forwardWidgetSessionId(intent);
    }

    /** Forwards a widget row's sessionId extra to the SPA as a DOM event
     *  (see App.svelte's 'slipstream:widget-open' listener). No-op if the
     *  intent didn't come from a widget tap. */
    private void forwardWidgetSessionId(Intent intent) {
        if (intent == null) {
            return;
        }
        String sessionId = intent.getStringExtra("sessionId");
        if (sessionId == null || sessionId.isEmpty()) {
            return;
        }
        WebView webView = getBridge().getWebView();
        if (webView == null) {
            return;
        }
        String js =
            "window.dispatchEvent(new CustomEvent('slipstream:widget-open', { detail: { sessionId: " +
            JSONObject.quote(sessionId) +
            " } }))";
        webView.evaluateJavascript(js, null);
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
