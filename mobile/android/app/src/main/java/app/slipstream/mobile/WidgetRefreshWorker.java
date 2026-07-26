package app.slipstream.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * FLO-158: Periodic WorkManager job that refreshes the home-screen widget snapshot
 * without requiring the app to be in the foreground.
 *
 * The worker:
 * 1. Reads the auth token from Android Keystore-backed SecureStorage (same store
 *    the Capacitor @aparajita/capacitor-secure-storage plugin uses)
 * 2. Calls a lightweight HTTP endpoint on the daemon to get a session summary
 * 3. Pushes the fresh snapshot to the widget via AppControlPlugin.syncWidget()
 *
 * The token never touches the widget's SharedPreferences/RemoteViews render path
 * — it lives only in this worker's memory and the Keystore.
 */
public class WidgetRefreshWorker extends Worker {

    private static final String TAG = "WidgetRefreshWorker";

    // Constants matching @aparajita/capacitor-secure-storage's SecureStorage.java
    private static final String SECURE_PREFS_NAME = "WSSecureStorageSharedPreferences";
    private static final String TOKEN_KEY = "slipstream.token";
    private static final String ANDROID_KEY_STORE = "AndroidKeyStore";
    private static final String CIPHER_TRANSFORMATION = "AES/GCM/NoPadding";
    private static final char DATA_IV_SEPARATOR = '\u0010';
    private static final int BASE64_FLAGS = Base64.NO_PADDING | Base64.NO_WRAP;

    // Sync interval: every 15 minutes (min periodic interval for WorkManager is 15min)
    static final long SYNC_INTERVAL_MS = 15 * 60 * 1000L;

    // Unique work name for enqueueUniquePeriodicWork
    static final String WORK_NAME = "widget-refresh";

    public WidgetRefreshWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            // 1. Read auth token from SecureStorage (Keystore-backed)
            String token = readTokenFromSecureStorage();
            if (token == null || token.isEmpty()) {
                Log.w(TAG, "No auth token in SecureStorage — skipping widget refresh");
                return Result.success(); // Not an error; just nothing to sync yet
            }

            // 2. Get the daemon URL from Preferences (same as MainActivity)
            String daemonUrl = getDaemonUrl();
            if (daemonUrl == null || daemonUrl.isEmpty()) {
                Log.w(TAG, "No daemon URL configured — skipping widget refresh");
                return Result.success();
            }

            // 3. Fetch lightweight session summary from daemon
            WidgetSnapshotDTO snapshot = fetchWidgetSnapshot(daemonUrl, token);
            if (snapshot == null) {
                Log.w(TAG, "Failed to fetch widget snapshot — will retry next cycle");
                return Result.retry();
            }

            // 4. Push snapshot to widget via AppControlPlugin's SharedPreferences
            writeSnapshotToWidgetPrefs(snapshot);

            // 5. Trigger immediate widget update
            AgentWidgetProvider.requestUpdate(getApplicationContext());

