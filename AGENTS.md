# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Layout

- `agent/` — TypeScript agent container. Node 24 runs the `.ts` sources directly (type stripping), so there is no build output. Split by port: `harness.ts` (`HarnessLifecycle` + `DurableHarness`), `agent.ts` (`ContainerAgent`), `tools.ts` (`HttpTool`), `trace.ts` (`TraceSource` + `TraceReader`), `model.ts`, `http.ts`, `corpus.ts`.
- `sandbox-manager/` — Python 3.13 service (RFC 0003). Owns the sandbox registry, provisioning, resolve, and eviction. Drives the host daemon through `/var/run/docker.sock`.
- `frontend/` — SvelteKit 3 / Svelte 5 app. pnpm is the package manager (`pnpm-lock.yaml` is authoritative, not npm).
- `e2e-test/` — bash suites that exercise the stack through Caddy only.
- `docs/rfc/`, `docs/prd/` — design decisions before implementation.

## Durability Invariants

These are the product. Do not break them casually.

- The agent is stateful: SQLite at `SESSION_DB`, workspace at `WORKSPACE`, both on per-user volumes. Anything that must survive `docker stop` belongs in one of those, never in process memory.
- Open, resume, and pause are serialized on one promise chain inside `DurableHarness`. Do not open or close the Harness directly from a route or tool; go through `Harness.activate` / `#pause`.
- `GET /health` and `GET /status` must never open storage. A probe that activates the agent defeats idle pause, so the sandbox never idles out.
- `POST /prompt` is idempotent by `requestId`: the same id returns the admitted submission instead of running again. Do not add a code path that runs a second submission for the same id.
- `#syncAgent` rewrites the stored `pi.agent` when the provider/model changes, and the stored thinking level when `THINKING_LEVEL` changes. Changing a model must not require wiping a session.
- Workspace paths are confined to `WORKSPACE` through `NodeExecutionEnv` / `workspacePath`. New file endpoints must use the same environment, not raw `fs`.
- New HTTP routes are `HttpTool` subclasses in `tools.ts` registered in the server; do not add ad-hoc routing branches in `server.ts`. Declare explicitly whether a route activates the agent.
- Sandboxes are created by `sandbox_manager.py` (`create_args`), not by compose. Compose declares only `caddy`, `oltp`, `sandbox-manager`, and `e2e-test/run.sh` fails if an `agent*` service appears. Changing sandbox topology (networks, mounts, model secrets, workdir) is a manager change.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Check `node_modules` for external API types; don't guess.
- No inline imports (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- `agent/tsconfig.json` enables `erasableSyntaxOnly` and `verbatimModuleSyntax`: keep syntax erasable (no `enum`, `namespace`, parameter properties, `import =`).
- Inline single-line helpers that have only one call site.
- Depend on ports, not concrete classes: `ContainerAgent` takes an injected `HarnessLifecycle`, tools depend on `AgentApi`, traces on `TraceSource`. New behavior should be testable with a fake, no database.
- Do not weaken `strict` or `noUncheckedIndexedAccess` to silence an error.
- Never remove or downgrade functionality to fix a type error; upgrade the dependency instead.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.

## Commands

- Agent gate: `cd agent && npm run typecheck && npm test`. `npm test` runs `agent.test.ts` and `corpus.test.ts` under `node --test`. If you add a test file, add it to the `test` script.
- Frontend gate: `cd frontend && pnpm check` (svelte-check), plus `pnpm lint` (prettier + eslint). Unit tests: `pnpm test:unit -- --run`. Do not run the Playwright suite unless the change touches the UI and the user asked for it; it downloads browsers.
- Stack gate: `./verify.sh` — typecheck, unit tests, builds `affido-agent:latest`, starts the control plane, runs `e2e-test/run.sh` and `verify-sandbox.sh`. Use it when a change crosses the agent/manager/Caddy boundary.
- Local stack: `./dev.sh up [--provider fake|openrouter]`, `./dev.sh reload [--provider fake|openrouter]` (rebuild agent code, recreate sandboxes, keep Postgres and per-user volumes), `./dev.sh down`, `./dev.sh reset` (removes every container, volume and agent image of this project), `./dev.sh secrets` (which value lands where). `dev.sh` passes `AGENT_IMAGE` / `AGENT_SECRETS_DIR` to compose, so a provider switch also needs `reload` (sandbox env is fixed at `docker create`).
- Do not run the full `./verify.sh` for docs-only or single-file refactors; run the narrow gate.
- E2E traffic must go through Caddy at `localhost:18080` under `/u/<user_id>/...`. Do not dial an agent container by IP or `:8080` in tests: that bypasses `forward_auth`, session checks, and the `X-Sandbox-Endpoint` stripping assertion.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.
- If you create or modify a test file, run it and iterate until it passes.

## Dependencies and Images

- `agent/package.json` pins direct dependencies to exact versions (`1.3.0` for `@earendil-works/*`). The pi-durable API is experimental; an upgrade is an API review, not a bump. Read the changelog and re-check `HarnessLifecycle`, `inspect()`, storage, and usage before changing the pin.
- Treat `agent/package-lock.json` and `frontend/pnpm-lock.yaml` as reviewed code. Update them only with the corresponding install command.
- Inside `agent/`, use `npm ci --ignore-scripts` (or `npm install --ignore-scripts` when hydrating); do not run lifecycle scripts unless asked.
- Frontend dependencies use ranges; keep the style that is already there. Do not introduce a second package manager.
- Manager image pins matter: `psycopg[binary]==3.2.10` and the Docker CLI `29.9.1`. The CLI is copied from the official image, not installed; keep it pinned because the manager drives the host daemon with it.
- `affido-agent:latest` is built locally (`docker build -t affido-agent:latest ./agent`) and referenced by `AGENT_IMAGE`. Do not pull or retag a remote image in its place.

## Secrets and Local State

- Never commit `secrets/`, `.env`, or any API key. `.env.example` is the template; document new variables there in the same comment style.
- `MANAGER_TOKEN` is the only credential for the manager's HTTP API (it binds no host port). The `dev-manager-token` default exists for local compose only; do not use it in a deployment path.
- Sandbox agents run the keyless faux provider by default: no `*_MODEL`, no mounted secret. Wiring a real model into manager-created sandboxes is a `create_args` change, not a compose change.
- Postgres is published on `localhost:${OLTP_PORT:-15432}`. Do not hardcode 5432 anywhere except inside the compose service.
- Runtime artifacts (`bench/ips.txt`, `bench/spec-real.json`, `__pycache__/`) stay untracked.

## Frontend Conventions

- Routes live in `src/routes`; server-only code (auth, db, sandbox clients) in `src/lib/server`; UI in `src/lib/components` including `ui/` (shadcn-svelte). Imports go through `$lib` / `#lib`.
- Svelte 5 with runes. Use the existing bits-ui / shadcn-svelte components instead of hand-rolled widgets.
- Visual style is normative: `docs/rfc/0011-affido-brand-design-system.md`. Tokens ship in `frontend/src/routes/layout.css`, brand art in `frontend/static/brand/`. Do not inline hex colours, Tailwind default palette colours, or border radius in components; extend RFC 0011 first.
- Schema changes: edit the Drizzle schema, run `pnpm db:generate`, then `pnpm db:migrate`. Do not hand-edit a migration that is already committed; add a new one.
- The web app reaches sandboxes in two modes (Caddy gateway or trusted manager `/resolve`). Keep both working; a change to one must check the other.
- The chat route forwards `POST /prompt` and streams an AI SDK UI message stream. Do not change the prompt contract without updating the agent side and the e2e/frontend path together.

## Docs and Decisions

- New design work goes to `docs/rfc/000N-slug.md` (sequentially numbered) or `docs/prd/` for product scope. Update the existing document when a decision changes instead of leaving contradicting prose.
- The README makes concrete claims about behavior (idle pause, resume, `/inspect`, per-user provisioning). If a change alters one, update the README in the same change.
- `bench/README.md` maps each script to an RFC section. If you change a script's measurement, update the mapping and note the new run date; do not silently edit the RFC numbers to match a new machine.
- README and RFC prose are in English; `bench/README.md` and some RFC sections are Italian. Match the file you are editing.

## Git

Multiple sessions may run in this cwd and modify different files. Operations that touch staged, unstaged, or untracked files outside your own changes can stomp on other sessions' work.

- Only commit files you changed in this session.
- Stage explicit paths (`git add path1 path2`); never `git add -A` / `git add .`.
- Run `git status` before committing and verify only your files are staged.
- Message format: `{feat,fix,docs,test,chore}({agent,manager,frontend,e2e,bench,infra}): <concise message>`. Multiple scopes allowed: `feat(manager,agent): ...`.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git commit --no-verify`.
- Never force push.
- Do not commit `secrets/`, `.env`, lockfile churn you did not cause, or generated bench artifacts.
- If a rebase conflict lands in a file you did not modify, abort and ask the user.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
