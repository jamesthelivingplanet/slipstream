package app.slipstream.mobile;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.widget.RemoteViews;

/**
 * TASK-DM25C: home-screen widget listing running agents and their status.
 * Purely a renderer over the SharedPreferences snapshot AppControlPlugin
 * .syncWidget() writes (see WidgetPrefs) — no network calls, no auth token,
 * so freshness is tied to the app JS layer having synced (foreground or
 * backgrounded-but-alive). See widgetSync.ts for why that tradeoff was made.
 */
public class AgentWidgetProvider extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId);
        }
    }

    /** Called by AppControlPlugin.syncWidget() right after a fresh snapshot
     *  lands, so the widget reflects it immediately rather than waiting for
     *  the next system-driven onUpdate (updatePeriodMillis, capped at 30min
     *  by the platform). */
    static void requestUpdate(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, AgentWidgetProvider.class);
        int[] ids = manager.getAppWidgetIds(component);
        for (int id : ids) {
            updateWidget(context, manager, id);
        }
        manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
    }

    private static void updateWidget(Context context, AppWidgetManager appWidgetManager, int appWidgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_agents);

        views.setTextViewText(R.id.widget_updated, updatedLabel(context));

        Intent serviceIntent = new Intent(context, AgentWidgetService.class);
        serviceIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        serviceIntent.setData(android.net.Uri.parse(serviceIntent.toUri(Intent.URI_INTENT_SCHEME)));
        // The 2-arg overload was deprecated in API 31 for the 3-arg one below;
        // minSdk is 23, so both paths are still needed.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            views.setRemoteAdapter(appWidgetId, R.id.widget_list, serviceIntent);
        } else {
            views.setRemoteAdapter(R.id.widget_list, serviceIntent);
        }
        views.setEmptyView(R.id.widget_list, R.id.widget_empty);

        Intent launchIntent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        // minSdk is 23 (M), where FLAG_IMMUTABLE was introduced, so it's always set.
        PendingIntent openApp = PendingIntent.getActivity(
            context,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widget_header, openApp);
        views.setPendingIntentTemplate(R.id.widget_list, openApp);

        appWidgetManager.updateAppWidget(appWidgetId, views);
    }

    private static String updatedLabel(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(WidgetPrefs.PREFS_NAME, Context.MODE_PRIVATE);
        long updatedAt = prefs.getLong(WidgetPrefs.UPDATED_AT_KEY, 0L);
        if (updatedAt <= 0L) {
            return context.getString(R.string.widget_never_synced);
        }
        long ageMs = System.currentTimeMillis() - updatedAt;
        long ageMin = ageMs / 60000L;
        if (ageMin < 1) {
            return context.getString(R.string.widget_updated_just_now);
        }
        if (ageMin < 60) {
            return context.getString(R.string.widget_updated_minutes_ago, ageMin);
        }
        long ageHours = ageMin / 60;
        return context.getString(R.string.widget_updated_hours_ago, ageHours);
    }
}
