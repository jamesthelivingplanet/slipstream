package app.slipstream.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
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
