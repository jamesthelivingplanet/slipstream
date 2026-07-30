package app.slipstream.mobile;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import androidx.core.app.NotificationCompat;
import androidx.core.app.RemoteInput;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * FLO-151: captures the typed reply from a needs-notification's RemoteInput
 * action and POSTs it to the daemon's {@code POST /inline-reply} endpoint —
 * WITHOUT launching the app. This is the background-capable write path the
 * ticket flags as the hard part: the app process (and its WebView/JS bridge)
 * may be dead when the user replies, so the reply can't go through the SPA's
 * WebSocket. Instead the daemon URL + bearer token are stashed in
 * {@link ReplyPrefs}, and this receiver reads them and makes a plain HTTP POST.
 *
 * Lifecycle: BroadcastReceiver.onReceive has ~10s before the system may kill
 * the process. A network POST is normally well under that, but to be safe we
 * goAsync() and run the POST on a worker thread, finishing the pending result
 * once the response is in. The notification is updated to "Reply sent" /
 * "Reply failed" so the user gets feedback without opening the app.
 *
 * Registered in AndroidManifest.xml for ACTION_REPLY. Only ever fired by the
 * reply PendingIntent SlipstreamMessagingService attaches to a needs-reply
 * notification, so no other intent handling is needed here.
 */
public class ReplyReceiver extends BroadcastReceiver {

    /** Best-effort network timeout for the inline-reply POST. Well under the
     *  ~10s BroadcastReceiver window but long enough for a tailnet round-trip. */
    private static final int CONNECT_TIMEOUT_MS = 4000;
    private static final int READ_TIMEOUT_MS = 6000;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !SlipstreamMessagingService.ACTION_REPLY.equals(intent.getAction())) {
            return;
        }
        String sessionId = intent.getStringExtra(SlipstreamMessagingService.EXTRA_SESSION_ID);
        int notifId = intent.getIntExtra(SlipstreamMessagingService.EXTRA_NOTIF_ID, -1);
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        String reply = results != null
            ? results.getString(SlipstreamMessagingService.KEY_REPLY_TEXT)
            : null;

        if (sessionId == null || sessionId.isEmpty() || reply == null || reply.trim().isEmpty()) {
            // Nothing to send (user submitted an empty reply) — just dismiss.
            cancel(context, notifId);
            return;
        }

        SharedPreferences prefs = ReplyPrefs.open(context);
        if (prefs == null) {
            // EncryptedSharedPreferences couldn't be initialized on this
            // device (Keystore unavailable/corrupted, etc.). Degrade to
            // "inline reply doesn't work" — never fall back to reading the
            // old plaintext file, which would defeat the whole point of
            // ReplyPrefs. See ReplyPrefs' class doc Failure mode note.
            updateNotification(context, notifId, "Slipstream",
                context.getString(R.string.reply_failed_storage_unavailable));
            return;
        }
        String url = prefs.getString(ReplyPrefs.DAEMON_URL_KEY, null);
        String token = prefs.getString(ReplyPrefs.TOKEN_KEY, null);
        if (url == null || url.isEmpty() || token == null || token.isEmpty()) {
            // Credentials were never synced (the SPA hasn't logged in, or this
            // is a fresh install). Can't POST — surface it on the notification.
            updateNotification(context, notifId, "Slipstream",
                context.getString(R.string.reply_failed_not_signed_in));
            return;
        }

        final PendingResult pendingResult = goAsync();
        final Context appContext = context.getApplicationContext();
        final String finalSessionId = sessionId;
        final String finalReply = reply.trim();
        final String finalUrl = url;
        final String finalToken = token;
        final int finalNotifId = notifId;

        new Thread(() -> {
            try {
                SendOutcome outcome = postInlineReply(finalUrl, finalToken, finalSessionId, finalReply);
                if (outcome.ok) {
                    updateNotification(appContext, finalNotifId, "Slipstream",
                        appContext.getString(R.string.reply_sent_confirmation));
                } else {
                    updateNotification(appContext, finalNotifId, "Slipstream",
                        "Reply failed (HTTP " + outcome.status + ")");
                }
            } catch (IOException e) {
                updateNotification(appContext, finalNotifId, "Slipstream",
                    appContext.getString(R.string.reply_failed_no_connection));
            } finally {
                pendingResult.finish();
            }
        }).start();
    }

    private static void cancel(Context context, int notifId) {
        if (notifId < 0) return;
        NotificationManager nm =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(notifId);
    }

    /** Replaces the needs-reply notification with a short confirmation/error
     *  line so the user gets feedback in the shade without opening the app. */
    private static void updateNotification(
        Context context, int notifId, String title, String text
    ) {
        if (notifId < 0) return;
        NotificationManager nm =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        // Reuse the alerts channel; this is a transient toast-in-the-shade.
        NotificationCompat.Builder b =
            new NotificationCompat.Builder(context, "SLIPSTREAM_ALERTS")
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW);
        nm.notify(notifId, b.build());
    }

    /** POST {sessionId, data} as JSON to `${baseUrl}/inline-reply` with the
     *  bearer token. Mirrors server.ts's /inline-reply contract: 204 on
     *  success, 401/404/400 on failure. Returns an {@link SendOutcome} rather
     *  than throwing for HTTP-level failures (only a true network-level
     *  IOException propagates). */
    private static SendOutcome postInlineReply(
        String baseUrl, String token, String sessionId, String data
    ) throws IOException {
        String endpoint = baseUrl.endsWith("/")
            ? baseUrl + "inline-reply"
            : baseUrl + "/inline-reply";
        HttpURLConnection conn = null;
        try {
            URL url = new URL(endpoint);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setDoOutput(true);

            JSONObject body = new JSONObject();
            body.put("sessionId", sessionId);
            body.put("data", data);
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setRequestProperty("Content-Length", String.valueOf(payload.length));
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }
            int status = conn.getResponseCode();
            // 2xx (204) is success; anything else is a failure carrying the
            // status for the user-facing message.
            return new SendOutcome(status >= 200 && status < 300, status);
        } catch (org.json.JSONException e) {
            // Should be impossible — sessionId/data are plain strings.
            return new SendOutcome(false, -1);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static final class SendOutcome {
        final boolean ok;
        final int status;

        SendOutcome(boolean ok, int status) {
            this.ok = ok;
            this.status = status;
        }
    }
}
