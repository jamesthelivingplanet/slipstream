# TASK-I9S44 — Android & iOS apps: plan to market ASAP

_Date: 2026-07-14 · Status: proposed_

## TL;DR

Wrap the **existing Svelte web client in a Capacitor shell** — one codebase, two
stores. Slipstream is already a phone-ready web app (web mode over Tailscale, PWA
manifest + service worker, web-push, mobile touch/reconnect fixes landed), so the
engineering work is a thin native shell, a connection screen, native push
(FCM/APNs), and store compliance. Realistic calendar: **TestFlight + Play internal
testing in ~2 weeks; iOS App Store live ~week 3–4; Google Play production ~week 3
or ~week 5** depending on whether the Play account is subject to Google's 14-day
closed-testing requirement. The long poles are bureaucratic, not technical — start
Phase 0 (accounts) today.

## Why Capacitor, not a rewrite

Evidence from the repo:

- **Web mode already exists and was designed for phones.** `docs/ARCHITECTURE.md`
  §Web mode: the same renderer runs in a plain browser "(e.g. a phone over
  Tailscale)" via `createWsApi` → WebSocket `/rpc` → `server.ts`. The mobile app
  is a thin client; **no backend code runs on the device** — no node-pty, no
  better-sqlite3, none of the native-ABI pain.
- **It's already a PWA**: `public/manifest.webmanifest`, `sw.js` service worker,
  `web-push` + VAPID in `pushService.ts`, `src/lib/push.ts` client plumbing,
  `pwa.test.ts` guarding it all.
- **Mobile hardening already landed**: TASK-EBA7M (PTY touch pan-to-scroll),
  FLO-103 (backgrounded-WebSocket reconnect — `visibilitychange`/`online`/
  `pageshow` fast-fail ping + full `resync()` on reconnect). The hard mobile
  problems for a terminal app are already solved in the web client.
- `wsApi` already takes `{ url, token }` — it is transport-parameterized; the
  shell just needs to feed it a remote daemon URL instead of `location.origin`.

Alternatives rejected:

| Option | Verdict |
| --- | --- |
| React Native / Flutter rewrite | Months of duplicate work; xterm.js has no native equivalent worth the port. |
| PWA only (add-to-home-screen) | Already works, keep it — but it has no store presence, which is the explicit goal. |
| Tauri 2 mobile | No benefit: there's no on-device backend to embed, and it forfeits the Capacitor plugin ecosystem (push, secure storage). |

## Target architecture

```
Capacitor shell (Android/iOS)
  WebView loads bundled dist/ (built Svelte SPA)
     └─ ServerGate screen → { daemonUrl, token } from secure storage
         └─ createWsApi({url, token}) ──wss──▶ user's daemon :7421 /rpc (over Tailscale)
  Native plugins: push-notifications (FCM/APNs), secure-storage (Keychain/Keystore),
                  keyboard, status-bar, haptics, app (deep links)
```

Deltas vs. the browser PWA:

1. **Bundle is local** (`capacitor://localhost`), not served by the daemon → the
   `?token=` boot path doesn't apply. Add a `ServerGate` (daemon URL + token,
   QR-pairing later) and parameterize `bootWeb()`'s URL derivation.
2. **Credentials in Keychain/Android Keystore** (secure-storage plugin), not
   localStorage.
3. **Transport security**: WKWebView/Android treat the app origin as secure, so a
   cleartext `ws://tailnet-ip` connection is mixed content. Blessed path:
   `tailscale serve` (or `tailscale cert`) to get real TLS on the tailnet →
   `wss://`. Fallback: Android network-security-config scoped to private ranges +
   iOS ATS exception. Document both; recommend wss.
4. **No Web Push in WKWebView** → native push required (Phase 2).

## Phases

### Phase 0 — Accounts & long poles (start today, mostly waiting)

- **Apple Developer Program** — $99/yr. Individual enrollment: hours–2 days; an
  organization needs a D-U-N-S number (days–weeks). Decide individual vs org now
  (org = "Company Name" on the store listing; individual = your legal name).
- **Google Play Console** — $25 one-time + identity verification. ⚠️ **Personal
  accounts created after Nov 2023 must run a closed test with ≥12 testers for 14
  continuous days before production access.** This is the single biggest ASAP
  blocker for Android — recruit ~15 testers now and start the clock in week 2.
  (Organization accounts and older accounts are exempt.)
- **macOS for iOS builds** — you're on Linux; Xcode is mandatory. Options:
  (a) **Codemagic** (recommended: mobile-first CI, free tier, manages signing,
  ships to both stores), (b) GitHub Actions macOS runners, (c) a used Mac mini.
  Note: GitLab.com shared-runner quota is already exhausted for this project, so
  don't plan around GitLab CI.
- Reserve bundle IDs (`app.slipstream.mobile` or similar), check the name
  "Slipstream" for collisions in both stores (likely contested — have a fallback
  display name like "Slipstream Agents"), and stand up a **privacy policy URL**
  (required by both stores; a static page on GitLab Pages is fine).

### Phase 1 — Capacitor shell (~2–4 days of eng)

- New **`mobile/`** directory (fits the repo's disjoint-dirs parallelization
  convention): Capacitor config with `webDir` → the Vite build output; Android +
  iOS platforms checked in.
- Boot path: `src/main.ts` detects `window.Capacitor` → boot from stored server
  config (secure storage) instead of `location.origin`; new `ServerGate.svelte`
  reusing `TokenGate` patterns.
