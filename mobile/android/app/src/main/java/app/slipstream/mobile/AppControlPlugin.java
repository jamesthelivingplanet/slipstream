package app.slipstream.mobile;

import android.app.Activity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * TASK-I9S44: minimal app-control bridge used by src/lib/nativeStorage.ts
 * (Settings > Server) after the daemon URL preference changes. restart()
 * recreates the Activity on the UI thread — MainActivity.onCreate() re-reads
 * the preference and rebuilds the Bridge with the new server URL — without
 * killing the process, so the change takes effect immediately.
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
}
