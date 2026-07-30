import Capacitor
import UIKit

/// TASK-I9S44: the iOS mirror of `MainActivity.java` — the daemon URL is a
/// runtime preference, not just the build-time constant baked into
/// capacitor.config.ts/capacitor.config.json.
///
/// The @capacitor/preferences plugin (used from src/lib/nativeStorage.ts, key
/// `slipstream.daemonUrl`) persists on iOS into `UserDefaults.standard` under
/// a `CapacitorStorage.`-prefixed key (the plugin's iOS storage backend —
/// there is no separate SharedPreferences-style group here the way there is
/// on Android). We read that directly here — the Preferences plugin itself
/// isn't initialized this early — and, if a valid http(s) URL is present,
/// override `descriptor.serverURL` before the bridge is created. Absent/
/// invalid pref => the descriptor from `super` is left untouched, i.e.
/// today's baked `capacitor.config.json` `server.url`. Existing installs are
/// unaffected.
class MainViewController: CAPBridgeViewController {

    private static let daemonUrlKey = "CapacitorStorage.slipstream.daemonUrl"

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()

        if let overrideUrl = Self.resolveRuntimeServerUrl() {
            // InstanceDescriptor.serverURL is a String (not URL) — see
            // CAPInstanceDescriptor.h. Assigning it is exactly what the
            // `server.url` key in capacitor.config.json feeds at parse time.
            descriptor.serverURL = overrideUrl.absoluteString
        }

        return descriptor
    }

    override func capacitorDidLoad() {
        // TASK-I9S44: register the app-local AppControl plugin — the same
        // JS-visible surface (window.Capacitor.Plugins.AppControl) the
        // Android build registers via MainActivity.registerPlugin(). Must
        // happen here (not in AppDelegate) since the bridge doesn't exist
        // until the view controller's own bridge is created.
        bridge?.registerPluginInstance(AppControlPlugin())
    }

    /// Mirrors MainActivity.resolveRuntimeServerUrl()/isValidHttpUrl(): trims
    /// the stored preference, requires it to parse as a URL with an http/https
    /// scheme and a non-empty host, and returns nil for anything else so the
    /// caller falls back to the baked config.
    private static func resolveRuntimeServerUrl() -> URL? {
        guard let raw = UserDefaults.standard.string(forKey: daemonUrlKey) else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else {
            return nil
        }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return nil
        }
        guard let host = url.host, !host.isEmpty else {
            return nil
        }
        return url
    }
}
