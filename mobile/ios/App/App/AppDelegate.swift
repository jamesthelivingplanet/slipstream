import UIKit
import Capacitor
import FirebaseCore
import FirebaseMessaging

/// TASK-F0TYG (Android)/FLO-149 (iOS): the daemon speaks FCM HTTP v1 only
/// (electron/services/fcm.ts) — there is no separate raw-APNs send path — so
/// this app registers for remote notifications with APNs and then bridges
/// the resulting APNs token through Firebase to get an FCM registration
/// token, exactly like the Android build (which talks to FCM directly, no
/// APNs hop needed there). `MessagingDelegate` is what receives that bridged
/// token (and any later rotation) via `didReceiveRegistrationToken` below.
@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, MessagingDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Only configure Firebase when a real GoogleService-Info.plist has
        // been supplied (it's gitignored — see mobile/ios/.gitignore — and
        // must be dropped in before building, mirroring how
        // mobile/android/.gitignore handles google-services.json). A build
        // without it must still launch normally; push simply stays
        // unavailable, same degrade-gracefully contract every other native
        // bridge module in this app follows (src/lib/push.ts etc.).
        if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
            FirebaseApp.configure()
            Messaging.messaging().delegate = self
        }
        // Override point for customization after application launch.
        return true
    }

    /// APNs registration succeeded — hand the raw APNs token to Firebase so
    /// it can mint (or refresh) the FCM registration token. The documented
    /// Capacitor+FCM recipe posts that FCM token (NOT the raw APNs token) as
    /// `.capacitorDidRegisterForRemoteNotifications`, because that's the
    /// Capacitor PushNotifications plugin's 'registration' event — and
    /// src/lib/push.ts's listener for that event forwards straight to
    /// saveFcmToken(), which the daemon sends through FCM HTTP v1. Posting
    /// the APNs token there instead would silently break push (the daemon
    /// has no way to address a raw APNs token).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
        Messaging.messaging().token { fcmToken, error in
            if let error = error {
                NotificationCenter.default.post(
                    name: .capacitorDidFailToRegisterForRemoteNotifications,
                    object: error
                )
                return
            }
            guard let fcmToken = fcmToken else { return }
            NotificationCenter.default.post(
                name: .capacitorDidRegisterForRemoteNotifications,
                object: fcmToken
            )
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: error
        )
    }

    /// FCM token ROTATION (not just first registration) fires through here,
    /// independent of a fresh APNs registration. Re-posting the same
    /// notification name the Capacitor plugin listens for means
    /// src/lib/push.ts's existing 'registration' handler re-upserts the
    /// token server-side without any additional wiring on the JS side.
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken = fcmToken else { return }
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: fcmToken
        )
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
