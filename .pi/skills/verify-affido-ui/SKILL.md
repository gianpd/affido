---
name: verify-affido-ui
description: "Drive the real affido frontend UI like a user and prove behavior with screenshots. Use when asked to verify, check, or audit the web app (login, dashboard, chat, documents, skills marketplace, traces, uploads), when a frontend change needs visual/behavioral proof, or to diagnose 'is the UI actually working'. Logs in through the real better-auth flow, talks to the real Caddy/manager/sandbox stack, and leaves PNG screenshots plus facts.json under verify-runs/ for the agent to read."
disable-model-invocation: false
---

# verify-affido-ui

Drive the affido SvelteKit app (`frontend/`) exactly as a user does — real signup/login, real chat through Caddy → sandbox-manager → per-user sandbox agent — and capture screenshots the agent reads as evidence. Nothing is mocked: the browser hits `http://localhost:5173` (vite dev server), which talks to the compose control plane (Caddy `:18080`, Postgres `:15432`, sandbox-manager).

You can read images: after driving, open every screenshot with the `read` tool and study it. A screenshot you did not read is not evidence.

## Launch

The control plane runs in compose; the frontend runs as a vite dev server (port is pinned by `ORIGIN=http://localhost:5173` in `frontend/.env`, so use 5173, not preview).

If `:5173` already answers (`curl -fsS http://localhost:5173/login`), another session left a dev server up: reuse it and do not start a second one — and never kill one you did not start (`cleanup.sh` only kills the PID it recorded in `/tmp/affido-ui-dev.pid`).

```bash
cd /home/jaco/develops/RESEARCH/affido

# 1. Control plane (skip if ./dev.sh status already shows caddy/oltp/sandbox-manager Up)
./dev.sh up                 # default provider is the keyless faux agent

# 2. Frontend dev server (one per repo; port 5173 is fixed by ORIGIN)
cd frontend && nohup pnpm dev >/tmp/affido-ui-dev.log 2>&1 & echo $! >/tmp/affido-ui-dev.pid
cd ..

# 3. Wait for ready (vite answers /login once compiled)
for i in $(seq 1 60); do curl -fsS http://localhost:5173/login >/dev/null && break; sleep 1; done
```

Ready = the curl loop exits fast. If it never answers, read `/tmp/affido-ui-dev.log`.

Teardown of the dev server: `kill "$(cat /tmp/affido-ui-dev.pid)"` (also done by `cleanup.sh`).

## Doctor

Run first whenever anything looks off. Read-only.

```bash
curl -fsS http://localhost:18080/            # expect: affido agents: per-user sandboxes at /u/<user_id>/...
docker compose -p affido ps                  # caddy, oltp (healthy), sandbox-manager must be Up
docker exec oltp pg_isready -U pi -d pi      # expect: accepting connections
curl -fsS http://localhost:5173/login >/dev/null && echo UI-UP
node .pi/skills/verify-affido-ui/drive.mjs --help   # playwright resolves from frontend/node_modules
```

If `:5173` is down, do the Launch step 2. If compose is down, `./dev.sh up` (this provisions nothing destructive; Postgres volume persists). Note which agent image the manager runs (`./dev.sh status`): `affido-agent:latest` = faux provider (free), `affido-agent:openrouter` = real model calls (keep prompts to one per run).

## Drive

The driver is `drive.mjs` (Playwright chromium, headless, 1440×900). All runs write to one run dir:

```bash
RUN="verify-runs/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RUN"
```

A fresh user is created through the real signup form; its session cookie (`state.json`) and credentials are reused by later scenarios:

```bash
D=.pi/skills/verify-affido-ui/drive.mjs

node $D signup   --out "$RUN" --name "UI Verifier"                       # also writes state.json + credentials.json
node $D chat     --out "$RUN" --state "$RUN/state.json" --prompt "Reply with exactly: READY"
node $D documents --out "$RUN" --state "$RUN/state.json"
node $D skills   --out "$RUN" --state "$RUN/state.json"
node $D traces   --out "$RUN" --state "$RUN/state.json"
node $D uploads  --out "$RUN" --state "$RUN/state.json"
node $D logout   --out "$RUN" --state "$RUN/state.json"
```

