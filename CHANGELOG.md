# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Sandboxes: gVisor is now mandatory, not a default. `AGENT_RUNTIME` is no
  longer an env knob (`sandbox_manager.py` pins `runsc` and
  `enforce_runsc_runtime()` fails closed at boot when the daemon cannot
  prove the runtime); `docker-compose.yml` and `.env.example` drop the
  variable, and `./verify.sh` fails its runtime probe instead of taking the
  interim `AGENT_RUNTIME=runc` CI fallback that this same unreleased cycle
  had introduced. Deploying on a host without gVisor now requires installing
  it (`runsc`) before the stack starts.

### Security

- Key delivery hop (2026-10 review, RFC 0013 §6.4 P0.3/P0.4): the manager
  POSTs the provider key to the sidecar as cleartext HTTP over the per-user
  bridge, and under runc a compromised agent — root, Docker default
  capabilities — can open `AF_PACKET` (`CAP_NET_RAW`), ARP-spoof the
  sidecar, capture `apiKey` mid-delivery, and impersonate the sidecar's
  200 (the fingerprint is derivable from the captured key). Two layers
  close it: `--cap-drop ALL` on agent and sidecar (nothing in either
  process needs a Linux capability: ports >1024, root-owned volumes
  matched by uid, Node-fetch healthcheck) and the mandatory runsc runtime
  above (netstack has no raw-socket/ARP surface, so the hop is unspoofable
  rather than guarded). `verify-sandbox.sh` asserts `CapDrop=[all]` on both
  halves and the e2e containment probe asserts `CapEff` is all zeroes from
  inside the sandbox.

### Fixed

- `./verify.sh` restore phase: the final `docker compose up -d` did not pin
  `AGENT_EGRESS=off`, so the BYOK phase's exported `AGENT_EGRESS=open` (or an
  operator `.env` carrying `open`) leaked into the "restored" stack: the
  gate ended with NAT egress still on, and any later standalone re-run of
  `e2e-test/security.sh` failed with `internet_reachable`. The restore now
  pins `AGENT_EGRESS=off` like the keyless phases already did.

- Security (pentest W1, 2026-10): the manager no longer runs on the
  well-known compose default `MANAGER_TOKEN` (`dev-manager-token`). With it,
  any unprivileged process on the host could reach the manager's bridge IP
  and pause, resolve as, or read the registry of any tenant. `./dev.sh
  up|reload` and `verify.sh` now generate a random `MANAGER_TOKEN` into
  `.env` when missing, and the manager fails closed at startup on the
  default or an empty token (`MANAGER_ALLOW_DEFAULT_TOKEN=1` is the explicit
  opt-in for throwaway stacks). Known from the secrets audit §8.2/§8.3,
  proven and closed by the controlled pentest.

### Added

- `CADDY_BIND` setting (default `127.0.0.1`): where the published `:18080`
  entry point binds. The previous `0.0.0.0` bind exposed the whole tenant
  surface to the LAN; deployments that need it set `CADDY_BIND=0.0.0.0`
  explicitly.
- `pdf-text-extraction` marketplace skill: the preinstalled `unpdf` explained
  to the agent — runtime paths (`NODE_PATH=/app/node_modules`, CJS `require`
  only, never override it), a bounded ready-to-run extractor
  (`references/extract-pdf.cjs`), and the observed failure modes (scanned
  PDFs, spaced-digit fiscal forms, column interleaving).

### Changed