            Log.i(TAG, "Widget snapshot refreshed (" + snapshot.sessions.size() + " sessions)");
            return Result.success();

        } catch (Exception e) {
            Log.e(TAG, "Widget refresh failed", e);
            return Result.retry();
        }
    }

    /** Reads the auth token from the same Keystore-backed store the Capacitor SecureStorage plugin uses. */
    private String readTokenFromSecureStorage() {
        try {
            SharedPreferences prefs = getApplicationContext()
                    .getSharedPreferences(SECURE_PREFS_NAME, Context.MODE_PRIVATE);
            String encrypted = prefs.getString(TOKEN_KEY, null);
            if (encrypted == null) return null;
            return decryptString(encrypted, TOKEN_KEY);
        } catch (Exception e) {
            Log.e(TAG, "Failed to read token from SecureStorage", e);
            return null;
        }
    }

    /** Reads the daemon URL from CapacitorStorage (same as MainActivity.resolveRuntimeServerUrl). */
    private String getDaemonUrl() {
        SharedPreferences prefs = getApplicationContext()
                .getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        String url = prefs.getString("slipstream.daemonUrl", null);
        if (url != null && !url.trim().isEmpty() && isValidHttpUrl(url.trim())) {
            return url.trim();
        }
        return null;
    }

    private static boolean isValidHttpUrl(String url) {
        try {
            android.net.Uri parsed = android.net.Uri.parse(url);
            String scheme = parsed.getScheme();
            if (scheme == null) return false;
            String lower = scheme.toLowerCase();
            boolean httpScheme = lower.equals("http") || lower.equals("https");
            return httpScheme && parsed.getHost() != null && !parsed.getHost().isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    /** Fetches a lightweight session summary from the daemon's /api/widget-summary endpoint. */
    private WidgetSnapshotDTO fetchWidgetSnapshot(String daemonUrl, String token) {
        HttpURLConnection conn = null;
        try {
            String endpoint = daemonUrl.replaceAll("/+$", "") + "/api/widget-summary";
            URL url = new URL(endpoint);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(15000);
            conn.setInstanceFollowRedirects(false);

            int responseCode = conn.getResponseCode();
            if (responseCode == 401 || responseCode == 403) {
                Log.w(TAG, "Auth failed (token expired/revoked) — clearing token");
                clearTokenFromSecureStorage();
                return null;
            }
            if (responseCode != 200) {
                Log.w(TAG, "Widget summary request failed: HTTP " + responseCode);
                return null;
            }

            String json = readResponse(conn.getInputStream());
            return parseWidgetSnapshot(json);

        } catch (IOException e) {
            Log.w(TAG, "Network error fetching widget summary", e);
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private String readResponse(java.io.InputStream is) throws IOException {
        java.util.Scanner s = new java.util.Scanner(is, StandardCharsets.UTF_8.name()).useDelimiter("\\A");
        return s.hasNext() ? s.next() : "";
    }

    /** Parses the JSON response into a DTO matching widgetSync.ts's WidgetSnapshot. */
    private WidgetSnapshotDTO parseWidgetSnapshot(String json) {
        try {
            JsonObject root = JsonParser.parseString(json).getAsJsonObject();
            WidgetSnapshotDTO dto = new WidgetSnapshotDTO();
            dto.updatedAt = System.currentTimeMillis();

            JsonArray sessionsArray = root.getAsJsonArray("sessions");
            if (sessionsArray != null) {
                for (int i = 0; i < sessionsArray.size(); i++) {
                    JsonObject s = sessionsArray.get(i).getAsJsonObject();
                    WidgetSessionDTO ws = new WidgetSessionDTO();
                    ws.id = s.get("id").getAsString();
                    ws.tid = s.get("tid").getAsString();
                    ws.title = s.get("title").getAsString();
                    ws.repo = s.get("repo").isJsonNull() ? null : s.get("repo").getAsString();
                    ws.bucket = s.get("bucket").getAsString();
                    ws.statusLabel = s.get("statusLabel").getAsString();

                    if (s.has("prChip") && !s.get("prChip").isJsonNull()) {
                        ws.prChip = parseChip(s.getAsJsonObject("prChip"));
                    }
                    if (s.has("ciChip") && !s.get("ciChip").isJsonNull()) {
                        ws.ciChip = parseChip(s.getAsJsonObject("ciChip"));
                    }
                    if (s.has("reviewChip") && !s.get("reviewChip").isJsonNull()) {
                        ws.reviewChip = parseChip(s.getAsJsonObject("reviewChip"));
                    }
                    ws.costLabel = s.has("costLabel") && !s.get("costLabel").isJsonNull()
                            ? s.get("costLabel").getAsString()
                            : null;

                    dto.sessions.add(ws);
                }
            }

            JsonObject counts = root.getAsJsonObject("counts");
            if (counts != null) {
                dto.counts.needs = counts.get("needs").getAsInt();
                dto.counts.running = counts.get("running").getAsInt();
                dto.counts.done = counts.get("done").getAsInt();
            }

            return dto;
        } catch (Exception e) {
            Log.e(TAG, "Failed to parse widget snapshot JSON", e);
            return null;
        }
    }

    private WidgetChipDTO parseChip(JsonObject chip) {
        WidgetChipDTO c = new WidgetChipDTO();
        c.label = chip.get("label").getAsString();
        c.cls = chip.get("cls").getAsString();
        return c;
    }

    /** Writes the snapshot JSON to the same SharedPreferences the widget reads from. */
    private void writeSnapshotToWidgetPrefs(WidgetSnapshotDTO snapshot) {
        Gson gson = new Gson();
        String sessionsJson = gson.toJson(snapshot.sessions);
        SharedPreferences prefs = getApplicationContext()
                .getSharedPreferences(WidgetPrefs.PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit()
                .putString(WidgetPrefs.SESSIONS_JSON_KEY, sessionsJson)
                .putLong(WidgetPrefs.UPDATED_AT_KEY, snapshot.updatedAt)
                .apply();
    }

    /** Clears the token from SecureStorage on auth failure (401/403). */
    private void clearTokenFromSecureStorage() {
        try {
            SharedPreferences prefs = getApplicationContext()
                    .getSharedPreferences(SECURE_PREFS_NAME, Context.MODE_PRIVATE);
            KeyStore keyStore = KeyStore.getInstance(ANDROID_KEY_STORE);
            keyStore.load(null);
            if (keyStore.containsAlias(TOKEN_KEY)) {
                keyStore.deleteEntry(TOKEN_KEY);
            }
            prefs.edit().remove(TOKEN_KEY).apply();
            Log.i(TAG, "Cleared expired/revoked token from SecureStorage");
        } catch (Exception e) {
            Log.e(TAG, "Failed to clear token from SecureStorage", e);
        }
    }

    // ── Decryption helpers (mirror @aparajita/capacitor-secure-storage) ──────────

    private String decryptString(String encryptedData, String alias)
            throws Exception {
        String[] parts = encryptedData.split(String.valueOf(DATA_IV_SEPARATOR));
        if (parts.length != 2) throw new IllegalArgumentException("Invalid encrypted format");

        // Format per SecureStorage: ciphertext + SEPARATOR + iv
        byte[] cipherText = Base64.decode(parts[0], BASE64_FLAGS);
        byte[] iv = Base64.decode(parts[1], BASE64_FLAGS);

        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEY_STORE);
        keyStore.load(null);
        SecretKey key = (SecretKey) keyStore.getKey(alias, null);
        if (key == null) throw new IllegalStateException("Key not found for alias: " + alias);

        Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
        GCMParameterSpec spec = new GCMParameterSpec(128, iv);
        cipher.init(Cipher.DECRYPT_MODE, key, spec);
        byte[] plain = cipher.doFinal(cipherText);
        return new String(plain, StandardCharsets.UTF_8);
    }

    // ── DTOs (mirror src/lib/widgetSync.ts WidgetSnapshot) ────────────────────

    static class WidgetSnapshotDTO {
        long updatedAt;
        java.util.List<WidgetSessionDTO> sessions = new java.util.ArrayList<>();
        WidgetCountsDTO counts = new WidgetCountsDTO();
    }

    static class WidgetCountsDTO {
        int needs = 0;
        int running = 0;
        int done = 0;
    }

    static class WidgetSessionDTO {
        String id;
        String tid;
        String title;
        String repo;
        String bucket;
        String statusLabel;
        WidgetChipDTO prChip;
        WidgetChipDTO ciChip;
        WidgetChipDTO reviewChip;
        String costLabel;
    }

    static class WidgetChipDTO {
        String label;
        String cls;
    }
}