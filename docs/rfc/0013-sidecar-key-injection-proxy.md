# RFC 0013 — Key-injection sidecar: the provider key never enters the agent process

| Field | Value |
|---|---|
| Status | Draft |
| Author | Affido maintainers |
| Date | 2026-10-25 |
| Target | `sandbox-manager/sandbox_manager.py`, `agent/model.ts`, `agent/agent.ts`, `agent/tools.ts`, `agent/Dockerfile`, `caddy/Caddyfile` (unchanged), `e2e-test/` |
| Related | RFC 0012 (BYOK — this RFC amends its delivery half, §5.4), RFC 0003 (manager owns topology) |
| Supersedes | none; tightens RFC 0012 R3 |

## 1. Summary

One fact motivates this RFC.

**RFC 0012's residual weakness is the agent process itself.** The delivered key
lives in the agent's `InMemoryCredentialStore`, and the agent's model-driven
tools (bash, scripts) execute as children of that same process, in that same
container. A prompt-injected document can therefore direct the model to search
the container for the plaintext. Today that search fails on disk and in the
environment (RFC 0012 R3 holds — no key in `SESSION_DB`, `WORKSPACE`, env, or
image), but the heap of the provider-calling process is, by construction, a
valid target. The honest statement of today's guarantee is: *the key is not
persisted anywhere, and it is plaintext exactly in the process that must use
it.* That last clause is the gap.

**Proposal — a per-sandbox key-injection sidecar.** A second container on the
per-user network, created by the manager beside the agent, which is the only
process that ever holds the plaintext key. The manager delivers `{provider,
modelId, apiKey, baseUrl?}` to the **sidecar**, not to the agent. The agent
receives `{provider, modelId}` plus a `baseUrl` pointing at the sidecar, and
makes provider requests **without any credential**; the sidecar stamps the
`Authorization` header and forwards to an upstream that is **pinned** at
delivery time (catalog hostname, or the user-registered custom endpoint). An
attacker who fully controls the agent process — including the model and every
tool call — can *use* the key (quota spend is inherent: the agent must call
the provider) but cannot *disclose* it: there is no plaintext in the agent
container to find, and the sidecar never sends the key anywhere except the
pinned upstream over verified TLS.

The threat boundary moves from **disclosure or abuse** to **abuse only**.

What this RFC does **not** change: keys still arrive encrypted (AES-256-GCM,
KEK in the manager only), desired state still lives in the OLTP, delivery is
still serialized at resolve time, the faux provider still needs no key, and
host/Docker compromise remains out of scope (RFC 0012 §2.2).

## 2. Problem

### 2.1 The attack, concretely

Trace under RFC 0012 as shipped:

1. User submits a key; manager stores ciphertext; at resolve time the manager
   decrypts and `POST /config {apiKey}` to the agent.
2. `configureProvider` writes it into the `InMemoryCredentialStore`
   (`agent/model.ts:128`) — a JavaScript string in the Node heap.
3. A user uploads a document. The corpus stages it; a later prompt includes
   its content. The document contains instructions addressed to the model
   (prompt injection).
4. The model runs `bash`. The bash process is a child of the server process,
   same container, same PID namespace, same cgroup — by design (`NodeExecutionEnv`,
   RFC 0005/0009).
5. The injected instructions say: find the key. Searches that fail today:
   `env`, `SESSION_DB`, `WORKSPACE`, image layers, `/config` responses (the API
   returns only `keyFingerprint`). Searches that are *not architecturally*
   blocked: reading the parent process's memory (`/proc/<pid>/mem`, core dumps,
   crash-restart loops), scraping heap remnants from `/proc/<pid>/*`, or any
   future tool that runs with more privilege than intended.
6. With `AGENT_EGRESS=open` (required for real providers), the exfiltration
   channel — the open internet — is already there.

Each individual barrier (no `CAP_SYS_PTRACE`, Yama `ptrace_scope`, toolbox
without `npm`) is a hardening detail, not a boundary: they make step 5
*unlikely*, not *impossible*, and none of them is enforced by the architecture.
Phase 0 (§6.4) turns two of them — the ptrace gate and the core-dump path —
into manager-enforced, kernel-level boundaries; the sidecar (§5) is what
closes the remaining in-process vector.