(You can also pass `--email`/`--password` to `login` instead of `signup`.) Each scenario exits non-zero on failure and prints `FAIL <step>: <reason>`. Scenario details, selectors, and gotchas are in `features/` — read the matching file before driving a feature. Slow steps: `chat` (first prompt per user provisions a sandbox container; budget ~3 min) and `skills` install — the marketplace card's files land in the sandbox within seconds, but the install POST has been measured to take 15-20+ minutes to return on a cold sandbox; the driver polls the badge for 20 min (`--install-budget-ms` to change) and its timeout message names the diagnosis path. Drive `skills` after `chat` (warm sandbox) when you need a faster pass. `skills` timing is a known finding, not driver flakiness.

## Evidence

Each scenario leaves in `$RUN`: numbered full-page PNGs (`NN-step.png`) with text twins (`NN-step.txt`, the page's visible text), `facts-<scenario>.json` (final URL, step timings, HTTP errors ≥400 on `/api/*` and page loads, console errors, failed requests), `state.json`, `credentials.json`.

Proof standard:

1. Exercise the real user path only — the forms and buttons on the page, never direct API calls or DB writes. The driver enforces this; do not work around it.
2. Read every PNG with the `read` tool and check it shows what the step claims (e.g. dashboard sidebar with badge counts, an assistant reply bubble under the user prompt, the `Installed` badge on the skill card, a trace row whose prompt matches). Each PNG has a text twin (`NN-step.txt`, the page's visible text): read that too — it is searchable proof when image reading is unavailable, and it pins what the screenshot should contain. Describe what you actually see; if a screenshot contradicts facts.json, believe the screenshot and investigate.
3. Check every `facts-<scenario>.json`: `httpErrors`, `consoleErrors`, `networkFailures` must be empty (or each entry explained), `steps` must contain no `error`.
4. Side effects are part of the proof: chat must leave a trace row (`traces` scenario asserts ≥1), signup must create a real session (the chat path would 401 otherwise — the manager validates the better-auth cookie against Postgres).

Evidence survives cleanup. Never delete `verify-runs/` as part of a run; report the run dir path to the user.

## Cleanup

```bash
.pi/skills/verify-affido-ui/cleanup.sh                 # all verify-runs/*/credentials.json users
.pi/skills/verify-affido-ui/cleanup.sh "$RUN"          # just one run dir
```

Removes, per verify user: the sandbox container + `pi-ws-*`/`pi-data-*` volumes + `pi-net-*` network (via the `sandbox_registry` row, else by recomputing the manager slug), all DB rows for that user (`session`, `account`, `document`, `ingest_event`, `corpus`, `chat_message`, `trace_session`, `sandbox_registry`, `verification`, `user`), and the dev server from `/tmp/affido-ui-dev.pid` if it is still running. It never touches `verify-runs/`. Run it after every run — including failed ones — so scratch users and volumes do not pile up (the manager already has hundreds of `pi-*` volumes; do not add orphans).

## Helpers

- `node .pi/skills/verify-affido-ui/drive.mjs <scenario> [flags]` — scenarios `signup login chat documents skills traces uploads logout`; flags `--out DIR --state FILE --email E --password P --name N --prompt TXT --base URL` (default base `http://localhost:5173`). Must be run from the repo root or `frontend/` (playwright resolves from `frontend/node_modules`; or set `AFFIDO_FRONTEND=<repo>/frontend`).
- `.pi/skills/verify-affido-ui/cleanup.sh [runDir…]` — teardown above; executable.
- `features/README.md` — the feature map; one file per feature with selectors and gotchas.
