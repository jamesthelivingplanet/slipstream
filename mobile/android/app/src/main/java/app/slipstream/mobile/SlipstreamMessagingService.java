package app.slipstream.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * FLO-160: maintains an always-visible "ongoing" Android notification that
 * shows the running-agent count and the top pending "needs you" ask, so a
 * user can glance at the notification shade without opening the app.
 *
 * Driven by data-only "slipstreamSummary" FCM messages produced by the
 * server's per-episode transitionKind dedup in electron/services/pushService
 * .ts — never a raw session-status subscription, which fires on every PTY
 * chunk and ping-pongs needs<->running on an idle TUI (see CLAUDE.md's
 * status-flapping gotcha and docs/ARCHITECTURE.md §Session status pipeline).
 * Naive wiring would make this notification flicker constantly instead of
 * reflecting real episode transitions.
 *
 * Scope: this service ONLY routes data-only summary messages. Per-session
 * transition notifications (which carry an FCM `notification` block) are
 * NOT handled here — FCM auto-displays those in the background, and the
 * @capacitor/push-notifications plugin dispatches them in the foreground.
 * onMessageReceived early-returns for anything that is not a summary, so
 * non-summary data-only messages pass through untouched.
 *
 * Dispatch: this service is declared for MESSAGING_EVENT with
 * android:priority="1" so it deterministically outranks the Capacitor
 * push-notifications plugin's own MessagingService (default priority 0)
 * and Firebase's base FirebaseMessagingService (priority -500). Android
 * delivers each FCM message to exactly one such service. Because we win,
 * we also own onNewToken and forward it to PushNotificationsPlugin so the
 * app's 'registration' listener (src/lib/push.ts) still re-fires on FCM
 * token rotation — without this, the server would keep a stale token.
 * Foreground per-session messages need no forwarding: the app registers no
 * 'pushNotificationReceived' JS listener, and background ones are
 * auto-displayed by the system regardless of which service wins.
 */
public class SlipstreamMessagingService extends FirebaseMessagingService {

    /** Marker key the server sets on every ongoing-summary data message. */
    private static final String SUMMARY_MARKER_KEY = "slipstreamSummary";
    private static final String SUMMARY_MARKER_VALUE = "1";

    private static final String DATA_RUNNING_COUNT = "runningCount";
    private static final String DATA_ASK_SESSION_ID = "askSessionId";
    private static final String DATA_ASK_TID = "askTid";
    private static final String DATA_ASK_MESSAGE = "askMessage";

    /** Stable id so each snapshot update replaces the prior notification
     *  rather than stacking a new one. */
    static final int ONGOING_NOTIF_ID = 1;

    private static final String CHANNEL_ID = "SLIPSTREAM_ONGOING";

    /** Running-blue, matches AgentWidgetService's running bucket color. */
    private static final int ACCENT_COLOR = Color.parseColor("#4C8DFF");

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        // Only data-only "slipstreamSummary" messages belong to us. Anything
        // else (now or in the future) is left alone; notification-bearing
        // messages never reach onMessageReceived in the background anyway —
        // FCM auto-displays them.
        String marker = msg.getData().get(SUMMARY_MARKER_KEY);
        if (marker == null || !marker.equals(SUMMARY_MARKER_VALUE)) {
            return;
        }

        int runningCount = parseCount(msg.getData().get(DATA_RUNNING_COUNT));
        String askSessionId = msg.getData().get(DATA_ASK_SESSION_ID);
        String askTid = msg.getData().get(DATA_ASK_TID);
        String askMessage = msg.getData().get(DATA_ASK_MESSAGE);

        boolean show = runningCount > 0 || askSessionId != null;

        NotificationManager nm =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) {
            return;
        }
        ensureChannelExists(nm);

        if (!show) {
            nm.cancel(ONGOING_NOTIF_ID);
            return;
        }

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setColor(ACCENT_COLOR)
            .setContentIntent(launchIntent(askSessionId));

        if (askSessionId != null) {
            // Title = ticket id when available (more recognizable than a
            // bare "Slipstream"), else the app name.
            String title = (askTid != null && !askTid.isEmpty()) ? askTid
                : getString(R.string.ongoing_title_agents_running);
            String text = (askMessage != null && !askMessage.isEmpty())
                ? askMessage
                : getString(R.string.ongoing_ask_default);
            b.setContentTitle(title);
            b.setContentText(text);
            if (runningCount > 0) {
                // Fold the count in as a second line so both the ask and the
                // running-agent count are visible at a glance.
                b.setSubText(getResources().getQuantityString(
                    R.plurals.ongoing_agents_running, runningCount, runningCount));
            }
        } else {
            // No ask: lead with the count.
            b.setContentTitle(getString(R.string.ongoing_title_agents_running));
            b.setContentText(
                getResources().getQuantityString(R.plurals.ongoing_agents_running,
                    runningCount, runningCount));
        }

        nm.notify(ONGOING_NOTIF_ID, b.build());
    }

    /** Parses the running-count data value defensively; a missing or
     *  non-numeric value is treated as 0 rather than crashing the service. */
    private static int parseCount(String raw) {
        if (raw == null) {
            return 0;
        }
        try {
            return Integer.parseInt(raw);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** Tap intent mirroring AgentWidgetProvider's launch intent. When an
     *  ask is present, the sessionId extra lets MainActivity deep-link into
     *  that session (see MainActivity.forwardWidgetSessionId); otherwise
     *  the tap just opens the app. */
    private PendingIntent launchIntent(String askSessionId) {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launchIntent != null && askSessionId != null && !askSessionId.isEmpty()) {
            launchIntent.putExtra("sessionId", askSessionId);
        }
        // minSdk is 23 (M), where FLAG_IMMUTABLE was introduced.
        return PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /** Creates the IMPORTANCE_LOW ongoing channel if it doesn't already
     *  exist. createNotificationChannel is idempotent on API 26+, so no
     *  explicit existence check is needed. IMPORTANCE_LOW = no sound, no
     *  heads-up popup; the notification appears in the shade only, which
     *  is the right behavior for a glanceable status (not an alert). */
    private void ensureChannelExists(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel =
            new NotificationChannel(CHANNEL_ID,
                getString(R.string.notification_channel_ongoing_name),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.notification_channel_ongoing_desc));
        nm.createNotificationChannel(channel);
    }

    /** Because we win MESSAGING_EVENT (see class javadoc), token-refresh
     *  events are delivered HERE, not to the Capacitor plugin's
     *  MessagingService. The app's 'registration' listener (src/lib/push.ts)
     *  depends on the plugin's onNewToken to re-fire and re-save the token
     *  to the daemon — without this forward, FCM token rotation would leave
     *  the server holding a stale token and pushes would silently stop.
     *  PushNotificationsPlugin.onNewToken null-checks its own singleton, so
     *  this is a safe no-op if the plugin bridge hasn't initialized yet. */
    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        try {
            PushNotificationsPlugin.onNewToken(token);
        } catch (Throwable t) {
            // Never let a plugin-side failure crash the token-refresh path.
        }
    }
}