### 2.2 The rejected fix: encrypt inside the sandbox

"Keep the key encrypted in agent memory, decrypt per request" does not close
the gap, for three reasons:

1. **The plaintext must exist at request time.** The provider API requires
   `Authorization: Bearer <key>`. Whatever decrypts, lives in the same process
   the attacker (step 4–5) can probe. The window shrinks from "always" to
   "whenever a request is in flight" — and prompts are exactly what an
   attacker can trigger at will.
2. **The KEK would live in the same process.** In-process envelope encryption
   with an in-process wrapping key protects against nothing but cold disk
   reads — and RFC 0012 R3 already handles disk.
3. **Node cannot zeroize.** JS strings are immutable, moved by the GC, and
   copied into header buffers; "decrypt, use, wipe" has no honest
   implementation in this runtime.

Conclusion: the only fix that removes the plaintext from the attacked process
is to move the plaintext into a *different* process that the agent cannot read
— one whose only job is to hold it and use it.

## 3. Requirements and threat model

### 3.1 Requirements

- **R1 — The agent process never holds the provider key.** No plaintext key in
  agent memory, env, disk, or API responses. `docker exec` in the agent
  container is not sufficient to recover the key.
- **R2 — The agent can still call the provider.** Provider requests originate
  from the agent process (streaming, usage, tool calls all work); they route
  through the sidecar transparently to pi-ai.
- **R3 — Upstream pinning.** The sidecar forwards only to the upstream fixed
  at delivery time (catalog entry hostname, or the user-registered custom
  `baseUrl`), over TLS with certificate validation. No agent-controlled URL,
  header, or parameter can redirect the key to another host.
- **R4 — RFC 0012 flows keep their shape.** Setup, validation, catalog,
  selection, per-user isolation, idempotent resolve, faux default, session
  survival across provider switches (R8 of 0012) all hold. The delivery
  target changes; the desired-state model does not.
- **R5 — Topology stays manager-owned.** The sidecar is created by
  `create_args` in `sandbox_manager.py`, never in compose; the e2e guard that
  fails on `agent*` compose services must be extended to `sidecar*` the same
  way. `e2e-test/run.sh` keeps failing if either appears in compose.
- **R6 — No new published ports.** The sidecar binds only on the per-user
  `--internal` network, like the agent's `:8080` today.
- **R7 — Lifecycle is a pair.** Eviction, idle pause, recreation, and health
  cover agent+sidecar together; a resolve never routes an agent to a dead
  sidecar (fail closed, same policy as the hostwall).
- **R8 — Tests stay keyless.** The faux path is unchanged and keyless; the
  BYOK chain is proven against the existing fake upstream, now registered as
  a custom endpoint that the sidecar proxies to.
- **R9 — Abuse remains visible.** Losing disclosure must not lose
  accountability: prompt failures, usage events, and traces still identify the
  provider and model in play (fingerprint via sidecar `/status`).
- **R10 — The sidecar gets its own, reduced resource caps.** `create_args`
  caps the sidecar at `--memory 128m --cpus 0.25` (env-tunable
  `SIDECAR_MEMORY`/`SIDECAR_CPUS`, mirroring `AGENT_MEMORY`/`AGENT_CPUS`),
  never the agent's 512m/1.0. Measured (2026-10-25, Docker 29.9.2): a Node 24
  HTTP server in this image idles at ~10 MiB RSS; ~25 MiB is the realistic
  sidecar working set (undici + TLS + one key). Cloning the agent's cap would
  double the nominal per-user ceiling (512 → 1024 MiB) and halve
  cap-provisioned density for no benefit — the sidecar does no compute beyond
  SSE pass-through.

### 3.2 Threat model

Trust boundaries as RFC 0012 §2.2, plus one new boundary and one accepted loss:

1. **New boundary: agent process ≠ key holder.** Full compromise of the agent
   process — prompt injection, tool escape, malicious `node_modules` script —
   yields no key material. It does yield *key usage* (see 3).
2. **Accepted loss (was already true): key abuse.** The agent must be able to
   call the provider; a compromised agent can spend quota. This is inherent
   to any agent that uses the key, unchanged by this RFC, and bounded by the
   provider's own per-key limits. This RFC's claim is exactly: *disclosure
   becomes impossible from inside the agent; abuse remains possible.*
