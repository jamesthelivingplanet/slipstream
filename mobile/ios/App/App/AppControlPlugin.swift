import Capacitor
import LocalAuthentication
import UIKit

/// TASK-I9S44: iOS mirror of `AppControlPlugin.java` — the app-local plugin
/// used by src/lib/nativeStorage.ts (restart), src/lib/biometric.ts
/// (FLO-159), and the FLO-151 reply-credential stash. Registered from
/// `MainViewController.capacitorDidLoad()` (not via a Capacitor plugin
/// package — this plugin lives only in this app target, same as the Android
/// build's `registerPlugin(AppControlPlugin.class)` in `MainActivity`).
///
/// `jsName` MUST be exactly `AppControl` so `window.Capacitor.Plugins.AppControl`
/// resolves identically to the Android build — src/lib/*.ts feature-detect
/// this same plugin name on both platforms and don't know which native
/// platform they're on.
///
/// FLO-162 (widget Stop/Restart) has NO iOS counterpart in v1 — there is no
/// iOS home-screen widget yet (WidgetKit + an App Group is tracked as a
/// separate ticket). `syncWidget()`/`consumePendingWidgetAction()` below are
/// therefore documented no-ops/empty-resolves, not missing functionality.
@objc(AppControlPlugin)
public class AppControlPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppControlPlugin"
    public let jsName = "AppControl"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "restart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometricAvailability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometricAuthenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncWidget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumePendingWidgetAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveReplyCredentials", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearReplyCredentials", returnType: CAPPluginReturnPromise),
    ]

    /// TASK-I9S44: recreate the bridge's root view controller on the UI thread
    /// so `MainViewController.instanceDescriptor()` re-reads the daemon-URL
    /// preference and rebuilds against it — the iOS analogue of Android's
    /// `Activity.recreate()` (which re-runs `MainActivity.onCreate()`).
    /// There's no direct "recreate this VC in place" API on iOS, so this
    /// re-instantiates the `Main` storyboard's initial view controller (a
    /// fresh `MainViewController`) and swaps it in as the key window's root —
    /// same effect (new bridge, new descriptor read), no process restart.
    @objc func restart(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // FLO-149: NOT UIWindowScene.keyWindow — that's iOS 15.0+, but this
            // target's IPHONEOS_DEPLOYMENT_TARGET is 14.0, so it's a hard
            // compile error here. windows.first(where: isKeyWindow) is the
            // iOS-14-safe equivalent.
            guard let window = self.bridge?.viewController?.view.window ?? UIApplication.shared.connectedScenes
                .compactMap({ ($0 as? UIWindowScene)?.windows.first(where: { $0.isKeyWindow }) })
                .first
            else {
                call.reject("No window available to restart")
                return
            }

            let storyboard = UIStoryboard(name: "Main", bundle: nil)
            let fresh = storyboard.instantiateInitialViewController()
            window.rootViewController = fresh
            window.makeKeyAndVisible()
            call.resolve()
        }
    }

    /// FLO-159: reports whether biometric/device-credential unlock is usable
    /// right now, without prompting. Never rejects — src/lib/biometric.ts
    /// treats any failure to determine availability as "unavailable" and
    /// just skips the gate.
    ///
    /// Status vocabulary is shared across platforms (see biometric.ts's
    /// `BiometricAvailabilityStatus`): `available`, `no-hardware`,
    /// `none-enrolled`, `hw-unavailable`, `unsupported`, `unknown`. iOS's
    /// `LAError` doesn't distinguish "no enrolled biometrics" from "no
    /// device passcode set" as cleanly as Android's BiometricManager does,
    /// so both map to `none-enrolled` (there is nothing to enroll into
    /// without a passcode either) — the important distinction for callers is
    /// "could work if the user sets something up" vs. "this hardware/OS
    /// simply can't do it" (`no-hardware`/`hw-unavailable`).
    @objc func biometricAvailability(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        let canEvaluate = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)

        var result: [String: Any] = ["available": canEvaluate]
        if canEvaluate {
            result["status"] = "available"
        } else {
            result["status"] = Self.availabilityStatus(for: error)
        }
        call.resolve(result)
    }

    /// FLO-159: prompts for a fingerprint/Face ID (or device passcode
    /// fallback, since we ask for `.deviceOwnerAuthentication` rather than
    /// the biometry-only `.deviceOwnerAuthenticationWithBiometrics`) to
    /// unlock use of the saved daemon bearer token.
    ///
    /// Difference from Android worth calling out: iOS's LAContext only shows
    /// ONE localized reason string in its system prompt — there is no
    /// separate title/subtitle pair the way AndroidX BiometricPrompt has. We
    /// use `subtitle` (the more descriptive of the two JS-side strings) as
    /// that reason and ignore `title`, rather than concatenating both into an
    /// awkward run-on that Apple's HIG would flag.
    ///
    /// Always resolves, never rejects — a device quirk must not leave the JS
    /// promise hanging, same contract as the Android plugin.
    @objc func biometricAuthenticate(_ call: CAPPluginCall) {
        _ = call.getString("title", "Unlock Slipstream")
        let subtitle = call.getString(
            "subtitle",
            "Confirm it's you to use your saved server token"
        )

        let context = LAContext()
        context.evaluatePolicy(
            .deviceOwnerAuthentication,
            localizedReason: subtitle
        ) { success, error in
            DispatchQueue.main.async {
                if success {
                    call.resolve(["authenticated": true])
                    return
                }
                let (code, message) = Self.authenticateFailure(for: error)
                call.resolve([
                    "authenticated": false,
                    "error": message,
                    "code": code,
                ])
            }
        }
    }

    /// FLO-162: there is no iOS home-screen widget in v1 (that's WidgetKit +
    /// an App Group — a separate ticket). This is a documented no-op, NOT a
    /// broken feature: src/lib/widgetSync.ts calls this best-effort and
    /// treats a missing/failing native side as "nothing to sync", so simply
    /// resolving keeps that call site inert without special-casing iOS there.
    @objc func syncWidget(_ call: CAPPluginCall) {
        call.resolve()
    }

    /// FLO-162: the other half of the no-widget-on-iOS story above — with no
    /// widget, nothing could ever have stashed a pending row-tap action, so
    /// this always resolves empty (matching the Android "nothing pending"
    /// shape exactly, so the SPA's polling code doesn't need an iOS branch).
    @objc func consumePendingWidgetAction(_ call: CAPPluginCall) {
        call.resolve([:])
    }

    /// FLO-151: documented no-op. Android has a background `ReplyReceiver`
    /// that can POST an inline reply while the app process is dead, fed by a
    /// stashed daemon URL + bearer token this method writes to app-private
    /// SharedPreferences. iOS has no equivalent background reply receiver in
    /// v1, and the server deliberately only sends the data-only,
    /// inline-reply-capable push to Android tokens in the first place (see
    /// `sendNeedsReplyForAndroid` in electron/services/pushService.ts) — so
    /// nothing on iOS would ever consume a stashed token.
    ///
    /// Deliberately NOT persisting the bearer token here, even though the
    /// call receives it, is the safer choice: iOS has no reader for it, so
    /// holding it anywhere would be pure exposure with zero functional
    /// upside. This mirrors the Android plugin's own stance that the widget
    /// story stays token-free wherever nothing on the other end needs the
    /// token.
    @objc func saveReplyCredentials(_ call: CAPPluginCall) {
        call.resolve()
    }

    /// FLO-151: pairs with saveReplyCredentials() above — nothing was ever
    /// stashed, so nothing needs clearing. Kept as a real (resolving) method
    /// rather than omitted so src/lib/nativeStorage.ts's feature-detection
    /// (`plugin.clearReplyCredentials`) finds a callable function on iOS
    /// exactly as it does on Android, instead of silently no-op'ing one
    /// platform's call site differently from the other's.
    @objc func clearReplyCredentials(_ call: CAPPluginCall) {
        call.resolve()
    }

    /// Maps an LAError (or nil, e.g. simulator/no-biometry-configured cases)
    /// to the shared availability-status vocabulary. See the doc comment on
    /// biometricAvailability() above for the none-enrolled merge rationale.
    ///
    /// FLO-149: `LAError.Code.biometryNotPaired`/`.biometryDisconnected` are
    /// macOS-only (12.0+) — referencing them here would be a hard compile
    /// error on this iOS-only target, so they're deliberately absent.
    private static func availabilityStatus(for error: NSError?) -> String {
        guard let error = error, error.domain == LAErrorDomain else { return "unknown" }
        // FLO-149: guard-unwrap instead of switching over the Optional, so an
        // unmappable raw code (`else` branch) reads as "unknown" explicitly
        // rather than being folded into the old `case .none: "no-hardware"`.
        guard let code = LAError.Code(rawValue: error.code) else { return "unknown" }
        switch code {
        case .biometryNotAvailable:
            return "hw-unavailable"
        case .biometryNotEnrolled, .passcodeNotSet:
            return "none-enrolled"
        default:
            return "unknown"
        }
    }

    /// Maps an LAError from a failed evaluatePolicy() call to the shared
    /// `code` vocabulary (`user-canceled`, `lockout`, `no-credential`,
    /// `canceled`, `error`) that src/lib/biometric.ts and the Android plugin
    /// both use.
    private static func authenticateFailure(for error: Error?) -> (code: String, message: String) {
        guard let nsError = error as NSError?, nsError.domain == LAErrorDomain else {
            return ("error", error?.localizedDescription ?? "Authentication error")
        }
        let message = nsError.localizedDescription
        switch LAError.Code(rawValue: nsError.code) {
        case .userCancel, .appCancel:
            return ("user-canceled", message)
        case .userFallback:
            return ("canceled", message)
        case .systemCancel:
            return ("canceled", message)
        case .biometryLockout:
            return ("lockout", message)
        case .passcodeNotSet, .biometryNotEnrolled, .biometryNotAvailable:
            return ("no-credential", message)
        default:
            return ("error", message)
        }
    }
}
