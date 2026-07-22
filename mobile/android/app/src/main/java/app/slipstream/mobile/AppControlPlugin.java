package app.slipstream.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
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
 *
 * TASK-DM25C: syncWidget() mirrors a JSON snapshot of running agents (from
 * src/lib/widgetSync.ts) into plain SharedPreferences the AgentWidgetProvider
 * reads at render time. Deliberately no auth token here — session titles and
 * statuses are exactly what the widget is FOR showing on the home screen; the
 * auth token is the actual secret and stays behind secure storage, never
 * touching this plugin. See WidgetPrefs for the shared key contract.
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
}
