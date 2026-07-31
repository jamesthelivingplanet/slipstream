# iOS app — build & ship runbook (FLO-149)

Companion to [docs/plans/TASK-I9S44-mobile-apps.md](plans/TASK-I9S44-mobile-apps.md)
(the plan this ticket executes) and the Android side of the same shell. Cross-references:
[docs/ARCHITECTURE.md](ARCHITECTURE.md) (Mobile shell / Mobile home-screen widget),
[docs/SECURITY.md](SECURITY.md) (§11 biometric gate, §12 widget threat model),
[docs/VERSIONING.md](VERSIONING.md) (tag scheme Codemagic triggers on).

## What the iOS app is

Same kiosk shell as Android: a Capacitor `WKWebView` that loads the **daemon-served
SPA** at runtime (`mobile/capacitor.config.ts`'s `server.url`, overridable per-device via
the `slipstream.daemonUrl` Preferences key — see `MainViewController.swift`'s
`instanceDescriptor()` override, mirroring `MainActivity.java`). No backend code runs on
the device — no node-pty, no better-sqlite3 — the same reason the Android shell has none:
this is a thin client over the existing WebSocket `/rpc` transport
([docs/ARCHITECTURE.md](ARCHITECTURE.md) §Web mode), unchanged by the native wrapper.

