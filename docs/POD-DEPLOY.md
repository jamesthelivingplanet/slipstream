# Deploy Slipstream to a pod

Run the Slipstream daemon on a server you own — a VPS, a home-lab box, a rented
pod — and drive your agents from any device over your tailnet. Your code, your
keys, and your agents never leave infrastructure you control.

This is the "small laptop, big pod" path: one Docker command brings up the
daemon plus a Tailscale sidecar that publishes it over HTTPS, which is what
mobile browsers need to install the PWA and receive push notifications.

## What you'll have at the end

- The Slipstream daemon running in Docker on your pod, healthcheck green.
- Reachable at `https://<hostname>.<your-tailnet>.ts.net/` from your phone.
- Agents that clone private repos on demand and push branches/PRs back.

## Prerequisites

- A Linux host with **Docker** and the **Docker Compose** plugin
  (`docker --version`, `docker compose version`).
- An **Anthropic API key** — https://console.anthropic.com/settings/keys
- A **Tailscale** account with **HTTPS Certificates** enabled for your tailnet
  (one-time: admin console → DNS → Enable HTTPS):
  https://login.tailscale.com/admin/dns
- A **Tailscale auth key** — https://login.tailscale.com/admin/settings/keys
  (a reusable key is convenient; an ephemeral one works for a throwaway pod).
- (Optional, for push/PRs) a **GitHub token** with `repo` scope.

## 1. Get the code on the pod

```sh
git clone https://github.com/<you>/slipstream.git
cd slipstream
```

## 2. Configure secrets

```sh
cp .env.pod.example .env
$EDITOR .env
```

Fill in at least:

| Variable | What it is |
|---|---|
| `SLIPSTREAM_TOKEN` | Bearer token gating the daemon. Generate: `openssl rand -hex 16`. You paste it into the app on first connect. |
| `ANTHROPIC_API_KEY` | Authenticates Claude Code for every agent. |
| `TS_AUTHKEY` | Tailscale auth key — joins the pod to your tailnet. |

Optional but recommended so agents can push:

| Variable | What it is |
|---|---|
| `TS_HOSTNAME` | Machine name on the tailnet (default `slipstream`). |
| `GIT_USER_NAME` / `GIT_USER_EMAIL` | Commit identity. |
| `GH_TOKEN` | GitHub token for HTTPS clone + push. |

`.env` is gitignored — keep it on the pod, never commit it.

## 3. Bring it up

```sh
docker compose up -d --build
```

First run builds the image (a few minutes), joins the pod to your tailnet, and
starts the daemon. Watch it become healthy:

```sh
docker compose ps                 # slipstream -> healthy
docker compose logs -f slipstream # [slipstream-server] Listening on http://127.0.0.1:7421
```

Confirm the health check directly:

```sh
docker compose exec slipstream curl -fsS http://127.0.0.1:7421/healthz
# {"ok":true}
```

And over HTTPS from anywhere on your tailnet:

```sh
curl -fsS https://<TS_HOSTNAME>.<your-tailnet>.ts.net/healthz
# {"ok":true}
```

(Find the exact URL with `docker compose exec tailscale tailscale serve status`,
or in the Tailscale admin console.)

## 4. Drive it from your phone

1. On your phone (joined to the same tailnet via the Tailscale app), open
   `https://<TS_HOSTNAME>.<your-tailnet>.ts.net/`.
2. Paste the `SLIPSTREAM_TOKEN` when prompted.
3. Add a repo by its remote URL — the pod clones it on demand.
4. Start an agent. Install the PWA (**Add to Home Screen** / **Install App**)
   and allow notifications to get pinged when an agent needs you.

## How it works

- **`Dockerfile`** builds the daemon for the **Node** ABI and runs it with
  `node dist-electron/server.js` — no Electron binary, no GUI libraries. The
  `claude` CLI is installed globally so agents can spawn it.
- The daemon binds `127.0.0.1:7421` inside the container. The **Tailscale
  sidecar** shares that network namespace (`network_mode: service:tailscale`)
  and runs `tailscale serve` to expose it as HTTPS on your tailnet — so nothing
  is published to the public internet.
- A single named volume (`/home/slipstream`) persists the SQLite DB, cloned
  repos, worktrees, and Claude auth across restarts and rebuilds.

## Updating

```sh
git pull
docker compose up -d --build
```

Your data volume is preserved; only the image is rebuilt.

## Security notes

- The pod holds your Anthropic key and (if set) a GitHub token, and runs agents
  with `--dangerously-skip-permissions`. Keeping it **behind Tailscale + the
  bearer token** is the supported posture. **Do not** publish port 7421 to the
  public internet.
- Claude Code refuses `--dangerously-skip-permissions` as root, so the container
  runs as an unprivileged user (`slipstream`, uid 10001).
- Rotate `SLIPSTREAM_TOKEN` and `GH_TOKEN` like any other secret; they live only
  in `.env` on the pod.

## Troubleshooting

- **No HTTPS / `tailscale serve` errors** — enable HTTPS Certificates for the
  tailnet (admin console → DNS) and check `docker compose logs tailscale`. Cert
  issuance can lag a minute on first boot.
- **Agents fail immediately** — `ANTHROPIC_API_KEY` missing or invalid; check
  `docker compose logs slipstream` and the per-session logs in the volume
  (`/home/slipstream/state/logs/`).
- **Clone/push fails on a private repo** — set `GH_TOKEN` (and restart) so the
  in-container git credential helper is configured.
- **Can't reach 7421 standalone** — the daemon binds `127.0.0.1` by design. To
  run it behind your *own* proxy instead of the Tailscale sidecar, drop the
  sidecar service and set `SLIPSTREAM_BIND=0.0.0.0` with a published port. See
  the README for the non-Tailscale remote-access options.

## Podman

The commands above are verified on **Docker**. Podman is **not yet verified** and the
one-command compose path needs Podman-specific tweaks — tracked in **FLO-57**
(https://linear.app/floatilla/issue/FLO-57). The daemon image itself is standard and
should port to `podman build` / `podman run`; the known gaps are all in orchestration:

- **Named-volume ownership (rootless).** Add the `:U` option so the volume is chowned to
  the container user, e.g. `slipstream-data:/home/slipstream:U` — otherwise the daemon
  can't write its DB/worktrees under rootless UID remapping.
- **`network_mode: service:tailscale`.** Podman maps this to `--network container:<id>`;
  `podman compose` support for the compose `service:` form is version-dependent. A
  `podman pod` (or `podman kube play`) recipe may be the Podman-native equivalent.
- **Rootless Tailscale networking.** The sidecar uses kernel mode (`/dev/net/tun` +
  `NET_ADMIN`), which needs rootful Podman; rootless Tailscale requires userspace
  networking (`TS_USERSPACE=true`).