3. **Sidecar compromise ≈ agent compromise for usage, worse for disclosure.**
   The sidecar holds one user's plaintext key in memory. Reaching it requires
   breaking per-user network isolation — the same wall that today protects
   tenant separation (e2e `security.sh`). A sidecar does not weaken that wall
   (§9.2), and never holds more than one tenant's key (§9.1 — why the manager
   itself must not be the proxy).
4. Out of scope, unchanged: host/Docker-daemon compromise, control-plane
   compromise, traffic analysis of *that* a provider call happens.

## 4. Study: is every catalog provider proxyable via `baseUrl`?

The design stands or falls on one pi-ai fact: **every supported API layer
builds the upstream URL from `model.baseUrl`.** If the agent registers each
model with the sidecar's URL instead of the vendor's, all traffic routes
through the sidecar with no pi-ai changes. Verified against
`agent/node_modules/@earendil-works/pi-ai@1.3.0`:

| Provider (catalog) | pi-ai wire API | URL construction | baseUrl-content branches | Proxyable |
|---|---|---|---|---|
| openai | `openai-responses` | `baseURL: model.baseUrl` (api/openai-responses.js:233) | `isChatGPTSignIn` requires `baseUrl === "https://api.openai.com/v1"` exactly (js:27–32): rewritten URL takes the normal API-key path — which is what we want | yes |
| openrouter | `anthropic-messages`, `openai-completions` | `baseURL: model.baseUrl` (anthropic-messages.js:792, openai-completions.js:562) | OpenRouter detection checks `provider === "openrouter"` **before** baseUrl (anthropic-messages.js:140, openai-responses.js:49) — survives rewrite | yes |
| deepseek, groq, together, cerebras | `openai-completions` | `baseURL: model.baseUrl` | none for these providers | yes |
| fireworks | `anthropic-messages`, `openai-completions` | `baseURL: model.baseUrl` | provider id checked first | yes |
| xai | `openai-responses` | `baseURL: model.baseUrl` | none | yes |
| mistral | `mistral-conversations` | `new URL(model.baseUrl)` + path append (mistral-conversations.js:169–171) | none | yes |
| custom endpoints (RFC 0012 §3.2) | `openai-completions`, `compat` unset | `baseURL: model.baseUrl` | **`compat` auto-detect reads baseUrl** (openai-completions.js:1219–1233): a sidecar URL would mis-detect quirks | yes, with fix A3 |
| faux | — | none (no network) | — | n/a — stays direct, no key |

Two behavioral notes, both acceptable:

- **A1 — `prompt_cache_key`** is emitted only when
  `model.baseUrl.includes("api.openai.com")`
  (openai-completions.js:578). Through the sidecar, OpenAI prompts lose
  OpenAI-side prompt caching (only when `cacheRetention` is enabled; affido
  does not set it today). Mitigation if it ever matters: the sidecar can add
  the header itself, since it knows the real upstream.
- **A2 — streaming.** All four APIs stream SSE; the sidecar must pass bodies
  through unbuffered (§6.2). No pi-ai involvement.
- **A3 — custom-endpoint `compat`.** Today the agent leaves `compat` unset and
  lets pi-ai auto-detect quirks from the real `baseUrl`. With a rewritten URL
  auto-detection sees the sidecar. Fix: at delivery time the **manager**
  (which knows the real `baseUrl`) runs pi-ai's exported
  `detectCompat`-equivalent — or the agent resolves `compat` **before**
  rewriting (build the model from the real URL first, then rewrite only the
  `baseUrl` field, keeping the resolved `compat`). The second is simpler and
  keeps the logic in one place; `compat` is plain model data.

A second injection point exists — `ModelAuth.baseUrl` overrides the model URL
at request time (`auth.baseUrl ? {...model, baseUrl: auth.baseUrl}` ,
models.js:439) — but per-provider auth wrappers would touch more of pi-ai than
the one-field data rewrite, which needs no wrapper at all.

**Conclusion (R2 feasibility): the sidecar is reachable for every catalog
provider and for custom endpoints by rewriting one field of plain model data
at registration time. No pi-ai fork, no patching, no `baseUrl`-constrained
provider is left out.**