Shared with Android: the SPA itself, the WebSocket transport, the `TokenGate`/session
auth model, the FLO-159 biometric-gate UX pattern (native `LocalAuthentication` behind
`AppControlPlugin.restart`'s sibling biometric methods), and the ServerGate/offline
fallback pages (`mobile/www/`).

**Deliberate v1 gaps vs Android** — state these to reviewers/users as design decisions,
not bugs:

| Gap | Why |
| --- | --- |
| No home-screen widget | Android's widget (FLO-162) is a `RemoteViewsService` + `AppWidgetProvider`, both Android-only concepts. An iOS equivalent is a WidgetKit extension + shared App Group container — real work, filed as a follow-up, not attempted here. |
| No inline notification reply | Android's `RemoteInput` action lets the OS collect a reply without opening the app; iOS has no equivalent wired into `AppControlPlugin` (`saveReplyCredentials`/`clearReplyCredentials` are deliberate no-ops on iOS). The daemon reflects this server-side too: `sendNeedsReplyForAndroid()` in `electron/services/pushService.ts` sends its data-only "needs reply" push **only to `platform === 'android'`** tokens — iOS tokens don't get a payload an iOS app can't act on. |
| No ongoing/persistent notification | Same root cause as the inline-reply gap: Android's ongoing summary notification is part of the same Android-only push shape. iOS gets the plain notification-bearing push (see Push below), not the ongoing one. |

## Prerequisites

- **Apple Developer Program** membership ($99/yr) — individual or organization; see Open
  decisions below.
- **A Mac with Xcode**, or **Codemagic** (this repo has no Mac in the loop otherwise — the
  implementing environment for this ticket is Linux; see Status).
- **CocoaPods** (`sudo gem install cocoapods`, or Codemagic's preinstalled version).
- **`GoogleService-Info.plist`** for Firebase project `slipstream-45299` (the same project
  the Android app uses) — download from the
  [Firebase console](https://console.firebase.google.com/) → Project settings → your iOS
  app (`app.slipstream.mobile`) → `GoogleService-Info.plist`. Place it at
  `mobile/ios/App/App/GoogleService-Info.plist`. It's gitignored (contains project-scoped
  API keys) — every fresh checkout and every CI run must supply it (Codemagic does this from
  a base64 secret; see the workflow below).

## Build from a Mac

```
pnpm install                      # repo root
cd mobile && pnpm install
npx cap sync ios
cd ios/App && pod install
open App.xcworkspace              # NOT App.xcodeproj
```

`mobile/ios/App/App.xcworkspace` only fully exists (with the `Pods` project wired in)
**after** `pod install` — opening `App.xcodeproj` directly, or the workspace before
`pod install` has run, builds without the Capacitor/Firebase/CocoaPods dependencies and
fails or crashes at launch. Run the target on a device or simulator from Xcode
(scheme `App`).

## Transport security (ATS)

The app is subject to Apple's App Transport Security. `Info.plist`'s
`NSAllowsLocalNetworking` permits plain `http://`/`ws://` to a daemon on the local network
(e.g. a Mac/phone on the same LAN during dev) — but a tailnet or otherwise remote daemon
**must** be `https://`/`wss://`. The blessed path is `tailscale serve` (or `tailscale
cert`) to terminate real TLS on the tailnet, matching `mobile/capacitor.config.ts`'s baked
`server.url` (`https://…ts.net`). We deliberately do **not** request
`NSAllowsArbitraryLoads` — it disables ATS globally and Apple requires written
justification for it at review, which "the user might point this at a plaintext
LAN daemon" doesn't clearly satisfy. See [docs/SECURITY.md](SECURITY.md) for the
threat model this sits inside (§8 origin pinning, §9 CSP/allowlist).

## Push: APNs-through-FCM, end to end

One Firebase project (`slipstream-45299`) fans out to both platforms so the daemon only
ever talks to FCM's HTTP v1 API — iOS delivery rides through APNs *underneath* FCM, not as
a second server integration:

1. An **APNs auth key (.p8)** is uploaded to the Firebase project (Firebase console →
   Project settings → Cloud Messaging → Apple app configuration). This is a one-time,
   per-Apple-team setup step — without it FCM has no way to reach APNs on the app's behalf.
2. `App.entitlements` declares `aps-environment` — `development` for local/simulator-adjacent
   builds, `production` for the App Store-signed build (Xcode/Fastlane sets this from the
   provisioning profile at archive time; a `development`-entitled build cannot receive
   production APNs pushes and vice versa).
3. `AppDelegate.swift` hands the raw APNs device token to `Messaging.messaging().apnsToken`
   on `didRegisterForRemoteNotificationsWithDeviceToken`, then posts the resulting **FCM**
   token (not the raw APNs token) on Capacitor's `registration` event — re-posted on every
   token rotation, same as Android.
4. `src/lib/push.ts` receives that token via the `registration` listener and calls
   `saveFcmToken({ token, platform: 'ios' })` over RPC — the `platform` tag is what lets
   the daemon route platform-specific behavior (see the "no inline reply" gap above).
5. `electron/services/pushService.ts` fans the token out to `sendFcmMessage`
   (notification-bearing) via `electron/services/fcm.ts`, which now includes an `apns`
   block (FLO-149) — `apns-priority: '10'` (deliver-now) and `payload.aps.sound: 'default'`
   — alongside the existing `android` block, in the same one un-branched FCM v1 request for
   both platforms (FCM translates `notification`/`data` into the APNs alert on its own).
   `sendFcmDataMessage` (the data-only "needs reply" push) is unchanged and Android-only
   per the gap above — it has no `apns` block, and FCM silently drops a data-only message on
   iOS with no `apns` headers rather than delivering it, which is the correct behavior here.

**Push is silently dead if…**

- `GoogleService-Info.plist` is missing — `AppDelegate.swift` guards `FirebaseApp.configure()`
  on the file's presence, so the app just runs with no push at all, no crash, no log a user
  would notice.
- The build's `aps-environment` doesn't match the APNs environment the token was minted
  for (dev-entitled build, prod push, or vice versa) — APNs silently drops the notification.
- No APNs auth key is registered against the Firebase project — FCM accepts the send
  (200 OK) but nothing ever reaches the device; check Firebase console's Cloud Messaging
  delivery diagnostics, not just the daemon's own logs.
- Testing on the **simulator** — simulators cannot register for real APNs tokens (Xcode 14+
  simulators support *local* notifications and a fake remote-notification payload via
  `xcrun simctl push`, but never a real FCM round-trip). Push only proves out on a physical
  device.

## App Store review — Guideline 2.1 (demo access)

**The top rejection risk.** The app is a thin client with no functionality until it's
pointed at a running daemon — a reviewer with no daemon of their own cannot use it, and
Apple routinely rejects under 2.1 ("Information Needed") for exactly this shape. Needs a
real plan, not just a review-notes paragraph.

### App Review notes (ready to paste)

> Slipstream is a self-hosted remote-control client for a coding-agent daemon that the
> user runs on their own machine or server — the same category as Termius, Blink Shell,
> and Home Assistant Companion: an app that is fully functional but requires the user's
> own backend, which is the point of the product, not a missing feature. For this review,
> we have stood up a temporary public demo daemon so the app can be evaluated without any
> setup:
>
> - Server URL: `https://<DEMO_HOST_PLACEHOLDER>`
> - Access token: `<DEMO_TOKEN_PLACEHOLDER>`
>
> Enter these in Settings → Server on first launch. The reviewer can create a repo-backed
> agent session, send it a prompt, and watch it work in the embedded terminal — this
> exercises the full core flow the app provides. This demo instance is intentionally
> temporary and sandboxed to a disposable repository; please let us know if it needs to
> stay up longer than the review window and we will extend it.

Fill in the two placeholders per the runbook below before submitting, and pull the demo
down (or at minimum rotate its token) once the review completes.

### Standing up the throwaway demo daemon

Two options, both from the plan doc's risk register:

| Option | Trade-off |
| --- | --- |
| **Throwaway VPS** (recommended) | Slower to stand up (provision a box, install Node, clone a sandbox repo) but fully isolated from James's own tailnet/devices — a reviewer with a live shell on it can't reach anything else. Recommend this precisely *because* the reviewer gets a real, unconstrained shell: giving that on infrastructure that's also personal is the wrong trade. |
| **Tailscale Funnel** | Already in this repo's stack (`tailscale serve`/`funnel`, see [docs/DEVELOPMENT.md](DEVELOPMENT.md)) and faster to stand up — expose an existing dev daemon publicly for the review window. Rejected as the default because Funnel exposes a node on James's own tailnet to the public internet for the duration; a misconfigured `SLIPSTREAM_TOKEN` or an accidentally-shared real repo is one mistake away from being reachable, whereas a VPS has nothing else on it to leak. |

Runbook (VPS option):

1. Provision a small VPS (any provider), install Node 22, clone this repo.
2. Clone or scaffold a disposable sandbox repo for the demo agent to work in — never point
   it at a real/private repo.
3. Set `SLIPSTREAM_TOKEN` to a freshly generated random token (this token *is* what goes in
   the review notes — treat it as public for the review window).
4. Put the daemon behind real TLS (a reverse proxy, or `tailscale serve` if the VPS also
   joins the tailnet) — plain `http://` fails the ATS requirement above for anyone testing
   over a network, and looks unfinished to a reviewer regardless.
5. Run `pnpm serve` (see [docs/DEVELOPMENT.md](DEVELOPMENT.md) for the headless-server
   invocation) and confirm `/healthz` responds.
6. Register the sandbox repo, verify a session can start end-to-end from a phone, then
   paste the URL/token into the App Review notes above.
7. **Tear down after the review window closes**: stop the service, and either destroy the
   VPS or at minimum rotate `SLIPSTREAM_TOKEN` — an approved app can be re-reviewed later
   (e.g. for an update) and Apple sometimes reuses old review notes, so don't leave a live
   token in a notes field indefinitely.

## Guideline 4.2 (minimal functionality)

Pre-emptive note for the same review notes field: the app is not a repackaged web page —
it's a native terminal/session UI (xterm.js in a `WKWebView`, which App Review has accepted
for terminal/SSH-style apps like Blink and Termius) with native integrations this ticket
adds (push notifications, biometric unlock, Keychain-backed credential storage) that a
plain Safari bookmark to the same URL would not have. Worth stating explicitly since 4.2
rejections are often a reviewer's first instinct for "WebView app."

## Privacy declarations (App Privacy "nutrition label")

| Question | Answer |
| --- | --- |
| Does the app collect analytics? | No. |
| Does the app use third-party trackers/advertising? | No. |
| Is any data linked to the user's identity? | No. |
| Push notification device token collected? | Yes — used for app functionality only (routing push to this install), not linked to identity, not used for tracking. |
| Are credentials (daemon URL/token) collected by the developer? | No — stored only in the device's own Keychain (`@aparajita/capacitor-secure-storage`) and sent only to the user's own self-hosted daemon; they never reach any server we operate. |

## Release flow

```
git tag vX.Y.Z (pnpm release)
  → Codemagic ios-testflight workflow (tag trigger, see codemagic.yaml)
    → fastlane beta → TestFlight internal (instant)
      → TestFlight external beta (first build only: ~1-day Apple beta review)
        → fastlane release → App Store submission (manual release, not automatic)
```

Manual App Store Connect steps that **cannot** be automated from this repo:

- Creating the app record itself (bundle id, name, primary category) — one-time, first
  submission only.
- Screenshots for the required iPhone size classes (6.7" and 6.9" sets, per current App
  Store Connect requirements).
- Age rating questionnaire.
- Export compliance: the app uses only standard HTTPS/TLS/WSS (no custom cryptography), so
  answer "No" to "does your app use non-exempt encryption" — but this is an explicit
  App Store Connect form field per submission, not something Fastlane can answer for you.

## Open decisions (James's calls)

The code currently assumes the **recommended** answer in each row; changing a decision
means changing the referenced file/config, not just this doc.

| Decision | Recommendation | What the code assumes today / how to reverse it |
| --- | --- | --- |
| Individual vs organization Apple Developer account | Individual is faster to enroll (hours vs days–weeks for a D-U-N-S org lookup); organization shows a company name instead of a personal legal name on the store listing. | No code dependency either way — only `Appfile`'s `team_id`/`itc_team_id` env values change once an account is chosen. |
| Mac hardware vs Codemagic for builds | Codemagic — no Mac available in this ticket's implementing environment (Linux); Codemagic's free tier covers occasional TestFlight builds. | `codemagic.yaml` is written and wired to the `v*` tag trigger already. Switching to a physical Mac means running the "Build from a Mac" steps above manually (or via a local Fastlane invocation) instead of relying on the tag trigger — no repo change required, just a different execution path. |
| iPhone-only v1 | Yes — halves the review/screenshot surface (only 6.7"/6.9" iPhone sets, no iPad sizes) and iPad support can follow later without re-architecting anything. | Already implemented: `TARGETED_DEVICE_FAMILY = 1` in the Xcode project build settings. To reverse: change that build setting to `1,2`, re-run `pod install`, add iPad screenshot sizes in App Store Connect, and test the layout at iPad's larger/split-view sizes (nothing in the SPA itself is iPhone-specific — it's the same responsive web client Android/desktop use). |
| Demo-daemon approach for Apple review | Throwaway VPS (see Guideline 2.1 above) | No code dependency — this is an operational choice made fresh for each submission, not something baked into the repo. |