- Mobile polish: `viewport-fit=cover` + safe-area insets, keyboard plugin resize
  mode (critical for xterm input), status-bar color synced to `data-mode`,
  icons/splash generated from the existing PWA icons via `@capacitor/assets`.
- Keep `pnpm check` / `test` / `lint` green; nothing in `electron/` changes.

### Phase 2 — Native push (~3–5 days, touches `contract.ts` — coordinate)

- Extend `pushService.ts` with a **transport abstraction**: existing `web-push`
  (VAPID) + a new **FCM HTTP v1** transport. One Firebase project covers Android
  natively and iOS via APNs-through-FCM (avoids a second server integration).
- `contract.ts` **additive** change: device-token registration (either a `kind:
  'webpush' | 'fcm'` on the existing subscription DTO or a new `push:saveDevice`
  channel). Additive to dodge the known contract.ts rebase collisions.
- Client: `@capacitor/push-notifications` → device token → RPC; handle token
  rotation (`registration` event re-fires) and prune dead tokens on FCM
  UNREGISTERED errors, mirroring the existing web-push 404/410 pruning.
- Respect the existing per-episode dedupe: `pushService.ts` stays the **only**
  status consumer; the FCM transport slots in below it, not beside it.
- Firebase service-account JSON goes in the config store — note SECURITY.md §6:
  plaintext at rest on the headless daemon behind the 0700 data dir.

### Phase 3 — Store compliance & assets (~2–3 days, parallel with 2)

- **Apple Guideline 2.1 (demo access) is the #1 rejection risk**: the app is
  useless without a personal daemon. Stand up a **public demo daemon** for the
  review window (throwaway VPS running `pnpm serve` with a sandboxed repo, or
  Tailscale Funnel) and put URL + token in the App Review notes, with a paragraph
  explaining the self-hosted model (precedents: Termius, Blink Shell, Home
  Assistant Companion).
- **iPhone-only for v1** (uncheck iPad) — halves screenshot/review surface; iPad
  can come later. Screenshots: 6.7"/6.9" iPhone set; Play: phone + feature
  graphic.
- Privacy declarations (Play Data safety + Apple privacy labels): no analytics,
  no third-party trackers; declare the push device token as an identifier and
  "data not collected" otherwise — credentials never leave the device except to
  the user's own server.
- Android target API level: current Play requirement (API 35 in the 2026 cycle) —
  Capacitor 7 defaults satisfy it.

### Phase 4 — Signing & CI/CD (~2–3 days)

- **Fastlane** in `mobile/`: `match` (iOS certs in a private repo) + `supply`
  (Play). Google Play App Signing on (default); upload key in CI secrets.
- Codemagic workflow: on tag → build AAB + IPA → upload to **Play internal
  track** and **TestFlight** automatically.

### Phase 5 — Beta → production

- TestFlight internal (instant) → external beta (first build gets a ~1-day beta
  review). Play internal testing is instant.
- Submit iOS for production review (typically 24–48 h; budget one rejection
  round for 2.1 demo-access questions).
- Play: closed test 14 days with 12+ testers (if the account requires it) →
  apply for production → review (hours–2 days).

## Calendar (1 engineer + agents, phases overlap)

| When | Milestone |
| --- | --- |
| Day 0 | Accounts submitted, testers recruited, CI/Mac decision, names/IDs reserved |
| End week 1 | Phase 1 done — app running on a real Android device + iOS simulator/device |
| End week 2 | Native push working; TestFlight + Play internal builds live; Play closed test **clock started** |
| Week 3 | iOS production submission; Android closed test running |
| Week 3–4 | **iOS live on the App Store** |
| Week 3 or 5 | **Android live on Play** — week 3 if exempt from closed testing, week 5 if not |

## Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Apple rejects for no demo access (2.1) | +1–2 weeks | Public demo daemon + detailed review notes before first submission |
| WKWebView blocks cleartext `ws://` | Can't connect | Bless `tailscale serve` TLS (wss); ATS/network-security-config fallback |
| Play 14-day closed-testing rule | Android +2 weeks | Check account age day 0; consider org account; start test in week 2 regardless |
| "Slipstream" name taken on stores | Listing churn | Check day 0; fallback display name ready |
| xterm keyboard/IME quirks in WebView | UX bugs | Already exercised via PWA use; keyboard-plugin resize mode; test Gboard + iOS keyboard early |
| FCM token rotation / dead tokens | Silent push loss | Re-register on rotation; prune on UNREGISTERED, mirroring web-push pruning |
| Apple 4.2 "minimal functionality" thin-client pushback | Rejection | Review notes cite self-hosted precedents (Termius, Home Assistant) |

## Follow-up tickets to cut

1. `mobile/` Capacitor shell + ServerGate + secure storage (Phase 1)
2. FCM transport in `pushService` + device-token RPC (`contract.ts` additive) (Phase 2)
3. Store assets, privacy policy, demo review daemon (Phase 3)
4. Fastlane + Codemagic pipelines (Phase 4)
5. Later: QR-code pairing from the desktop app, iPad layout, F-Droid/APK sideload channel for the store-averse

## Open decisions (for James)

- Individual vs organization developer accounts (affects Play 14-day rule and the
  publisher name shown on both stores).
- Mac hardware vs cloud CI for iOS builds (recommendation: Codemagic).
- iPhone-only v1? (recommendation: yes.)
- Demo-daemon approach for Apple review: throwaway VPS vs Tailscale Funnel.