## 5. Design overview

```
   setup (unchanged, RFC 0012 §5.1–5.3)             activation (every resolve)
 browser ─HTTPS─> caddy /providers/* ─> manager ─> OLTP (ciphertext = desired state)
                     (forward_auth)        │
                                             │ resolve: ensure pair, wait_healthy ×2
                                             ├──── POST /config {provider, modelId, apiKey, baseUrl?}
                                             │            → SIDECAR  (holds key in memory)
                                             └──── POST /config {provider, modelId, viaSidecar: true}
                                                          → AGENT   (no key field at all)

 prompt time:
 agent ──POST {provider}/v1/... (no credentials)──> sidecar :8081
   sidecar: strip inbound auth headers, stamp Authorization: Bearer <key>,
            forward to PINNED upstream (catalog hostname / registered baseUrl), verify TLS
   agent <──────────────── SSE / JSON passed through unbuffered ────────────────
```

| Component | Owns | Never sees |
|---|---|---|
| browser | the key, while typing it | other tenants |
| caddy | TLS, routing (unchanged) | the key body |
| sandbox-manager | ciphertext + KEK, desired state, delivery to sidecar | — (trusted broker; sees plaintext in RAM during setup/delivery, as today) |
| OLTP | ciphertext, selection | KEK, plaintext |
| **sidecar** (new) | one user's plaintext key in memory, pinned upstream, header stamping | KEK, ciphertext, other tenants' keys |
| agent sandbox | provider registry with sidecar `baseUrl`s, placeholder credential, `ModelRef` per conversation | **the key — R1** |

## 6. Component design

### 6.1 Sidecar (`agent/sidecar.ts` in the same image; entry `node /app/sidecar.ts`)

One image, two entrypoints — the agent image already pins every dependency the
sidecar needs (Node 24, no npm). The manager creates it with
`create_args`-derived arguments: same per-user `--internal` network, no
published ports, no volumes, `restart` aligned with the agent's, own reduced
resource caps (R10), idle lifecycle owned by the manager (R7).

HTTP surface (per-user network only):

- `POST /config {provider, modelId, apiKey, baseUrl?}` — manager-only writer,
  same contract as the agent's `/config` today, minus everything else. Stores
  the key in a module-level variable (process memory, the sidecar's whole
  reason to exist), records the pinned upstream:
  - catalog provider → the catalog entry's `baseUrl` host (`provider-catalog.json`,
    already extracted from the image, RFC 0012 §5.1);
  - custom endpoint → the user-registered `baseUrl` (validated as today, RFC
    0012 §5.6);
  - `faux` → accepted and ignored (agent stays direct; no proxy hop).
  Rejects any later request whose resolved upstream host ≠ pinned host (R3).
- `GET /status` → `{provider, modelId, keyFingerprint, upstream}` — the
  manager's reconcile read for the key half of the state (R9). Fingerprint is
  `sha256(key)[0:12]`, same function as today (RFC 0012 §8.3).
- `GET /health` → liveness only; never opens the key.
- `ALL {provider-prefix}/...` — the proxy itself (below).

**Proxy behavior (R3 is here):**

1. Resolve the pinned upstream for the request's provider slot.
2. **Strip** every inbound `Authorization`, `x-api-key`, `cookie` header.
3. **Stamp** the credential the upstream expects: `Authorization: Bearer` for
   OpenAI-compatible APIs and Mistral; `x-api-key` for Anthropic-wire
   upstreams (openrouter/fireworks `anthropic-messages` models use
   `Authorization` too — the sidecar stamps per the delivered provider's wire
   API, decided at `/config` time from the catalog, not per request).
4. Forward method, path, query, body **unmodified**; `Host` rewritten to the
   pinned upstream; TLS with default verification (Node `fetch`, no agent
   input into the URL).
5. Relay the response — including SSE `text/event-stream` — **unbuffered**
   (A2): flush chunks as they arrive.
6. Never log headers or bodies. Same logging discipline as the manager's
   delivery path (RFC 0012 §8).

There is intentionally no per-request auth between agent and sidecar: the
sidecar's only peer on its network is the agent (and the control-plane guests
— the manager delivers config; caddy and the web app never dial it). A
prompt-injected agent can call the sidecar, and that is fine: the call is
indistinguishable from a legitimate model request, goes to the pinned upstream
only, and returns provider output, not key material.

