# Affido security & threat model

*Status: DRAFT — first pass written for the v0.1.0 public release. Reviewed
surfaces carry their reviewer; open items are listed at the bottom. This
document describes what an operator must trust and what the stack actively
defends.*

## What an operator must trust

Affido's control plane drives the host Docker daemon through
`/var/run/docker.sock`. The sandbox manager is **not** a multi-tenant
isolation boundary and is not hardened against a hostile Docker daemon: run
the stack on a host you control, for users you would otherwise trust with a
container on that host. The per-user sandbox network, the workspace
confinement and the closed toolbox are real fences inside that trust domain,
not a replacement for it.

## Assets

1. **User documents** — `corpus/raw/` and `uploads/` on the per-user
   `pi-ws-<user>` volume.
2. **Session state** — SQLite at `SESSION_DB` on the per-user `pi-data-<user>`
   volume (full conversation history, traces, annotations).
3. **Model credentials** — files under the host `secrets/` dir, mounted
   read-only at `/run/secrets` when a real provider is configured.
4. **Control-plane credentials** — `MANAGER_TOKEN` (manager HTTP API),
   `BETTER_AUTH_SECRET` (web sessions), the Postgres registry.
5. **Host integrity** — the Docker socket and the images the manager creates.

## Surfaces and defenses

### 1. The manager's Docker-socket surface (`sandbox-manager/`)

The manager is the only component that talks to `/var/run/docker.sock`. Its
HTTP API (port 8090) binds **no host port**; inside the compose network,
every endpoint except `/healthz` requires `X-Manager-Token: MANAGER_TOKEN`.
Caddy's `forward_auth` is the only unattended caller.

- `resolve` takes a `user_id` string; the sandbox name is derived through a
  deterministic slug, so a crafted id cannot name an arbitrary container.
- The manager also owns the sandbox **host wall**: for every network it
  creates it installs one `iptables INPUT DROP` rule on the host (via a
  short-lived host-network `NET_ADMIN` helper spawned through the same
  docker socket, running a script this module wrote — no user input reaches
  it). The rule closes the bridge-to-host INPUT path, which no docker
  network option covers; provisioning fails closed if the rule cannot be
  proven, and the reconcile tick re-asserts rules after daemon restarts.
- Registry writes and provisioning are serialized on the Postgres registry.
- **Open item:** an explicit audit of `create_args` inputs (network/volume
  names, image id) for injection through Docker CLI argument parsing.

### 2. Routing and identity (`caddy/Caddyfile`)

- Caddy is the only published port (`:18080`), bound to `127.0.0.1` by
  default (`CADDY_BIND` in `.env` is the documented opt-in for a LAN
  deployment). Per-user routes
  `/u/<user_id>/*` go through `forward_auth` to the manager's `/resolve`,
  which validates the better-auth session cookie and returns the upstream in
  `X-Sandbox-Endpoint`.
- Caddy **strips a client-supplied `X-Sandbox-Endpoint` before the dial**
  (GHSA-7r4p-vjf4-gxv4): a client can never choose its upstream or reach an
  agent container directly (agents publish no host ports).
- The e2e suite asserts the stripping and the 401/403 identity checks on
  every run.

### 3. Agent HTTP surface (`agent/tools.ts`)

Every route is an `HttpTool` with a declared activation behavior:

- **Workspace confinement.** `/files`, `/file`, `/ingest`, `/raw`,
  `/uploads/*`, `/skills/*`, `/artifacts/*` all resolve paths through the
  shared `NodeExecutionEnv` rooted at `WORKSPACE`. `safeTreePath` rejects
  absolute paths, `..` segments and over-deep trees; `/uploads` and
  `/artifacts` prefix their own roots. There is no raw `fs` handler.
- **Artifact downloads** are attachments with a static content type, capped
  at 25 MiB; symlinks under `artifacts/` are neither listed nor served.
- **No storage opens without intent.** `/health` and `/status` never open
  storage; the activating routes (`/prompt`, `/session*`, `/inspect`,
  `/files`, `/file`) are the only ones that do.

### 4. The publication gate (`agent/citation-*`)

With `citations: "required"` the reply exists only through the gate: token
scan, declared-vs-used equality, and re-verification of every quote against
the stored corpus text (sha256). Evidence fields are server-built; the model
never types them. `/corpus/citations` re-verifies on every read, so a
citation cannot outlive its document. This protects answer integrity, not
host integrity — but it is the component whose failure is most visible, and
it is the most heavily tested (gate table tests + e2e dance + restart
re-verification).

### 5. The closed toolbox (RFC 0009)

The runtime image ships no `npm`, `npx` or `corepack` and exactly one runtime
library (`docx`, exact-pinned, resolved through `NODE_PATH`). New powers
enter only as skills installed from the manifest-verified marketplace
surface. `verify.sh` asserts both properties (command-not-found +
no-network `require('docx')`) on every run.

### 6. Web client (`frontend/`)

- better-auth for accounts and sessions; the manager validates the same
  session cookie, so one identity model spans both planes.
- Password reset with no mail transport: the link goes to the server log;
  inline display (`RESET_PASSWORD_LINK_INLINE`) is for development only and
  discloses which addresses have an account.
- **Open item:** pre-launch review pass of the upload limits, session
  handling and the artifact proxy bounds.

### 7. Secrets handling

- `.env` and `secrets/` are gitignored; the manager mounts the host secrets
  dir read-only into each sandbox; `model.ts` reads keys with `readSecret()`
  and hands them to the provider through a `CredentialStore`. Keys are never
  logged and never part of the image (the image carries only the model id as
  `ENV`).
- `./dev.sh secrets` prints what lives where, so an operator can verify no
  secret reached the wrong layer.

## Supply chain

- `agent/package.json` pins direct dependencies to exact versions
  (`@earendil-works/*` 1.3.0 — experimental, pinned deliberately);
  `frontend` uses ranges with `pnpm-lock.yaml`; manager image pins
  `psycopg[binary]==3.2.10` and the Docker CLI `29.9.1` copied from the
  official image.
- The agent base image is `node:24-slim`; the agent image is built locally
  and referenced as `AGENT_IMAGE` — nothing pulls agent code from a registry.

## Open items (pre-launch review)

- [x] Sandbox network egress verified closed: with `AGENT_EGRESS=off` the
      per-user network is created `--internal` with masquerading disabled, and
      the manager installs an `iptables INPUT DROP` rule per sandbox bridge
      (fail-closed: provisioning aborts if the rule cannot be proven, and the
      reconcile tick re-asserts rules after daemon restarts). Neither docker
      knob alone covers the host: `--internal` stops forwarding but the
      bridge gateway is a host interface, so a `0.0.0.0`-bound host service
      used to answer on the gateway IP (caught by a controlled pentest,
      closed in the same change). `e2e-test/security.sh` asserts the
      containment on every run. Residual window: a docker daemon restart
      flushes iptables; the wall is back within one reconcile tick (60 s),
      and a stopped daemon cannot route sandbox traffic anyway unless
      live-restore is enabled.
- [ ] `create_args` input audit (manager → Docker CLI argument injection).
- [ ] Frontend auth surface review: better-auth flows, password reset,
      upload limits, artifact proxy.
- [ ] Rate limiting posture on Caddy for `/u/*` (currently none: acceptable
      for a trusted-operator deployment, must be stated in deployment docs).