## Status

**Everything in this ticket's scope is code-complete but UNVERIFIED on device.** The
implementing environment for FLO-149 is Linux with no Xcode, so nothing described in this
document — the Xcode project, the Swift plugin code, the Podfile, the Fastlane lanes, the
Codemagic workflow — has actually been compiled or run. Treat all of it as a first draft
that a real Mac build must confirm, specifically:

- [ ] `mobile/ios/App/App.xcworkspace` opens and the `App` target builds (Release, Debug)
  after `pod install` — confirms the Podfile/dependency graph is actually correct, not just
  plausible.
- [ ] CocoaPods resolves all pods (`Capacitor`, `CapacitorCordova`,
  `AparajitaCapacitorSecureStorage`, `CapacitorCommunitySpeechRecognition`,
  `CapacitorHaptics`, `CapacitorPreferences`, `CapacitorPushNotifications`,
  `FirebaseMessaging`) without version conflicts.
- [ ] The storyboard (`Base.lproj/Main.storyboard`) actually wires its view controller to
  `MainViewController` — a mismatch here fails silently at runtime (blank screen), not at
  build time.
- [ ] `AppControlPlugin` registers with the Capacitor bridge and its methods (`restart`,
  the biometric pair, and the no-op stubs) are callable from the SPA's existing
  `window.Capacitor.Plugins.AppControl` call sites shared with Android.
- [ ] The biometric prompt (`LocalAuthentication`) actually appears and round-trips a
  success/failure back to the SPA, matching the FLO-159 UX Android already has.
- [ ] A push token round-trips: device registers, `AppDelegate` receives an APNs token,
  hands it to `Messaging`, posts an FCM token, `saveFcmToken` RPC succeeds, and a live
  `sendFcmMessage` from the daemon actually arrives as a banner/sound on a physical device.
