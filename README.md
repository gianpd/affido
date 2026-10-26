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
  demand: no host ports, its own `--internal` network with an iptables host
  wall — no route off its subnet and no path to host services by default, so
  the sandbox talks to its proxy and nothing else — and its workspace confined
  to a per-user volume.
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
> judgment — the model proposes, the code verifies, you decide. And when the
> check fails, the quote never becomes a citation: the reply is shown as prose
> with an explicit *no document evidence* label, and the trace keeps the
> refusal. Also note: Affido builds on `@earendil-works/pi-durable` 1.3.0, an
> experimental library; this stack pins it exactly and proves restart-survival
> in its e2e gate on every run.

![The citation gate refusing a tampered quote, then publishing the reply whose
quote verifies](docs/assets/gate-rejection.gif)

*30 s, recorded on the deterministic faux provider the quickstart runs (no API
key): the model claims fees are payable **annually**; `corpus_annotate` refuses
the span (`quote_mismatch`), the publish is refused (`unknown_citation`), and
the reply is labelled *no document evidence* — then the same model quotes the
stored line exactly and publishes with its citation, `line 8 ·
attribution_verified`. Higher quality: [MP4, 30 s](docs/assets/gate-rejection.mp4);
provenance in [`docs/assets/README.md`](docs/assets/README.md).*

## Quickstart (5 minutes)

```bash
cp .env.example .env        # set MANAGER_TOKEN (the local default works)
./dev.sh up                 # fake provider: no API key, deterministic demo
```

The stack: Caddy on `localhost:18080` (the only published port), Postgres,
the sandbox manager. Then prove a cold per-user provision end to end:

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
To check everything, including the idle pause and a hard-stop resume:
`./verify.sh`.

## Layout

```
agent/             the sandboxed TypeScript agent (durable harness, tools,
                   citation gate, traces, skills, artifacts)
sandbox-manager/   Python service: sandbox registry, provisioning, eviction
frontend/          SvelteKit web client (better-auth, documents, chat, traces)
caddy/             the only published endpoint, per-user /u/<id>/* routes
e2e-test/          bash suites driving the stack through Caddy only
marketplace/       curated skill catalog with manifest hashes
docs/rfc/          design records (read before changing what they describe)
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
```

`reload` is the edit-test loop: it rebuilds `affido-agent:latest`, brings the
control plane up, then removes the sandbox containers so the next request
re-provisions them from the new image. The Postgres volume, `pi-ws-<user>` and
`pi-data-<user>` are untouched, so documents, workspaces and sessions survive.
`reset` is the only command that deletes data.