### 6.2 Agent (`agent/model.ts`, `agent/tools.ts`)

- `buildProvider` gains a sidecar mode: for a delivered `{provider, modelId}`
  the agent builds the provider exactly as today (factory or
  `createProvider`), resolves `compat` while the real `baseUrl` is still in
  the model data (A3), then rewrites every model's `baseUrl` to
  `SIDECAR_URL/<provider>` and registers a **placeholder credential**
  (`sk-sidecar-<user-independent constant>`) in the `InMemoryCredentialStore`.
  The placeholder exists only so pi-ai's auth resolution does not report
  "provider not configured" (models.js:429); it carries no secret and is
  stripped by the sidecar before the upstream sees anything.
- `POST /config` on the agent keeps its shape but the manager's payload drops
  `apiKey` entirely (the agent's validation already treats it as optional).
  `/status` reports `keyVia: "sidecar" | "direct" | null` instead of a
  fingerprint it can no longer compute. Direct mode remains for the
  standalone-image path (no manager, secret files) so the image is unchanged
  as a deploy unit.
- Streaming, usage, thinking-level, and per-conversation `configure()` flows
  are untouched: the sidecar is a wire-level pass-through.

### 6.3 Manager (`sandbox_manager.py`)

- `create_args` provisions the pair: agent (unchanged, `AGENT_MEMORY`/
  `AGENT_CPUS`) + sidecar (same network, no volumes, no env secrets, own
  reduced caps `--memory $SIDECAR_MEMORY` (default `128m`) / `--cpus
  $SIDECAR_CPUS` (default `0.25`) — R10). The compose guard invariant
  extends: `run.sh` fails on `sidecar*` services just as it fails on `agent*`
  (R5).
- `resolve` ensures both containers, `wait_healthy` on both (R7), and the
  delivery split of §5: key payload → sidecar, keyless payload → agent.
  Serialized on the same chain as prompts, as today.
- `reconcile_provider` compares desired state against **sidecar** `/status`
  (fingerprint, provider, model, upstream) and **agent** `/status`
  (`keyVia`, provider, model). A stopped sidecar lost its key → re-deliver,
  exactly like the stopped-agent case today (RFC 0012 §5.4).
- Eviction/idle watch owns the pair: an agent without its sidecar is
  incomplete; evict and re-provision together. `docker rm` of either is the
  same event.
- `AGENT_EGRESS` semantics unchanged in phase 1 (the whole per-user network
  opens when a real provider is selected). Phase 2 (§12) narrows egress to
  the sidecar only.

### 6.4 Phase 0 — no-ptrace enforcement and core-dump suppression (sidecar-independent)

Lands first and stays valuable with or without the sidecar: it makes the
*current* RFC 0012 posture enforced by the manager instead of inherited from
host defaults. Measured baseline (2026-10-25, Docker 29.9.2, default builtin
seccomp, `node:24-bookworm-slim`):

| Probe (tool child → server process, same container) | Result | Why |
|---|---|---|
| `open /proc/$PPID/mem` | **EPERM** already today | Yama `ptrace_scope=1` (a child cannot attach to its parent) + `CAP_SYS_PTRACE` absent from the default set + builtin seccomp denying `ptrace` without it. Three layers — all *host-inherited* |
| `process_vm_readv`, `ptrace ATTACH` | same gate (`ptrace_may_access`) | blocked with the same EPERM |
| `/proc/$PPID/environ` | readable (weaker same-uid gate) | acceptable: the key is never in env (RFC 0012 R3) |
| `ulimit -c` | **unlimited** | the real gap: with a host `core_pattern` that writes a file (generic distro default), a crashing server leaves a readable core in `/app`. The dev host pipes cores to a handler, so it does not happen *there* — that is the host's luck, not our design |

Yama and `core_pattern` are host-global sysctls, invisible to `docker create`;
a deployment with Yama=0 or a custom seccomp profile silently reopens the
first two rows. Phase 0 removes the dependency on host configuration:

**P0.1 — explicit seccomp profile.** The manager image ships
`/app/seccomp-no-ptrace.json` and `create_args` passes
`--security-opt seccomp=/app/seccomp-no-ptrace.json` for **both** agent and
sidecar containers. The profile is minimal — `defaultAction: ALLOW` plus an
`SCMP_ACT_ERRNO` (EPERM) deny list for the `ptrace_may_access`-gated syscall
family: `ptrace`, `process_vm_readv`, `process_vm_writev`, `pidfd_getfd`
(FD stealing, same gate), `kcmp` (kernel-object comparison, same gate). The
server uses none of them, so nothing legitimate breaks. Verified: the docker
CLI reads the profile **client-side** and ships the JSON inline over the API
(measured: profile file applied from a foreign cwd, deny observed in the
container) — the daemon never touches the host filesystem for it. An operator
running the stack with `--privileged` bypasses seccomp entirely; that is the
host-operator trust domain, out of scope since RFC 0004.

**P0.2 — core-dump suppression.** `--ulimit core=0` in `create_args`
(verified: `ulimit -c` → 0 in the container) plus `process.setrlimit("core",
0)` early in `agent/server.ts` — the latter covers standalone image runs with
no manager, which a Dockerfile cannot express. With RLIMIT_CORE=0 the kernel
writes no core regardless of the host's `core_pattern`.

What Phase 0 deliberately does **not** do: it draws the boundary at "tool
process ⇏ server process". It does not protect the key against compromise of
the *server process itself* (§2.1 step 5 remains reachable through in-process
parsing of untrusted documents, `agent/corpus.ts`) — that is the sidecar's
job, and the two compose: with both, there is no plaintext in the container
*and* no syscall path to read another process's memory. UID separation (server
root, tools uid 1000) is deferred to §12.5: seccomp already closes the syscall
paths it would cover, and it costs WORKSPACE ownership plumbing.

