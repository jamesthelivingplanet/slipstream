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

    /**
     * FLO-162: the app-mediated action channel. A Stop/Restart tap on a widget
     * row never talks to the daemon directly — the widget process has no auth
     * token and never will, so it can't make that call itself. Instead the tap
     * stashes an *intent* here (this trio) and launches the app; MainActivity
     * forwards it to AppControlPlugin.consumePendingWidgetAction(), which the
     * SPA polls on boot/resume and, holding the biometric-gated token, actually
     * performs the action. PENDING_ACTION_KEY is one of "open" | "stop" |
     * "restart"; PENDING_SESSION_ID_KEY is the target session; PENDING_AT_KEY
     * (epoch millis) bounds how long a stashed action stays live — see
     * PENDING_TTL_MS — so a tap that's never consumed (app killed before the
     * SPA got to it, etc.) can't fire a stale Stop/Restart long after the user
     * meant it. None of the three ever carries a credential.
     */
    static final String PENDING_ACTION_KEY = "pendingAction";

    static final String PENDING_SESSION_ID_KEY = "pendingSessionId";

    static final String PENDING_AT_KEY = "pendingAt";

    /** How long a stashed pending action is honored before it's treated as
     *  stale and discarded unfired. See PENDING_AT_KEY. */
    static final long PENDING_TTL_MS = 120_000L;

    private WidgetPrefs() {}
}
