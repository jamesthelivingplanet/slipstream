package app.slipstream.mobile;

/**
 * TASK-DM25C: shared SharedPreferences key contract between
 * AppControlPlugin.syncWidget() (writer, driven by src/lib/widgetSync.ts)
 * and AgentWidgetProvider/AgentWidgetFactory (readers). Kept as plain
 * constants rather than duplicated string literals so the two sides can't
 * silently drift.
 */
final class WidgetPrefs {

    static final String PREFS_NAME = "SlipstreamWidget";

    /** JSON array of {id, title, repo, bucket, statusLabel} plus optional
     *  {prChip, ciChip, reviewChip, costLabel} — see WidgetSessionSnapshotEntry
     *  in src/lib/widgetSync.ts for the shape. */
    static final String SESSIONS_JSON_KEY = "sessionsJson";

    /** Epoch millis the snapshot was produced, per Date.now() on the JS side. */
    static final String UPDATED_AT_KEY = "updatedAt";

    private WidgetPrefs() {}
}