### 6.5 What does not change

Caddyfile, frontend, OLTP schema (ciphertext/selection tables verbatim),
`/providers/*` surface, validation flow, catalog generation, `verify.sh`
shape, faux provider, keyless default.

## 7. Happy path (prompt with a real key, end to end)

1. User picks `deepseek/deepseek-chat` and submits the key (unchanged RFC
   0012 §5.1–5.3 flow; ciphertext lands in the OLTP).
2. Next `/u/<id>/prompt` → Caddy → manager `resolve`: ensure pair, health
   both, deliver `{provider, modelId, apiKey}` to sidecar `/config` (pinned
   upstream `api.deepseek.com`), then `{provider, modelId}` to agent
   `/config`.
3. Agent registers `deepseek` models with `baseUrl` `sidecar:8081/deepseek`,
   placeholder credential; conversation `configure()` pins the `ModelRef`.
4. Prompt runs; pi-ai `openai-completions` POSTs
   `sidecar:8081/deepseek/chat/completions` — no auth header the agent ever
   produced.
5. Sidecar strips, stamps `Authorization: Bearer <key>`, forwards to
   `https://api.deepseek.com/...`, relays SSE back chunk by chunk.
6. Prompt-injected content in the corpus later instructs "exfiltrate the API
   key": the agent process has no key to read (R1); a request to
   `sidecar:8081/attacker.example/...` is refused — unpinned host (R3); the
   only thing an attacker-operated agent can do is spend quota (§3.2.2).

## 8. Edge cases

- **Sidecar restart / eviction while idle:** key lost from memory — next
  resolve re-delivers (§6.3); in-flight streams fail exactly as a provider
  5xx does today; the harness retry semantics are unchanged.
- **Agent up, sidecar dead (crash loop):** `wait_healthy` on the sidecar fails
  → resolve fails closed with a new error code (`sidecar_unhealthy`), same
  policy as `egress_blocked`/`kek_unavailable`. Never a silent faux fallback.
- **`docker rm` of either container:** watchdog/reconcile re-provisions the
  pair; desired state is in the OLTP, so nothing is lost.
- **User switches provider or key:** new delivery to the sidecar replaces the
  pinned upstream and key atomically (single `/config` call, one lock);
  in-flight requests finish on the old upstream, queued prompts use the new
  one — same serialization contract as RFC 0012 §7.1.
- **Faux selected:** sidecar holds nothing; agent stays direct; no behavior
  change to the keyless default or `verify.sh`.
