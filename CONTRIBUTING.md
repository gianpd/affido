# Contributing to Affido

Affido is self-hosted AI agents you can entrust: sandboxed by default, powers
granted one skill at a time, every act traced and on the record. The trust
claim extends to the code: changes are gated by checks, not by promises.

## Getting started

```bash
git clone <your fork>
cd affido
cp .env.example .env          # set MANAGER_TOKEN (local default is fine)
./dev.sh up                   # fake provider, no API key needed
```

Requirements: Docker with the Compose plugin, Node 24, Python 3.13 (only
inside the manager image), `pnpm` for the frontend.

## The gate

Every change must pass `./verify.sh` before a PR is reviewable:

- agent typecheck (`tsc --noEmit`, `strict` + `noUncheckedIndexedAccess`)
- agent unit tests (`node --test`, on a fake `HarnessLifecycle` — no database)
- agent image build + closed-toolbox assertions (no `npm`/`npx`/`corepack` in
  the runtime image, `docx` resolves through `NODE_PATH` without network)
- marketplace manifest freshness
- e2e suites through Caddy only (`localhost:18080`, never direct agent dials):
  happy path, parallel cold provisions, strict citations, uploads
- sandbox lifecycle: L0 idle pause, L1 stop/restart with the same conversation

Frontend changes additionally run `pnpm check`, `pnpm lint` and
`pnpm test:unit -- --run` inside `frontend/`.

CI runs the same gate on every push and pull request.

## Layout

| Path | What lives there |
|------|------------------|
| `agent/` | The sandboxed TypeScript agent: durable harness, HTTP tools, citation gate, traces, skills, artifacts |
| `sandbox-manager/` | Python service owning the sandbox registry, provisioning, resolve and eviction |
| `frontend/` | SvelteKit web client (better-auth, documents, chat, traces) |
| `caddy/` | The only published endpoint; per-user routes under `/u/<user_id>/*` |
| `e2e-test/` | Bash suites driving the stack through Caddy |
| `marketplace/` | Curated skill catalog with manifest hashes |
| `docs/rfc/` | Design records: read them before changing what they describe |

## Rules that matter

- **Routes are `HttpTool` subclasses** in `agent/tools.ts`. No ad-hoc routing
  branches in `server.ts`. Declare whether a route activates the agent.
- **Workspace paths stay confined** to `WORKSPACE` through the shared
  execution environment. New file endpoints never use raw `fs`.
- **`/health` and `/status` never open storage** — a probe must not defeat the
  idle pause.
- **Agent containers are not compose services.** Sandbox topology changes are
  `sandbox_manager.py` (`create_args`) changes.
- **Durability is the product**: state that must survive `docker stop` belongs
  in `SESSION_DB` or `WORKSPACE`, never in process memory.
- New design work lands in `docs/rfc/` (sequentially numbered) before
  implementation.

## Pull requests

Small, single-purpose, with the relevant RFC or issue linked. 

## Reporting vulnerabilities

See [SECURITY.md](SECURITY.md) — do not open public issues for security
problems.
