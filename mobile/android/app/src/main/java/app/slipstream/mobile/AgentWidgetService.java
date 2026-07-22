package app.slipstream.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * TASK-DM25C: backs the widget's scrollable agent list. Reads the same
 * SharedPreferences snapshot AgentWidgetProvider does (see WidgetPrefs) —
 * RemoteViewsFactory instances are re-created per bind, so there's no
 * caching to invalidate beyond calling onDataSetChanged().
 */
public class AgentWidgetService extends RemoteViewsService {

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new AgentListFactory(getApplicationContext());
    }

    private static class AgentListFactory implements RemoteViewsFactory {

        private final Context context;
        private JSONArray sessions = new JSONArray();

        AgentListFactory(Context context) {
            this.context = context;
        }

        @Override
        public void onCreate() {
            onDataSetChanged();
        }

        @Override
        public void onDataSetChanged() {
            SharedPreferences prefs = context.getSharedPreferences(WidgetPrefs.PREFS_NAME, Context.MODE_PRIVATE);
            String json = prefs.getString(WidgetPrefs.SESSIONS_JSON_KEY, null);
            if (json == null) {
                sessions = new JSONArray();
                return;
            }
            try {
                sessions = new JSONArray(json);
            } catch (Exception e) {
                sessions = new JSONArray();
            }
        }

        @Override
        public void onDestroy() {
            sessions = new JSONArray();
        }

        @Override
        public int getCount() {
            return sessions.length();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_agents_item);
            JSONObject session = sessions.optJSONObject(position);
            if (session == null) {
                return row;
            }

            String title = session.optString("title", "");
            String statusLabel = session.optString("statusLabel", "");
            String bucket = session.optString("bucket", "idle");
            String repo = session.optString("repo", null);

            row.setTextViewText(R.id.item_title, title);
            row.setTextViewText(
                R.id.item_status,
                repo != null && !repo.isEmpty() ? statusLabel + " · " + repo : statusLabel
            );
            row.setInt(R.id.item_dot, "setColorFilter", colorForBucket(bucket));

            // Required for setPendingIntentTemplate (AgentWidgetProvider) to
            // make each row respond to taps — the template alone does nothing
            // without a fill-in intent per item. The sessionId extra merges
            // into the PendingIntent template's launch intent so MainActivity
            // can deep-link into this specific session (see onNewIntent).
            String sessionId = session.optString("id", "");
            Intent fillInIntent = new Intent();
            fillInIntent.putExtra("sessionId", sessionId);
            row.setOnClickFillInIntent(R.id.widget_item_root, fillInIntent);

            return row;
        }

        private static int colorForBucket(String bucket) {
            switch (bucket) {
                case "needs":
                    return Color.parseColor("#F5A623");
                case "running":
                    return Color.parseColor("#4C8DFF");
                case "done":
                    return Color.parseColor("#2ECC71");
                default:
                    return Color.parseColor("#9AA5B1");
            }
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 1;
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public boolean hasStableIds() {
            return true;
        }
    }
}