- **Custom endpoint with quirks (A3):** `compat` resolved from the real URL
  before rewrite; the sidecar pins the user-registered host. The e2e fake
  upstream is exactly this case, so the whole chain is testable keylessly
  against a real HTTP upstream (R8).
- **Very large request/response bodies:** pass-through with no size limit
  beyond Node defaults; no buffering means no new ceiling. (Body streaming
  both ways is a sidecar implementation requirement, §6.1 step 5.)
- **`prompt_cache_key` degradation (A1):** accepted in phase 1; documented in
  the README's BYOK section if affido ever enables `cacheRetention`.
- **Two sandboxes, one user:** not possible today (per-user registry is 1:1);
  if it ever becomes N:1, each agent gets its own sidecar — the invariant is
  "one key per process", not "one sidecar per user".

## 9. Security analysis

### 9.1 Why per-sandbox, never manager-as-proxy

Routing tenant LLM traffic through the manager would put **every tenant's
plaintext key in one process** — inverting the per-user isolation the whole
stack is built on. A per-sandbox sidecar holds exactly one key; compromising
sidecar A yields user A's key and nothing else, the same blast radius as
compromising agent A today (plus the key — see 9.3).

### 9.2 Does the sidecar weaken the perimeter?

No new surface is created: the sidecar binds on the same `--internal` network
as the agent, publishes nothing (R6), is created by the same manager code
path (R5), and holds no volumes. Cross-tenant reachability is unchanged (a
peer sandbox still cannot route to another subnet — `e2e-test/security.sh`
keeps proving it; the probe list grows one target). The hostwall story is
untouched: the sidecar never dials the host either, except through the
manager on its own bridge.

### 9.3 Residual disclosure surface (honest list)

Plaintext exists in: the browser's POST, caddy's TLS termination buffer,
manager RAM during setup/delivery, **sidecar RAM between delivery and
eviction**, and the TLS channel to the provider. New vs RFC 0012: the sidecar
process (per-user, one key, unreachable from other tenants). Removed: agent
RAM for the entire key lifetime. Host compromise still reads everything
(out of scope, unchanged).

### 9.4 Abuse (unchanged, now explicit)

A fully agent-compromised attacker spends quota on the pinned upstream until
the user rotates the key. Mitigations are external and already available:
provider-side spend limits, the `/status` fingerprint the user can compare
against, and rotation via the existing `PUT /providers/config`. This RFC
deliberately does not build rate limiting into the sidecar — that is a
provider-policy feature, not a key-custody feature.

## 10. Alternatives considered

1. **In-process envelope encryption, decrypt-on-use** — rejected, §2.2: the
   plaintext and its KEK share the attacked process; Node cannot zeroize;
   window shrinks but the boundary does not move.
2. **Manager decrypts per request (agent asks each time)** — rejected:
   plaintext repeatedly on the wire into the attacked process; strictly worse
   than status quo.
3. **Manager as egress proxy for all tenants** — rejected, §9.1: concentrates
   every tenant's plaintext in one process; also makes the control plane a
   data-plane bottleneck.
4. **TEE / enclave (SEV-SNP, Nitro Enclaves)** — out of scope: addresses host
   compromise (explicitly out of scope since RFC 0004), enormous operational
   cost, and the agent must still *use* the key so abuse is unaffected.
5. **Rotate-per-delivery short-lived keys** — not ours to choose: no catalog
   provider offers scoped, expiring, programmatically minted sub-keys today.
   If one does (OpenAI project keys move in this direction), the sidecar
   becomes the natural place to mint and hold them.

## 11. Verification

- `agent/` unit tests: sidecar mode of `buildProvider` (baseUrl rewrite
  preserves resolved `compat`, placeholder credential present, fingerprint
  absent); sidecar handler tests against a local upstream (strip/stamp/pin,
  SSE pass-through, unpinned-host refusal) using the same fake-upstream
  harness as `e2e-test/byok.sh`.