- Security hardening of the sandbox boundary (RFC 0003 §11):
  - Postgres publishes on `127.0.0.1` only. It was bound to `0.0.0.0` with the
    static `pi/pi` credentials, so any peer that could reach the host could
    authenticate (SCRAM), read the better-auth `session` table and impersonate
    every tenant through Caddy with a forged cookie.
  - Per-user sandbox networks are created `--internal` without NAT egress,
    and the manager installs one `iptables INPUT DROP` rule per sandbox
    bridge (fail-closed, re-asserted on the reconcile tick). They were plain
    bridges, so agent code (bash tool) could exfiltrate the workspace to the
    internet and reach host services, including the published Postgres above
    — the same full tenant takeover from inside a sandbox. Neither `--internal`
    nor disabling masquerading alone closes the bridge-to-host INPUT path: the
    bridge gateway is a host interface, so a `0.0.0.0`-bound host service
    still answered on the gateway IP (found by a controlled self-pentest;
    `e2e-test/security.sh` now asserts host-listener unreachability from a
    sandbox). `AGENT_EGRESS=open` restores routed egress for internet-reached
    model providers (the INPUT wall stays on); `./dev.sh up --provider
    openrouter` sets it automatically. `./dev.sh reload` also removes the
    per-user networks (recreated on demand) so existing tenants pick up the
    new topology after a reload.
  - The manager API rejects any peer whose IP belongs to a per-user sandbox
    network unless it is the manager, Caddy or the web container. The
    `X-Manager-Token` wall stays, but agent containers now get 403 before any
    endpoint logic runs, so a weak or leaked token alone can no longer pause
    another tenant's sandbox or read `/metrics` from inside a sandbox.
- The uploads tree moved inside the corpus bucket: `WORKSPACE/uploads/` is now
  `WORKSPACE/corpus/uploads/`, and the citation index sees it — text files
  directly, PDFs through text extracted at upload time into `corpus/text/`
  (unpdf, server-side), other binaries staged but not indexed. `corpus_grep`
  and `corpus_read` answer over both ingestion modes, `/uploads/*` responses
  report `searchable`, and `/ingest` PDFs get the same extraction.

### Fixed

- `POST /ingest` answered only `{"searchable":true}`: `IngestRawTool` spread
  the `stageRaw` promise instead of awaiting it, so `bytes` and `sourceSha256`
  never reached the control plane. Document rows landed with `size=0`, no
  hash, and the `ingest_event` audit row violated its NOT NULL constraint
  (HTTP 500 after the row was written). Regression test added at the tool
  seam.

## [0.1.0] - 2026-10-23

First public release.

### Added

- One durable agent sandbox per user behind Caddy (RFC 0002, RFC 0003): a
  Python sandbox manager provisions networks, per-user volumes and containers
  on demand; agent containers are never compose services and publish no host
  ports.
- Durable conversations (RFC 0008): SQLite sessions on per-user volumes, idle
  pause, stop/restart with resume, idempotent `POST /prompt` by `requestId`,
  one conversation per topic (`/session/new`, `/session/switch`).
- Strict, server-verified citations (RFC 0006): with `citations: "required"`
  every published line carries a verified annotation (document, version, line
  range, exact quote, sha256); the envelope fields are server-built and every
  citation is re-verified against the stored text on each read.
- Traces: `GET /inspect` report (entries with decision fields, live tasks,
  submissions, usage) and `GET /entry` for one entry verbatim; the SvelteKit
  dashboard renders the decision graph.
- Skills marketplace (RFC 0009): manifest-hashed skill bundles installed
  file-by-file into a user's sandbox, `/skill_name` prompt hints, closed
  runtime toolbox (no `npm`/`npx`/`corepack` in the image).
- Directory uploads (PRD 0003): `/uploads` tree with client-dictated paths,
  validated and confined under `WORKSPACE/uploads`.
- Artifacts: bounded downloads (25 MiB cap, attachments only, symlinks never
  served), reported in the `/prompt` envelope.
- Web client: SvelteKit app with better-auth accounts, documents, corpus,
  chat (AI SDK stream) and traces.
- Tooling: `dev.sh` (up/reload/down/reset/secrets, provider switch),
  `verify.sh` full gate, e2e suites through Caddy only, sandbox lifecycle
  checks (L0 pause, L1 stop/restart).