`./dev.sh secrets` prints where each value lives: `.env` (compose, control
plane), `secrets/llm_key_kek` (the BYOK KEK, mounted into the manager only),
and what never touches the host at all (the users' provider keys).

```bash
./dev.sh status                          # control plane, sandboxes, volumes
./dev.sh down                            # stop the control plane, keep sandbox state
./dev.sh reset                           # remove containers, volumes, images; start from zero
```

Users who want a real model use BYOK; running the
agent image standalone keeps the secret-file branch of `agent/model.ts`
(see [Use a real model](#use-a-real-model)).

The e2e suite still runs against the running stack:

```bash
# Seeds better-auth-shaped sessions, then cold-provisions agents through Caddy.
./e2e-test/run.sh
```

The suite prints the sandbox container name for each user; drive that sandbox
through the same `/u/<user_id>/...` path with a session cookie (see below).

`docker compose down` only stops the control plane; per-user sandboxes and their
volumes survive, and `./dev.sh down` is the same thing.

## Web client

`frontend/` is a SvelteKit 5 app with better-auth accounts, shadcn-svelte
components and the AI SDK chat. It shares the `pi` database with the manager.
Postgres is published on `localhost:15432` (`OLTP_PORT` overrides).

```bash
cd frontend
cp .env.example .env      # set BETTER_AUTH_SECRET
pnpm install
pnpm db:migrate
pnpm dev                  # http://localhost:5173
```

Routes: `/dashboard` (overview), `/dashboard/documents`, `/dashboard/corpus`,
`/dashboard/chat`, `/dashboard/traces` (every captured snapshot),
`/dashboard/traces/[id]` (decision graph, entries, tasks, submissions) and
`/dashboard/settings` (AI provider: BYOK catalog, key entry, verification,
fingerprints — RFC 0012). The chat
bridge at `/api/chat` forwards the prompt to the user's sandbox and streams the
answer as an AI SDK UI message stream; each prompt also captures a trace
snapshot. See `frontend/README.md` for the two sandbox access modes (Caddy
gateway for host development, trusted manager `/resolve` for containers).

## Per-user sandboxes (RFC 0003)

The stack also runs the RFC 0003 control plane: `oltp` (Postgres with
`sandbox_registry`), `sandbox-manager` (Python, Docker socket) and a Caddy route
for `/u/<user_id>/*`. On every request Caddy's `forward_auth` subrequest asks the
manager to resolve the user; the manager provisions (network, volumes, container)
or starts the sandbox and returns `X-Sandbox-Endpoint`, which Caddy then dials.
The manager stops a paused sandbox after `STOP_AFTER_S` (L1) and starts it again
on the next request; the agent resumes the same SQLite session.

The e2e verifier does not log in through the Web Client; it seeds a
better-auth-shaped `"session"` row. The manager looks up the token part of a
signed better-auth cookie, so the same table serves both the seeded tests and
real Web Client accounts:

```bash
docker compose exec -T oltp psql -U pi -d pi <<'SQL'
CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY, "userId" text NOT NULL,
  "token" text NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL
);
INSERT INTO "session" VALUES ('sess-dev','dev-user','dev-token',now()+interval '1 day')
  ON CONFLICT ("id") DO NOTHING;
SQL

curl -H 'Cookie: better-auth.session_token=dev-token' localhost:18080/u/dev-user/status
```

Settings (`.env`): `MANAGER_TOKEN` (required by every manager endpoint except
`/healthz` — and manager endpoints answer only to the manager/Caddy/web
containers, never to a sandbox, token or not), `STOP_AFTER_S` (default 600),
`EVICT_TICK_S`, `AGENT_IDLE_MS`, `WEB_CONTAINER` (optional: connect the web app
container to each per-user network), `AGENT_EGRESS` (`off` by default: sandbox
networks are created `--internal` with no NAT — no route to the internet or
other subnets — plus a per-bridge `iptables INPUT DROP` host wall installed by
the manager (fail-closed); `open` is the opt-in for internet-reached providers
and a prerequisite for BYOK with one (RFC 0012 §5.5) — routed egress comes
back but the host wall stays), `OLTP_PORT` (host port for
Postgres, default 15432, bound to loopback only), `CADDY_BIND` (the published
bind address of the `:18080` entry point, `127.0.0.1` by default; set
`0.0.0.0` to expose the stack on the LAN).
Per-user agents all run `affido-agent:latest` (the manager forwards no `*_MODEL`
to `docker create`): the faux provider is the boot default, and the manager
delivers the user's BYOK choice at runtime through `POST /config` (RFC 0012
§5.4). The manager starts containers with `--workdir /workspace`;
the image CMD is absolute (`node /app/server.ts`) so it runs from any workdir.

## How each operation is implemented

**Navigate its own workspace.** The registry installs `CodingTools` (`read`,
`write`, `edit`, `bash`). The Harness builds a `NodeExecutionEnv` per tool call
rooted at `WORKSPACE` (the `env` option of `DurableHarness`). `GET /files` and
`GET /file` use the same environment (`Agent.#apiEnv`) and refuse paths that
escape `WORKSPACE`.

**Structure.** The agent is TypeScript, split by concern, with the dependencies
pointing at ports: `harness.ts` holds `HarnessLifecycle` (the durable lifecycle
interface) and `DurableHarness` (its pi-durable implementation), `agent.ts`
holds `ContainerAgent` (one container's model, registry, workspace, and
conversation), and `tools.ts` holds `HttpTool` (one HTTP operation: a method,
a path, and a handler). `ContainerAgent` runs on an injected
`HarnessLifecycle` (`AgentOptions.harness`, defaulting to a `DurableHarness`
built from the same options), and the tools depend on the `AgentApi` interface
rather than on `ContainerAgent` itself — `agent.test.ts` substitutes a fake
lifecycle and drives the agent with no database at all. The server routes each
request to the first matching `HttpTool`. `npm run typecheck` (`tsc --noEmit`)
and `npm test` (`node --test`) are the gates; at runtime Node 24 loads the `.ts`
sources directly with native type stripping, so the image ships no build output.

**Resume previous sessions.** Storage is SQLite at `SESSION_DB`
(`openNodeSqliteStorage`) on a named volume. `DurableHarness.#open` always calls
`runtime.root(context, ...)`, which returns the reserved root conversation
(`conversationId: 1`) with its entries, then `runtime.resume()` continues any run
the previous process left unfinished. Submitting the same `requestId` returns
the already-admitted submission instead of running again.

**One conversation per topic.** "New session" in the UI is `POST /session/new`:
`DurableHarness.newSession()` creates a separate conversation and switches to
it (RFC 0008). The active conversation is durable state — a session-scoped
document in `SESSION_DB` — so pause, restart and eviction reopen the same
conversation, never the root by accident. The chat view's History action is
`POST /session/switch { conversationId }`: it repoints that same durable
pointer at an existing conversation, so a session from six days ago resumes
with its full model context (unknown ids are 404, never a silent fall-back).
`/reset` keeps its own meaning: a `pi.reset` head marker that cuts the model's
context inside the current conversation. Nothing is ever deleted by any of
these routes; every past conversation stays readable through
`/inspect?conversation=`, and the web app's trace page groups captures by
conversation.

The agent config is stored with the session: `root()` applies its `agent`
options only when it creates the conversation, so on reopen the stored
`pi.agent` is used. `DurableHarness.#syncAgent` rewrites that stored model when
the deployment model changes, and the stored thinking level when
`THINKING_LEVEL` changes, so a BYOK delivery (`POST /config`, which rewrites
the deployment model) or a reasoning-effort change takes effect without wiping
the session. Without it, a provider switch would keep resolving the old,
now-unregistered model and answer `no_model`.

**Read its trace.** `GET /inspect` wraps `harness.inspect(context)` plus
`conversation.entries()`, `harness.usage()`, and filters both by conversation.
The port is `TraceSource` (three read-only calls) and the report is built by
`TraceReader` in `trace.ts`; the HTTP tool only parses the query and maps two
errors (400 for an invalid query, 404 for an unknown conversation). The report
carries the newest `limit` entries (default 50, clamped to 500) with a
collapsed summary, the live tasks and queued/placed submissions of that
conversation, and folded usage. `entries.returned` and `entries.hasMore` avoid
claiming a conversation total the entries API does not provide; settled
submissions are visible as `pi.user`/`pi.assistant` entries, not in
`submissions`, because `inspect()` returns live work only. `paused` is the
state at request arrival (the read activates the sandbox); `scheduling` is the
runtime state while reading. `/session/new` conversations are read the same way
through the `conversation` query parameter.

A summary is a projection: text, `tool:<name>`, `[thinking]`, `[image]`, and
named prompt sections, flattened and cut at 160 characters. Each entry also
carries structured decision fields when derivable from its first model message:
`role`; `tools` (assistant: tool names in call order — the decisions),
`stopReason`, `model`; `toolName`, `isError`, `durationMs` (tool results). The
dashboard decision graph is built from these. `GET /entry?id=`
reads one entry unprojected instead: the stored messages with their tool
results verbatim, `thinking` blocks as the provider returned them, tool-call
arguments, and the entry's `data` (tool diagnostics). The dashboard trace page
opens one row at a time with it, because shipping raw messages for a 500-entry
page would put every file the agent read into one snapshot row.

Thinking exists only if it was requested: the agent asks the provider for
reasoning at the `THINKING_LEVEL` it was created with (default `off`, which
sends no `reasoning` field). A provider that returns reasoning anyway still has
it stored and shown by `/entry`.

**Pause when idle.** Every activating request resets a timer. When it fires with
no request in flight, `DurableHarness.#pause` closes the Harness, which
checkpoints and closes the SQLite file. `GET /health` and `GET /status` never
open storage, so a health probe cannot defeat the pause.

**Activate when called.** `/prompt`, `/reset`, `/session/new`, `/files`, `/file`, and `/session`
call `Agent` methods that activate through `Harness.activate`, which reopens
storage and the Harness if they are closed. Open and pause run on one serialized
promise chain inside `DurableHarness` so a timer and a request cannot
interleave. The four `/uploads` endpoints, the four `/skills` endpoints, and
the three `/artifacts` endpoints are the opposite: they touch only the
workspace filesystem, like `/ingest`, and never activate the agent.

## HTTP API

| Method | Path | Activates | Purpose |
|---|---|---|---|
| GET | `/health` | no | liveness, used by the Docker healthcheck |
| GET | `/status` | no | `{ paused, conversationId, entries, inFlight }` (cached when paused) |
| GET | `/session` | yes | reopen and report `{ conversationId, entries }` |
| GET | `/inspect?conversation=1&limit=50` | yes | trace report: newest entries (summary + decision fields), live tasks and submissions, usage |
| GET | `/inspect?report=citations` | yes | citation report (RFC 0006): per-run used/reported/exact and gate friction |
| GET | `/entry?id=11` | yes | one entry unprojected: stored messages (tool results, thinking), tool-call arguments, `data` |
| GET | `/files?path=.` | yes | list a workspace directory |
| GET | `/file?path=...` | yes | read a workspace text file |
| POST | `/ingest?docId=...&filename=...` | no | raw body -> `{ docId, path, bytes, sourceSha256, searchable }`; stages the bytes at `corpus/raw/<docId><ext>`, derives PDF text into `corpus/text/` |
| GET | `/raw?docId=...&filename=...` | yes | read the staged bytes of a document back |
| GET | `/text?docId=...` | yes | read the text derived from a staged PDF (`corpus/text/<docId>.txt`); 404 when none was extracted |
| DELETE | `/ingest?docId=...&filename=...` | no | remove the staged bytes of a document |
| POST | `/uploads/dir` | no | `{ path }` -> create/confirm a directory under `corpus/uploads/` (PRD 0003) |
| POST | `/uploads/file?path=md-to-docx/SKILL.md` | no | raw body -> `{ path, bytes, sha256, searchable }`; writes the file at `corpus/uploads/<path>`; a PDF also gets its text derived into `corpus/text/` |
| GET | `/uploads?path=md-to-docx` | no | recursive tree of the uploads root or of one subtree |
| DELETE | `/uploads?path=md-to-docx` | no | remove a file or a subtree under `uploads/` |
| POST | `/skills/file?skill=md-to-docx&path=SKILL.md` | no | raw body -> `{ skill, path, bytes, sha256 }`; installs one bundle file at `skills/<skill>/<path>` (RFC 0009) |
| GET | `/skills` | no | installed skills of both roots: name, provenance, description, version, fresh verify |
| POST | `/skills/verify?skill=md-to-docx` | no | manifest body -> per-file ok / mismatch / missing against the installed tree |
| DELETE | `/skills?skill=md-to-docx` | no | remove the installed skill subtree; missing is not an error |
| GET | `/artifacts?path=` | no | recursive tree of the artifacts root or of one subtree (symlinks skipped) |
| GET | `/artifact?path=proposal.docx` | no | the file bytes as a download: attachment, static content type, 25 MiB cap, never a symlink |
| DELETE | `/artifacts?path=proj` | no | remove a file or subtree under `artifacts/`; missing is not an error |
| POST | `/prompt` | yes | `{ prompt, requestId?, citations?: "required" \| "off" }` -> `{ status, answer, evidence, citations[], artifacts[], submissionId, entries }` |
| GET | `/corpus/citations?runId=...` | yes | one run's citations, re-verified against the stored text (survives restarts) |
| POST | `/session/new` | yes | start a separate conversation (RFC 0008) -> `{ conversationId, entries }`; the previous one stays readable |
| POST | `/reset` | yes | start a new context (`pi.reset`); older entries stay in storage |
| POST | `/pause` | no | close the Harness now (deterministic pause) |

`/ingest` only stages bytes: it hashes them and writes them to the workspace, and
it does not run the parser yet. The control plane keeps the metadata and the
ingestion event; the bytes and any parsed markdown stay on the volume.

`/uploads` is a different contract (PRD 0003): the client dictates every path.
A directory tree a user shares with the agent — a skill with `SKILL.md` and a
`references/` folder, say — lands under `WORKSPACE/corpus/uploads/<path>` with
the structure intact, and the agent reads those files with its own tools. The
tree lives inside the corpus bucket: text files are indexed directly and PDFs
through text extracted at upload time (`corpus/text/`), so `corpus_grep` sees
them like any ingested document; other binaries are staged but not indexed.
The sandbox validates each path (`safeTreePath`: relative, no `..`, bounded
depth) and prefixes `corpus/uploads/` itself, so a crafted request cannot
write outside the workspace.

## Skills and artifacts (RFC 0009)

Two more workspace roots, both plain filesystem work that never activates the
agent:

- **`skills/`** — marketplace installs. The platform curates a catalog in the
  repo (`marketplace/skills/`, manifest-hashed by `marketplace/manifest.mjs`);
  the dashboard `/dashboard/skills` page installs it file-by-file into the
  user's sandbox and verifies against the manifest. Installs survive pause,
  stop, eviction, and reprovision (per-user volume); only `dev.sh reset`
  removes them. A prompt starting `/skill_name` gets a server-built hint in the
  stored content — resolved: "read that SKILL.md first"; unknown: an honest
  not-installed note naming what is installed. A user-shared
  `uploads/<name>/SKILL.md` tree is invocable the same way.
- **`artifacts/`** — the download surface. Deliverables the model writes there
  are reported by the `/prompt` envelope (`artifacts[]` with bytes, sha256,
  mtime — server-built, re-derived on idempotent replay), listed by
  `GET /artifacts`, and downloadable through the chat buttons or the uploads
  dashboard panel via the authenticated `/api/artifact` proxy. Downloads are
  always attachments with a static content type, capped at 25 MiB, and a
  symlink anywhere under `artifacts/` is neither listed nor served.

The image ships capability, not knowledge: a closed set of runtime libraries
(`docx` for document generation, `unpdf` for PDF text extraction — both
exact-pinned, resolved through `NODE_PATH`) and **no installer** — `npm`,
`npx`, and `corepack` are deleted from the runtime image, so extending the
toolbox at runtime fails with `command not found`. `verify.sh` asserts both
properties. The server-built container prompt section states these facts to
the model in every sandbox — which libraries exist, that PDFs are read with
`unpdf`, and that nothing can be installed — so an uploaded PDF is read
through `unpdf`, never characterized by its magic bytes for lack of
`pdftotext`. `unpdf` bundles a serverless build of PDF.js; the bundled engine
version is pinned by a unit test, so upgrading it is a one-line, reviewed
change. `md-to-docx` is the first catalog skill; the e2e drives the shipped
bundle end to end, including the faux documents dance that builds a real
`.docx` without an API key.

## Strict citations (RFC 0006)

A `/prompt` request with `citations: "required"` turns that one submission into
a strict run. The model gets `corpus_grep`, `corpus_read`, `corpus_annotate`,
`answer_publish` and `answer_plain`; an answer that carries document evidence
exists only through the gate: every non-heading line must carry a `[cit_...]`
token, the declared ids must be exactly the tokens used, and every id must be a
verified annotation of this run. A quote that is not an exact span of the
stored document produces no `citationId` at all, so it cannot be cited: further
`answer_publish` attempts are refused, and the model's remaining exit is
`answer_plain`, whose reply carries the explicit *no document evidence* label.
The envelope reports `evidence: "cited" | "plain" | "none"` plus the `citations`
array; the fields are server-built, never typed by the model. Requests without
the field keep today's free-form answer; `AGENT_CITATIONS_DEFAULT=required`
(followed by `./dev.sh reload`) flips that default. The chat UI carries the
per-question toggle; the report at `/inspect?report=citations` measures
exactness from the trace alone.

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
          | manager       |                             |
          +-------+-------+                             |
                  |                                     v
             +---------+                    +----------------------+
             |  oltp   |                    | u<user>-<hash>:8080  |
             |registry |                    | one per user         |
             +---------+                    | pi-net-<slug>        |
                                            +----------------------+
```

The control plane declares no agent `ports`, so the sole host mapping is Caddy's
`18080:80`. Caddy dials each agent by container name on the per-user
`pi-net-<slug>` network the manager created; the agent containers are not compose
services, so `docker compose ps` lists only caddy, oltp and sandbox-manager.

## Use a real model

Sandbox agents are created by the manager, which forwards no `*_MODEL` variable;
the faux provider is the default and is scripted by transcript state: a tool
call (`ls -la`) then an answer built from the listing, and a citation dance
(`corpus_grep` → `corpus_read` → `corpus_annotate` → `answer_publish`) when the
question mentions renewal — so the strict path can be exercised with no API key.
The recording at the top of this file is one more transcript
(`agent/citation-gate-demo.ts`): two questions, a tampered quote and an exact
one.

### BYOK (bring your own key, RFC 0012)

An authenticated user picks a provider from a curated catalog (or registers a
custom OpenAI-compatible endpoint) and submits their own API key. The key is
stored AES-256-GCM-encrypted in Postgres (the KEK is
[secrets/llm_key_kek](secrets/llm_key_kek), mounted into the manager only),
delivered to the running agent's memory at resolve time, and re-delivered after
any restart — never written to the container environment, image, filesystem,
URLs, or logs. Switching provider or rotating a key never recreates the
container and never wipes a session.

```bash
# once, in .env: the stack-level prerequisites
#   AGENT_EGRESS=open          (real providers are reached over the internet)
# then bring the stack up; dev.sh creates secrets/llm_key_kek when missing
./dev.sh up
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
never the key). The next request to `/u/<user_id>/...` resolves, delivers
`POST /config` to the agent (`credentials.modify` -> `setProvider` ->
`conversation.configure`, serialized with prompts), and the prompt is answered
by the provider. A user's own sandbox can read only their own key from its own
process memory; an idle-stopped sandbox holds no key material at all.

Production prerequisite (RFC 0012 §8.3): terminate TLS at Caddy (automatic
HTTPS on a public site address, or `tls internal` for private deployments)
before opening the BYOK endpoints to users — the shipped Caddyfile serves
plain HTTP on loopback, which is a dev-stack exception.

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

`./verify.sh` type-checks the agent (`npm run typecheck`, `tsc --noEmit` under
`strict`), runs its unit tests and the manager's BYOK unit tests, builds
`affido-agent:latest`, starts the control plane, then runs the e2e suite,
`./verify-sandbox.sh`, the security containment negatives, and finally the
BYOK chain against a fake OpenAI-compatible upstream (RFC 0012 §10: the
default gate stays keyless; the BYOK phase re-creates the stack with egress
open and a same-network fake provider, proves delivery, rotation,
validation and the L0/L1/recreation durability, then restores the keyless
default). It exits non-zero on the first failure.

`./e2e-test/run.sh` asserts that compose declares only the control plane, then
runs these checks through Caddy only:

- `happy-path.sh`: caddy -> sandbox-manager (cold provision) -> caddy -> sandbox
  agent -> reply, plus the 401/403 identity checks.
- `parallel.sh`: three users cold-provision three sandboxes and three Caddy
  requests get three concurrent agent replies; the script asserts distinct
  agents and overlapping request intervals.
- `citations.sh`: uploads a fixture document, asks a grounded question with
  `citations: "required"`, and asserts the gate-published envelope, the
  idempotent replay, the free-form answer without the field, the trace-only
  exactness report, and citation re-verification after a container restart.
- `uploads.sh`: creates a directory, uploads a two-level tree with full paths
  (PRD 0003), reads a file back through the agent's own file API, asserts the
  tree listing, refuses `../` escapes, and deletes the subtree.
- `skills.sh` and `artifacts.sh`: the marketplace loop (install, verify,
  corruption, uninstall) and the documents dance with its downloads.
- `providers.sh`: the manager's BYOK API in the default stack — catalog served
  from the agent image, cookieless 401 before the write handlers, the
  `egress_blocked` fail-closed, custom-baseUrl rules, the no-Origin 403,
  `no-store`, session binding, the trusted-caller token wall, and the peer
  guard on `/providers/*`.

`./verify-sandbox.sh` (part of the gate) then proves the L0 idle pause, the
manager's L1 stop and restart with the same conversation and entries, and that a
client-supplied `X-Sandbox-Endpoint` is stripped.

```
ALL CHECKS PASSED
```

## Notes

- `/status` reports `entries: 0` and `conversationId: null` while paused because
  it deliberately does not open storage. Call `/session` to resume and read the
  live values.
- The idle timer is `IDLE_MS` (default 5000 ms). `docker restart <sandbox>`
  demonstrates resume from a hard stop; the same happens on `SIGTERM`, which
  closes the Harness cleanly.
- Pausing closes the Harness and its SQLite file but keeps the process up. When
  the user stays away for `STOP_AFTER_S`, the manager stops the container; the
  next request through `/u/<id>/...` starts it again, so the proxy never needs a
  live upstream ahead of time.
- The workspace seeds `README.md`, `notes.txt`, and `data.txt` on first start.

## License

Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). Enterprise
extensions, when they exist, will live under `ee/` with a separate commercial
license; everything in this repository is Apache-2.0.

## Docs

- [docs/rfc/](docs/rfc/) — design records: sandboxes (0002, 0003), citations
  gate (0006), sessions (0008), skills and artifacts (0009), ingestion and
  index registry (0014)
- [docs/security.md](docs/security.md) — threat model (draft)
- [CONTRIBUTING.md](CONTRIBUTING.md) — the gate and the rules
- [CHANGELOG.md](CHANGELOG.md)