- `sandbox-manager/` tests: pair provisioning in `create_args` (including the
  sidecar's reduced caps per R10), delivery split, reconcile against sidecar
  `/status`, `sidecar_unhealthy` fail-closed.
- `e2e-test/byok.sh`: the fake upstream registers as a custom endpoint; the
  chain browser→manager→OLTP→sidecar→fake upstream proves the key never
  appears in any agent response or log along the way.
- `e2e-test/security.sh` additions: (a) from the attacker sandbox, the victim
  sidecar is unreachable (same subnet isolation probe, one more target);
  (b) from the attacker **agent**, a request to its *own* sidecar for an
  unpinned host is refused; (c) `docker exec` grep of the agent container's
  `/proc/1/environ` and filesystem still finds no key, and now the claim
  extends to process memory by construction (R1) — the test asserts the
  agent `/status` reports `keyVia: "sidecar"`.
- **Phase 0 checks** (in `security.sh`, before any sidecar exists): (a) inside
  the agent container, a node script whose bash child attempts
  `exec 3</proc/$PPID/mem` fails with EPERM — asserted *unconditionally*, so
  the guarantee no longer rides on the host's Yama/seccomp defaults;
  (b) `ulimit -c` reports 0 in the agent container and a self-SIGSEGV scratch
  process leaves no core file anywhere in the filesystem; (c)
  `docker inspect` on the agent shows the `seccomp` security-opt and the
  `core=0` ulimit — the behavior probes (a)/(b) are primary, this is the
  belt-and-braces assert.
- `./verify.sh` stays green with zero real keys.

## 12. Open questions

1. **Egress narrowing (phase 2):** with the sidecar as the only egress
   point, the agent's network could stay `--internal` even with real
   providers — the manager would attach NAT only to the sidecar (or use
   per-container bridge rules). Worth doing only if the threat model grows
   to include "agent exfiltrates *content* (not the key)"; today that is
   already possible and accepted.
2. **Cost:** one more container per active user (idle-evicted together, so an
   idle user still costs zero RAM — R7). Measured (2026-10-25, Docker 29.9.2,
   15 GiB host): agent RSS ~119 MiB idle-paused (cap 512m); sidecar ~25 MiB
   realistic (cap 128m, R10). Host RAM per active user grows ~17–21%
   (~119 → ~144 MiB); the nominal per-user ceiling is 640 MiB + 1.25 CPU, not
   double the agent's. Acceptable for the demo footprint; revisit if per-user
   density matters.
3. **Mistral path handling:** `mistral-conversations` appends
   `/v1/chat/completions` to the base (§4 table). The sidecar prefix scheme
   (`/<provider>/...`) must round-trip that correctly — covered by the §11
   handler tests before implementation is called done.
4. **Anthropic-wire custom endpoints:** today's custom endpoints are
   OpenAI-compatible only (RFC 0012 §3.2); if a future catalog entry speaks
   `anthropic-messages` with `x-api-key`, the stamp logic (§6.1 step 3)
   already covers it, but no test exists yet.
5. **UID separation inside the agent container** (deferred): run the server
   as root and every model-driven tool as uid 1000
   (`NodeExecutionEnv` spawning with `{uid, gid}`); a uid mismatch fails
   `ptrace_may_access` even where Yama is 0, so it is the belt to P0.1's
   suspenders. Cost: WORKSPACE/`/data` ownership plumbing and shared-group
   access for staged uploads. Revisit only if a threat model requires
   surviving a host with hostile seccomp handling; Phase 0's kernel deny list
   already covers the syscall paths.

## 13. Milestones

0. **M0 — Phase 0 enforcement** (§6.4): seccomp profile + `--ulimit core=0`
   in `create_args`, `process.setrlimit` in `server.ts`, `security.sh`
   Phase 0 checks. Independently shippable hardening of RFC 0012's current
   delivery; no sidecar yet.
1. **M1 — sidecar in the agent image** (`agent/sidecar.ts`, handler tests
   green with the fake upstream). No manager change; the image is a deploy
   unit per RFC 0009 D3.
2. **M2 — manager pair provisioning + delivery split + reconcile**; agent
   sidecar-mode `buildProvider`; `byok.sh` extended; `security.sh`
   additions. `./verify.sh` full pass. RFC 0012 §5.4 prose updated to the
   two-target delivery in the same change (no contradicting docs left
   behind).
3. **M3 (optional) — egress narrowing** (§12.1), only if content exfiltration
   enters the threat model.
