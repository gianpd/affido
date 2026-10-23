# Security Policy

## Supported state

Affido is pre-1.0 (`v0.x`). Security fixes land on `main`; there are no
backport branches yet.

## Reporting a vulnerability

Email **security@getaffido.com** (or use GitHub's private vulnerability
reporting once it is enabled on the repo). Include reproduction steps and the
affected component (`agent`, `sandbox-manager`, `frontend`, `caddy`). You will
get an acknowledgement within 7 days. Please do not open public issues for
security problems.

We credit reporters in the CHANGELOG entry for the fix, unless you prefer to
stay anonymous.

## Scope and threat model summary

The full threat model lives in [docs/security.md](docs/security.md). In short,
the scary surfaces are:

- **The Docker socket surface of `sandbox-manager`** — the manager drives the
  host daemon; its HTTP API must only be reachable by Caddy and the web app
  inside the compose network (`MANAGER_TOKEN` gates every endpoint but
  `/healthz`; the manager binds no host port).
- **Per-user confinement** — agent containers publish no host ports, live on
  per-user networks, and workspace paths are confined to `WORKSPACE`.
- **Client-supplied routing headers** — `X-Sandbox-Endpoint` is stripped by
  Caddy before the dial; a client can never choose its upstream.
- **Upload paths** — `/uploads`, `/skills` and `/artifacts` validate every
  path (relative, no `..`, bounded depth) and refuse escapes from their roots.
- **Secrets** — model API keys live in a host `secrets/` dir mounted
  read-only into sandboxes; they are never committed and never logged.

Out of scope: attacks against the host Docker daemon itself (run the control
plane on a machine you trust; the manager is not a multi-tenant isolation
boundary), and compromise of the model provider.
