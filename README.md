# Affido

[![CI](https://github.com/gianpd/affido/actions/workflows/ci.yml/badge.svg)](https://github.com/gianpd/affido/actions/workflows/ci.yml)

**Self-hosted AI agents you can entrust: sandboxed by default, powers granted
one skill at a time, every act traced and on the record.**

*Affido* is Italian for "I entrust" — the root of *affidabile* (reliable),
*affidare* (to entrust) and *affidamento* (the bounded legal delegation).
That is the whole product in one root: an agent you can hold to account.

It exists because pi's own docs are explicit: *"Pi does not include a built-in
permission system… If you need stronger boundaries, containerize or sandbox
Pi"* — and its containerization doc lists four do-it-yourself patterns: plain
Docker, Docker Sandboxes, OpenShell, Gondolin. Affido is that boundary
productized and per-user, built on [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi).

Each user gets one sandboxed agent:

- **Bounded.** The agent lives in a container the control plane created on
  demand: no host ports, its own private network with no route off its subnet,
  and its workspace confined to a per-user volume.
- **Granted.** The agent starts powerless. Capabilities arrive as skills the
  deployer installs, one manifest-verified file at a time — and the runtime
  image ships no installer, so new powers cannot appear from inside.
- **Durable.** Conversations are SQLite on per-user volumes, not process
  memory: pause, stop, restart, eviction — the session resumes, runs
  included.
- **On the record.** Every question leaves a full trace (steps, tool calls,
  failures, cost), and with `citations: "required"` an answer is published
  only through a deterministic gate that re-verifies every quote against the
  stored documents: document, version, line range, exact span, sha256.

> **Honesty box.** The gate guarantees *attribution, not truth*: every cited
> span provably exists in your documents and was located by the agent
> container. Whether the conclusion drawn from it is right stays a human
> judgment — the model proposes, the code verifies, you decide. When the check
> fails, the quote never becomes a citation: the reply is shown as prose with
> an explicit *no document evidence* label, and the trace keeps the refusal.
> Affido is built on an experimental upstream library, pinned exactly, with
> restart-survival proven in the e2e gate on every run.

![The citation gate refusing a tampered quote, then publishing the reply whose
quote verifies](docs/assets/gate-rejection.gif)

*30 s, recorded on the deterministic faux provider the quickstart runs (no API
key): the model claims fees are payable **annually**; `corpus_annotate` refuses
the span (`quote_mismatch`), the publish is refused (`unknown_citation`), and
the reply is labelled *no document evidence* — then the same model quotes the
stored line exactly and publishes with its citation, `line 8 ·
attribution_verified`. Higher quality: [MP4, 30 s](docs/assets/gate-rejection.mp4);
provenance in [`docs/assets/README.md`](docs/assets/README.md).*

*Why a verified quote can still be attached to the wrong sentence, and what
the coherence check adds: [2:43 explainer](docs/assets/judge-eval.mp4) (Italian,
captions).*

*The market sells grounding and judgment; affido sells the deterministic gate between them — the quote either is a byte span of a stored document version or it never becomes a citation, and the audit is a hash recompute, not another model.*

## Quickstart (5 minutes)

```bash
cp .env.example .env        # no MANAGER_TOKEN yet: dev.sh generates one
./dev.sh up                 # fake provider: no API key, deterministic demo
```

The stack: Caddy on `localhost:18080` and Postgres on `localhost:15432`
(both loopback-bound by default), plus the sandbox manager, which publishes
no host port. Then prove a cold per-user provision end to end:

```bash
docker compose exec -T oltp psql -U pi -d pi <<'SQL'
CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY, "userId" text NOT NULL,
  "token" text NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL
);
INSERT INTO "session" VALUES ('sess-dev','dev-user','dev-token',now()+interval '1 day')
  ON CONFLICT ("id") DO NOTHING;
SQL

curl -H 'Cookie: better-auth.session_token=dev-token' \
     localhost:18080/u/dev-user/status
```

The first request cold-provisions that user's sandbox through Caddy. To use a
real model, each user brings their own key: [BYOK](#byok-bring-your-own-key).
To check everything, including idle pause and a hard-stop resume: `./verify.sh`.

## Layout

```
agent/             the sandboxed TypeScript agent (durable harness, tools,
                   citation gate, traces, skills, artifacts), plus the two
                   other entrypoints of the same image: the key-injection
                   sidecar and the web-search node
sandbox-manager/   Python service: sandbox registry, group provisioning,
                   eviction, BYOK key custody and delivery, web-search topology
frontend/          SvelteKit web client (better-auth, documents, chat, traces)
caddy/             the only published endpoint, per-user /u/<id>/* routes
e2e-test/          bash suites driving the stack through Caddy only
marketplace/       curated skill catalog with manifest hashes
docs/              design notes, threat model, recorded demos
```

## Run

`dev.sh` wraps compose and builds the agent image. Sandbox agents are created on
demand by the manager from `affido-agent:latest`; the keyless faux provider is
the default, and real models are a per-user choice (BYOK), not a stack flag.

```bash
./dev.sh up                              # faux default, no secrets
./dev.sh up --no-build                   # reuse the built images
./dev.sh reload                          # rebuild agent code, recreate sandboxes, keep data
./dev.sh build                           # image only, no compose up
./dev.sh status                          # control plane, sandboxes, volumes
./dev.sh down                            # stop the control plane, keep sandbox state
./dev.sh reset                           # remove containers, volumes, images; start from zero
./dev.sh secrets                         # where each value lives
```

`reload` is the edit-test loop: it rebuilds `affido-agent:latest`, brings the
control plane up, then removes the sandbox containers so the next request
re-provisions them from the new image. The Postgres volume, `pi-ws-<user>` and
`pi-data-<user>` are untouched, so documents, workspaces and sessions survive.
`reset` is the only command that deletes data.

`./dev.sh secrets` prints where each value lives: `.env` (compose, control
plane), `secrets/llm_key_kek` (the BYOK key-encryption key, mounted into the
manager only), and what never touches the host at all (the users' provider
keys).

The e2e suite runs against the running stack:

```bash
# Seeds better-auth-shaped sessions, then cold-provisions agents through Caddy.
./e2e-test/run.sh
```

## Web client

`frontend/` is a SvelteKit 3 / Svelte 5 app with better-auth accounts,
shadcn-svelte components and the AI SDK chat. It shares the `pi` database
with the manager.
Postgres is published on `localhost:15432` (`OLTP_PORT` overrides).

```bash
cd frontend
cp .env.example .env      # set BETTER_AUTH_SECRET
pnpm install
pnpm db:migrate
pnpm dev                  # http://localhost:5173
```

Routes: `/dashboard` (overview), `/dashboard/documents`, `/dashboard/corpus`,
`/dashboard/chat`, `/dashboard/skills`, `/dashboard/traces` (every captured
snapshot), `/dashboard/traces/[id]` (decision graph, entries, tasks,
submissions) and `/dashboard/settings` (AI provider: catalog, key entry,
verification, fingerprints). The chat bridge at `/api/chat` forwards the prompt
to the user's sandbox and streams the answer as an AI SDK UI message stream;
each prompt also captures a trace snapshot. See `frontend/README.md` for the two
sandbox access modes (Caddy gateway for host development, trusted manager
`/resolve` for containers).

## Per-user sandboxes

`oltp` (Postgres with the sandbox registry), `sandbox-manager` (Python, Docker
socket) and a Caddy route per user. On every request Caddy's `forward_auth`
subrequest asks the manager to resolve the user; the manager provisions
(network, volumes, container) or starts the sandbox and returns
`X-Sandbox-Endpoint`, which Caddy then dials. The manager stops an idle sandbox
after `STOP_AFTER_S` and starts it again on the next request; the agent resumes
the same SQLite session. Sandboxes run under gVisor (`runsc`, mandatory — the
manager refuses to boot without it).

The e2e verifier does not log in through the web client; it seeds a
better-auth-shaped `"session"` row. The manager looks up the token part of a
signed better-auth cookie, so the same table serves both the seeded tests and
real accounts (see the [quickstart](#quickstart-5-minutes) for the snippet).

Settings (`.env`):

- `MANAGER_TOKEN` — required by every manager endpoint except `/healthz`;
  generated into `.env` by `./dev.sh up` and `verify.sh` when missing, and the
  manager refuses to start on the well-known compose default or an empty token.
- `STOP_AFTER_S` (600), `EVICT_TICK_S`, `AGENT_IDLE_MS` (5000) — the idle
  ladder: pause the harness, then stop the container.
- `AGENT_EGRESS` (`off`) — sandbox networks are created `--internal` with no
  route to the internet or other subnets. `open` is the opt-in for
  internet-reached providers, and a prerequisite for BYOK with one; the
  requirement is enforced when a provider is configured, never a silent
  fallback to faux.
- `AGENT_DNS` (`1.1.1.1`) — the sandbox resolver; the only path to internet
  names, and unroutable while egress is `off`.
- `OLTP_PORT` (15432, loopback only), `CADDY_BIND` (`127.0.0.1`; set `0.0.0.0`
  to expose the stack on the LAN), `WEB_CONTAINER` (optional: attach the web
  app container to each per-user network).

## How it works

**The agent.** TypeScript, split by concern and wired through ports: a
`HarnessLifecycle` port with a pi-durable implementation, a `ContainerAgent`
that owns one container's model, registry, workspace and conversation, and
`HttpTool` for one HTTP operation each. Tools depend on an interface, not on
the concrete agent, so the whole agent runs in tests with a fake and no
database. Node 24 loads the `.ts` sources directly: the image ships no build
output.

**Sessions.** SQLite on a per-user volume. Open, resume and pause are
serialized on one promise chain, the root conversation is reopened on every
activation, and an interrupted run is resumed on restart. A repeated
`requestId` returns the already-admitted submission instead of running again.
"New session" switches a durable pointer to a separate conversation; History
repoints it back (`POST /session/switch`), so an old session resumes with its
full model context.
Nothing is deleted; `/reset` starts a new context inside the current
conversation.

**Idle pause.** Every activating request resets a timer. When it fires with no
request in flight, the harness is closed and its SQLite file checkpointed.
`/health` and `/status` never open storage, so a health probe cannot defeat the
pause — they report cached state instead. Workspace-only routes (uploads,
skills, artifacts) never activate the agent either.

**Traces.** `/inspect` returns the newest entries with a collapsed summary and
structured decision fields (role, tools, stop reason, model, errors, timings),
live tasks and submissions, and folded usage. `/entry` reads one entry
unprojected: stored messages, tool results, thinking blocks, tool-call
arguments. The dashboard decision graph and trace page are built from these.

## HTTP API

Inside the sandbox, behind Caddy at `/u/<user_id>/...`:

| Method | Path | Activates | Purpose |
|---|---|---|---|
| GET | `/health`, `/status` | no | liveness; current state, model and key location |
| GET | `/session`, `/inspect`, `/entry` | yes | conversation state, trace report, one entry unprojected |
| GET | `/files`, `/file` | yes | read the workspace (confined to it) |
| POST/GET/DELETE | `/ingest`, `/raw`, `/text` | mixed | stage a document; read back its bytes and derived PDF text |
| POST/GET/DELETE | `/uploads`, `/uploads/dir`, `/uploads/file` | no | a user-shared tree under `corpus/uploads/` |
| GET/POST/DELETE | `/skills`, `/skills/file`, `/skills/verify` | no | install a skill bundle file-by-file, verify it, remove it |
| GET/DELETE | `/artifacts`, `/artifact` | no | the download surface |
| POST | `/prompt` | yes | ask; returns the answer, evidence, citations and artifacts |
| POST | `/config`, `/webconfig` | yes / no | runtime delivery from the manager: model and key mode, web-search token |
| POST | `/session/new`, `/session/switch`, `/reset`, `/pause` | yes / no | new conversation, resume a past one, fresh context, deterministic pause |

Both ingestion paths (documents and user uploads) go through one pipeline:
admission to the citation index is decided once, at ingest, and recorded in a
registry sidecar. Text files enter when their bytes are strict UTF-8, PDFs
through text extracted at upload time, other binaries never. The citation
store reads only that registry, so a document whose staged bytes or admitted
text no longer hash to the recorded values stops being evidence until it is
re-ingested. The sandbox validates each uploaded path (relative, no `..`,
bounded depth) and prefixes `corpus/uploads/` itself, so a crafted request
cannot write outside the workspace.

## Skills and artifacts

Two workspace roots, both plain filesystem work that never activates the agent:

- **`skills/`** — marketplace installs. The platform curates a catalog in the
  repo (`marketplace/`, manifest-hashed); the dashboard installs it file-by-file
  into the user's sandbox and verifies against the manifest. Installs survive
  pause, stop, eviction and reprovision; only `dev.sh reset` removes them. A
  prompt starting `/skill_name` gets a server-built hint — resolved: "read that
  SKILL.md first"; unknown: an honest not-installed note naming what is
  installed. A user-shared `uploads/<name>/SKILL.md` tree is invocable the same
  way.
- **`artifacts/`** — the download surface. Deliverables the model writes there
  are reported by the `/prompt` envelope (bytes, sha256, mtime, re-derived on
  replay), listed by `GET /artifacts`, and downloadable through the chat buttons
  or the uploads panel. Downloads are always attachments with a static content
  type, capped at 25 MiB, and a symlink anywhere under `artifacts/` is neither
  listed nor served.

The image ships capability, not knowledge: a closed set of runtime libraries
(`docx` for document generation, `unpdf` for PDF text extraction, both
exact-pinned) and **no installer** — `npm`, `npx` and `corepack` are deleted
from the runtime image, so extending the toolbox at runtime fails with
`command not found`. `verify.sh` asserts both properties, and the container
prompt tells the model what exists so an uploaded PDF is read rather than
guessed at. `md-to-docx` is the first catalog skill; the e2e builds a real
`.docx` from it without an API key.

## Strict citations

A `/prompt` request with `citations: "required"` turns that one submission into
a strict run. The model gets `corpus_grep`, `corpus_read`, `corpus_annotate`,
`answer_publish` and `answer_plain`. An answer that carries document evidence
exists only through the gate: every non-heading line must carry a citation
token, the declared ids must be exactly the tokens used, and every id must be a
verified annotation of this run. A quote that is not an exact span of the
stored document produces no citation at all, so further `answer_publish`
attempts are refused and the model's remaining exit is `answer_plain`, whose
reply carries the explicit *no document evidence* label. The envelope reports
`evidence: "cited" | "plain" | "none"` plus the citations; those fields are
server-built, never typed by the model. While the run is strict, workspace
tools are refused outright: the only readable evidence is the citation index,
so a fact the index cannot verify cannot even be read.

A post-gate coherence check then judges each cited line against the quote
behind its id with a hosted decision model that answers one typed choice
(supported / unrelated / contradicted) and generates no text. On the shipped
fixtures it scores 100% accuracy with 0% false accepts, so an incoherent line
rejects the publish and the model retries; the trace keeps one record per
publish attempt — verdicts, latencies, truncations, named failure causes
(timeout, http_5xx, …) and the label distribution — and the traces page shows
the attempt that published with its failed siblings (RFC 0020). The judge
rides the run's own OpenRouter credential and is simply absent when none backs
the run, so the keyless stack behaves exactly like the pure gate. The chat UI
carries the per-question toggle; `/inspect?report=citations` measures exactness
from the trace alone. `AGENT_CITATIONS_DEFAULT=required` (followed by
`./dev.sh reload`) flips the default for requests that omit the field.

## Web search

Model calls stay in the sandbox; the open web does not. Each sandbox gets a
third container on the same per-user network. It owns no writable volume, runs
no user code and has no route to the internet: it talks to operator-supplied
SearXNG (search) and Camofox (page reads) on a shared internal network, and
those two services are the only containers with egress.

| Tool | Model-visible result | Bounds |
|---|---|---|
| `web_search {query, lang?, max?}` | `[{sourceId, title, domain, snippet}]` | query <= 256 chars, 4 searches per run, 8 results |
| `web_read {sourceId}` | `{untrusted: true, url, title, text, sha256, truncated, totalChars}` | opaque ids issued to this run, one read per result, 6000-character selected window |

The node replies with validated envelopes containing `requestId` and `diagnostics`; the model sees only the compact results/page above. Both tools also expose the envelope as `structuredOutput` for program callers, declared with a shared `structuredOutputSchema`. `web_read` keeps at most 6000 characters but selects them from the page head plus a window around server-side focus terms from the query and snippet; `truncated` and `totalChars` state what was omitted. Search results still contain no URL.

Web is **off by default**. The user enables it per message with the Web toggle
next to Strict citations; the chat route sends `web: "allowed"` on `/prompt`
and the sandbox registers that grant for the run. Without it both tools answer
`web_not_authorized` and never touch the node. The grant is not a model choice:
it is written by the trusted admission path, one run at a time, and bound to a
per-run token the node issues back.

The model never names a URL: `web_read` has no URL argument, and the node
resolves the id from the run's own table (`no_url_in_arguments`,
`unknown_source`, `already_read`, `budget_exhausted` are the named refusals).
Result URLs whose host is a private, loopback or link-local literal are dropped
before the model sees them, so a poisoned result cannot point the browser at
the host's bridge or the cloud metadata endpoint. The first successful read
marks the conversation tainted in a durable document that is never cleared —
the block survives pause, restart and compaction — and the HTTP persistence
paths then answer `409 web_tainted`, so a fetched page cannot be laundered into
the searchable corpus or into a skill that outlives the run. A new
conversation starts clean.

The node is created by the manager, never by compose. Without the search
services attached it answers `search_unavailable` and the rest of the sandbox
is unaffected. `.env` names the topology and the services (`WEBSEARCH_IN`,
`WEBSEARCH_OUT`, `SEARXNG_URL`, `CAMOFOX_URL`, `CAMOFOX_API_KEY`,
`WEBSEARCH_MEMORY`, `WEBSEARCH_CPUS`); the API key is a shared operator secret
passed to the node only — it never enters a sandbox and no tool echoes it.

## Architecture

```
              host :18080
                  |
             +---------+
             |  caddy  |   only published port
             +----+----+
                  |  forward_auth /resolve -> X-Sandbox-Endpoint
                  v
          +---------------+        docker create/start/stop
          | sandbox-      |-----------------------------+
          | manager       |                             |   one group per user:
          +-------+-------+                             v   u<slug>:8080            u<slug>-sidecar:8081
             |   POST /config {provider, modelId,       |   agent — no key          key-injection sidecar
          +---------+   viaSidecar: true}               |        ^                          |
          |  oltp   |  key ciphertext (AES-GCM)         +--------+---- pi-net-<slug> ------+
          |registry |  ---------------------------------------------|         pinned upstream (TLS)
          +---------+                                                v
                                                           provider (api.deepseek.com, ...)

   u<slug>-websearch:8082  — no volumes, no egress
        |                 |
        +-- websearch-in -+-- SearXNG + Camofox -- websearch-out --> internet
              (internal)                                    (bridge)
```

The control plane declares no agent `ports`. Caddy publishes
`${CADDY_BIND:-127.0.0.1}:18080:80` and Postgres publishes
`127.0.0.1:${OLTP_PORT:-15432}:5432` for the web client's Drizzle connection;
`CADDY_BIND=0.0.0.0` is the explicit opt-in for LAN access. Caddy dials each
agent by container name on the per-user network the manager created; the agent containers, their key sidecars and the web-search
nodes are not compose services, so `docker compose ps` lists only caddy, oltp
and sandbox-manager. Each per-user network hosts exactly one group, and
cross-tenant reachability is blocked and proven by `e2e-test/security.sh`.

## Use a real model

Sandbox agents are created by the manager, which forwards no model variable: the
faux provider is the default and is scripted by transcript state — a tool call
and an answer built from the listing, or a citation dance when the question
mentions renewal — so the strict path can be exercised with no API key. The
recording at the top of this file is one more transcript
(`agent/citation-gate-demo.ts`): two questions, a tampered quote and an exact
one.

### BYOK (bring your own key)

An authenticated user picks a provider from a curated catalog (or registers a
custom OpenAI-compatible endpoint) and submits their own API key. The key is
stored AES-256-GCM-encrypted in Postgres, the key-encryption key lives in
`secrets/llm_key_kek` (mounted into the manager only), and the key is
re-delivered after any restart — never written to a container environment, the
image, a filesystem, a URL or a log. Switching provider or rotating a key never
wipes a session.

**The key never enters the agent process.** Each sandbox is a *pair*: the agent
plus a key-injection sidecar (same image, second entrypoint, no volumes, same
private network). At resolve time the manager delivers the key to the sidecar —
the only process that ever holds the plaintext — and a keyless model selection
to the agent. The agent registers its models against the sidecar with a
placeholder credential; the sidecar strips inbound auth headers, stamps the
real one and forwards to an upstream pinned at delivery time (any other host,
redirect or provider prefix is refused). An attacker who fully controls the
agent process can *spend* the key — inherent, the agent must call the provider
— but cannot *disclose* it: there is no plaintext in the agent container, and
`/status` reports where the key lives instead of a fingerprint. The pair shares
one lifecycle: eviction, recreation and health cover both, and a resolve never
routes an agent to a dead sidecar.

```bash
# once, in .env: real providers are reached over the internet
#   AGENT_EGRESS=open
./dev.sh up                 # dev.sh creates secrets/llm_key_kek when missing
```

From the web app: Settings -> AI provider (catalog, key entry, verification,
fingerprints). From scripts, through Caddy only:

```bash
curl -X PUT -H 'Cookie: better-auth.session_token=<token>' \
     -H 'Origin: http://localhost:18080' -H 'content-type: application/json' \
     -d '{"provider":"deepseek","modelId":"deepseek-flash","apiKey":"sk-..."}' \
     localhost:18080/providers/config
```

The manager answers with the masked view (selection plus key fingerprints, and
never the key). The next request resolves, delivers both halves, and the prompt
is answered by the provider through the sidecar. A user's key exists in
plaintext only in their own sidecar's RAM; an idle-stopped pair holds no key
material at all.

Production prerequisite: terminate TLS at Caddy (automatic HTTPS on a public
site address, or `tls internal` for private deployments) before opening the
BYOK endpoints to users — the shipped Caddyfile serves plain HTTP on loopback,
which is a dev-stack exception.

### Standalone (no manager)

Running the agent image directly keeps the secret-file branch of
`agent/model.ts`: mount `secrets/` at `/run/secrets` and set the model id.

```bash
# .env: OPENROUTER_MODEL=<model id>; secrets/openrouter_api_key: the key
docker run -e OPENROUTER_MODEL=<model id> \
     -v "$PWD/secrets:/run/secrets:ro" affido-agent:latest
```

Selection follows `openrouter_api_key` -> `openai_api_key` -> faux. This path
has no per-user isolation: one key, one container, no manager. The manager
stack never uses it.

## Verify

`./verify.sh` is the stack gate. It type-checks and unit-tests the agent and
the manager's BYOK code, builds `affido-agent:latest`, starts the control plane,
and then runs the e2e suites through Caddy only — the per-feature suites below,
plus web search against an e2e-only fake SearXNG/Camofox (authorisation
refusals, forged tokens, taint durability across a restart), the sandbox
durability checks, the containment negatives, and the full BYOK chain against a
fake upstream (delivery split, pinned-upstream refusal, RAM-only key custody in
both containers, rotation, durability, pair recreation) before restoring the
keyless default. It exits non-zero on the first failure, and it fails fast on a
host without the sandbox runtime.

`./e2e-test/run.sh` asserts that compose declares only the control plane and
that no agent, sidecar or web-search service leaked into it, then drives the
running stack: cold provisioning and identity checks (`happy-path.sh`),
three users provisioned in parallel (`parallel.sh`), the citation gate with
replay and re-verification after a restart (`citations.sh`), uploads
(`uploads.sh`), skills and artifacts (`skills.sh`, `artifacts.sh`) and the
provider API (`providers.sh`). `./verify-sandbox.sh` then proves the idle
pause, the manager's stop and restart with the same conversation and entries,
and that a client-supplied `X-Sandbox-Endpoint` is stripped.

```
ALL CHECKS PASSED
```

## Notes

- `/status` reports `entries: 0` and `conversationId: null` while paused because
  it deliberately does not open storage. Call `/session` to resume and read the
  live values.
- The agent-side idle timer (`AGENT_IDLE_MS`, default 5000 ms) pauses the
  harness. `docker restart <sandbox>` demonstrates resume from a hard stop; the
  same happens on `SIGTERM`, which closes the harness cleanly.
- Pausing closes the harness and its SQLite file but keeps the process up. When
  the user stays away for `STOP_AFTER_S`, the manager stops the container; the
  next request through `/u/<id>/...` starts it again, so the proxy never needs a
  live upstream ahead of time.
- The workspace seeds `README.md`, `notes.txt` and `data.txt` on first start.

## License

Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). Enterprise
extensions, when they exist, will live under `ee/` with a separate commercial
license; everything in this repository is Apache-2.0.

## Docs

- [CHANGELOG.md](CHANGELOG.md) — what changed, and the design record behind
  each change
- [docs/security.md](docs/security.md) — threat model (draft)
- [CONTRIBUTING.md](CONTRIBUTING.md) — the gate and the rules
