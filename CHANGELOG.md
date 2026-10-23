# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-10-23

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
