# RFC 0015 — Multiple agent sandboxes per user (pool, collaboration, verifier agents)

| Field | Value |
|---|---|
| Status | Draft |
| Author | Affido maintainers |
| Date | 2026-10-27 |
| Target | `sandbox-manager/`, `caddy/`, `frontend/`, `agent/` (inbound guard + peer surface), `e2e-test/` |
| Related | RFC 0002 (N users = N sandboxes), RFC 0003 (manager), RFC 0008 (conversations), RFC 0012/0013 (BYOK pair), RFC 0006 (citations) |

## 1. Summary

The product fact this RFC establishes: **a sandbox belongs to a (user, agent)
pair, not to a user.** One account may own several agent sandboxes. Each has its
own container, sidecar, `/data` (SQLite session) and `/workspace`; each can take
part in the same visible chat; the user chooses how many run and what they do.
The first paid tier above the default is a **verifier agent**: a second
sandbox that reads the traces (and, if granted, the artifacts) of a main agent,
re-checks its claims, and returns a score the user can see next to the answer.

This is a capacity/identity change, not a new kind of agent. The durability
invariants of RFC 0002/0008 stay exactly as they are: one SQLite per sandbox,
one `Harness` per sandbox, one serialized promise chain per sandbox. What
changes is that the control plane stops assuming `user_id` is a unique sandbox
key, and the web app stops assuming one endpoint per user.

It is also a trust-boundary change, and §5 is the part that gates
implementation: one per-user network holding several agents means
reachability is no longer authorization, so the agent API and the RFC 0013
sidecar need caller credentials before a second sandbox exists.

## 2. What the current design hard-codes

| Assumption | Where |
|---|---|
| `sandbox_registry` is keyed by `user_id` (PK), one row per user | `sandbox_manager.py`, `SCHEMA` |
| Container, sidecar, network, volumes are named from the user slug only | `container_name`, `sidecar_name`, `network_name`, `workspace_vol`, `data_vol` |
| `try_claim` takes a per-user advisory lock and inserts at most one row | `try_claim` |
| One `--internal` network per user, and *any* non-guest peer is rejected | `network_name`, `is_sandbox_peer` / `rejected_sandbox_peer` |
| `/u/<user_id>/*` resolves to exactly one endpoint | `caddy/Caddyfile`, `@u` handler |
| The web client resolves one endpoint per signed-in user | `frontend/src/lib/server/sandbox.ts`, `resolveEndpoint(userId)` |
| Eviction/watchdog iterate registry rows as "users" | `eviction_tick`, `reconcile_tick` |
| Chat and trace rows are scoped by `(userId, conversationId)` | `frontend/src/lib/server/db/schema.ts`, `chat_message`, `trace_session` |
| README says "Each user gets one sandboxed agent" | `README.md` |

`conversationId` is storage-wide within one SQLite file, so it is **not** unique
per user once a user has two sandboxes: agent A's conversation 3 and agent B's
conversation 3 are different transcripts. Every table and every UI query that
pairs `(userId, conversationId)` needs the agent added.

## 3. Decisions

### 3.1 Sandbox identity is `(user_id, agent_id)`

- `agent_id` is a short, URL-safe slug minted by the manager at creation
  (`main`, `verifier`, `a3`, ...), unique per user, immutable for the life of
  the sandbox. It is not the container name: the container name stays a
  function of both (`u<user-slug>-<agent-id>`), so Docker names keep the
  collision proof already implemented in `slug()`.
- The id is never client-supplied. `POST /agents` accepts a role, not an id;
  when a caller suggests one it is validated against `^[a-z0-9][a-z0-9-]{0,23}$`
  and rejected with 400 otherwise (no silent rewriting). Every Docker object
  name is derived through `slug(user_id + "/" + agent_id)`, so a crafted id
  cannot escape the name space or collide with another tenant's object (§5.5).
- An id is not reused: after `DELETE` the row is tombstoned until its volumes
  are removed, so a recreated sandbox cannot mount a deleted agent's data.
- Every helper in `sandbox_manager.py` that takes `user_id` takes
  `(user_id, agent_id)`: names, volumes, network membership, endpoint,
  registry row, touch, eviction. No lookup is ever keyed by `agent_id` alone.
- The first `POST /resolve` for a user without an agent creates `main`. That
  keeps `/u/<id>/...` working and the default experience unchanged.

### 3.2 Isolation: one container pair per agent, one network per user

- Each agent is still an agent+sidecar pair (RFC 0013) with its own
  `/workspace` and `/data` volumes. Two agents never share a SQLite file: two
  harnesses writing one file would break the single-promise-chain invariant.
- The network stays per user (`pi-net-<user-slug>`), not per agent: this is
  what makes same-user collaboration possible without exposing anything to
  other tenants. The existing `--internal` wall, host wall and egress policy
  are unchanged. Per-agent networks were considered and rejected: the daemon's
  default address pool is a handful of `/16`s, and one bridge per sandbox
  exhausts it at a few hundred agents.
- Because the same subnet now holds several principals, reachability stops
  being authorization. Every agent route needs a caller credential (§5.2): the
  browser path through Caddy, the manager path through a per-agent control
  secret, the peer path through a task token. Shipping N agents with today's
  unauthenticated API is not an option.
- The peer guard stays one-sided: a peer on a per-user network is still
  rejected by the manager's HTTP API, and the manager gets no exemption for
  siblings. The sandbox-to-sandbox surface (3.4) is a separate route family on
  the agent with its own credential, not a relaxation of the manager wall.
- Cross-tenant remains forbidden and is still e2e-asserted
  (`e2e-test/security.sh`).

### 3.3 Sessions and chats: per-agent transcripts, one orchestrated chat

A chat is an orchestration record, not a shared SQLite file:

- `chat_message` gains `agentId`. One chat thread shows the messages whose
  `(userId, conversationId, agentId)` the orchestrator selected; the user sees
  one conversation while each agent keeps its own durable context.
- "Same chat" means: a prompt is routed to one agent (the lead), and the lead
  may delegate a bounded task to a peer through the agent-to-agent surface.
  The peer's own conversation is durable and separate; only the task payload
  and its result cross the boundary.
- `trace_session` gains `agentId` (the `agent` column today already stores the
  container name via `AGENT_NAME`, so this is a rename, not new information).
- Switching sessions (`/session/switch`), history listing and the traces page
  all take `agentId` as a required selector, never an implicit "the user's
  sandbox".

Rejected: one shared transcript across agents. It would require either
cross-container writes to one SQLite (violates single-writer durability) or a
new central transcript service (a second source of truth next to pi-durable).
Both are bigger than the feature and weaken the invariant that makes pause and
eviction safe.

### 3.4 Agent-to-agent surface is a narrow, explicit API

Collaboration is a tool, not ambient reachability:

- A small allowlisted API on the agent (`POST /peer/task` with a bounded JSON
  payload, plus a read-only trace/artifact fetch), reachable only with a task
  token scoped to `(callerAgentId, targetAgentId, taskId, expiry)` and never
  with the credential that opens the rest of the API. A peer cannot call
  `/prompt`, `/config`, uploads, deletes, or the citation store on another
  agent — enforced by the inbound guard in §5.2, not by convention.
- The token carries the caller's agent id, so the callee can record and
  authorize the direction. A single per-user secret shared by every agent is
  rejected (§5.4): it would let the verifier instruct the lead, and it would
  make `fromAgent` in the audit row forgeable.
- Delegation is one level deep by default (lead → verifier), with a
  per-conversation fan-out and wall-clock budget. A chain of agents delegating
  to each other is not part of this RFC; it needs its own budget and recursion
  analysis.
- The task payload and the result are untrusted data at both ends: the callee
  never treats a delegation as a system instruction, and the lead never treats
  a returned verdict as one.
- Every delegation writes a row in the orchestrator (user, fromAgent, toAgent,
  conversationId, task summary, result id), so the collaboration itself is on
  the record like any other step.

### 3.5 Verifier agents and correctness scores

The paid use case named in the request: 5 agents, each able to inspect a main
agent's traces and rate the correctness of what it did.

- A verifier is an ordinary sandbox created with `role = 'verifier'`. It gets
  no special runtime privileges; it is special only in what the orchestrator
  asks it to do.
- Input: a trace snapshot (the existing `/inspect?conversation=` payload plus
  `trace_session` rows), the citation report when the run was
  `citations: "required"`, and — only if the user grants it — read access to
  the main agent's workspace artifacts.
- Output: a structured verdict, not prose:
  `{ target: {agentId, conversationId, entryId}, verdict: "pass"|"fail"|"unsure",
     score: 0..100, checks: [{claim, evidence, status}], notes }`.
- Storage: new table `verification_report` keyed
  `(userId, verifierAgentId, targetAgentId, conversationId, entryId,
  capturedAt)`. Append-only, like `trace_session`; write path, binding and
  rendering rules in §5.7.
- Honesty: deterministic checks (citation gate, span sha256) stay
  deterministic and are shown as facts. The verifier's score is a model
  judgment and is labelled as such — same rule as the README's honesty box.
  A verifier failing its own run is visible; it never silently upgrades a
  verdict.

### 3.6 Quota and payment

- The manager enforces a per-user maximum of live agents
  (`max_agents`, default 1). It only reads the limit; it does not price.
  Billing stays outside this repo (whatever sells the tier writes the limit),
  and the limit is never read from the request: a client-supplied quota is no
  quota.
- The count and the insert are one transaction under an advisory lock keyed by
  `user_id`, not by `(user_id, agent_id)`. Locking the pair lets N concurrent
  creates with distinct ids all observe `current < max`; a loop of parallel
  `POST /agents` would then buy unbounded sandboxes (§5.6).
- The same check runs on the implicit `main` create in `POST /resolve`, so the
  first-use path cannot bypass it.
- Over-quota create returns `409 agent_quota_exceeded` with
  `{current, max}`, never a silent fallback and never a deleted agent.
- Deleting an agent is an explicit, confirmable action: stop the pair, keep
  the volumes for a grace window, then remove. It is not tied to quota
  enforcement.

### 3.7 Eviction and capacity stay per sandbox

`eviction_tick` / `reconcile_tick` iterate registry rows, which now mean
sandboxes. The RFC 0002 measurements apply per agent (~63 MiB idle, ~115 MiB
warm); a user with five agents costs roughly five times a user with one, which
is exactly what the paid tier buys. No new eviction policy is needed.

## 4. Concrete deltas

**Manager (`sandbox-manager/sandbox_manager.py`)**

- `sandbox_registry`: PK `(user_id, agent_id)`; new columns `role`,
  `created_at`; `container_name` unique. Migration in `migrate()`.
- Names: `u<slug>-<agent>`, `pi-ws-<slug>-<agent>`, `pi-data-<slug>-<agent>`,
  all derived from `slug(user_id + "/" + agent_id)`; network unchanged
  (`pi-net-<slug>`).
- `try_claim(user_id, agent_id)` takes one advisory lock keyed by `user_id`
  around the quota count and the insert (§3.6, §5.6).
- `POST /resolve {user_id, agent_id?}` → `{endpoint, agentId, browserToken,
  ...}`, defaulting to `main` (creating it on first use, subject to the quota
  check). `browserToken` is what Caddy copies onto the proxied request (§5.2).
- `GET /agents?user_id=` (registry view, no activation), `POST /agents
  {user_id, role}`, `DELETE /agents/{agentId}` resolved inside `user_id`.
- Per-agent secrets: a control secret minted at create for manager↔agent and
  manager↔sidecar calls, plus a pair credential for agent↔sidecar model
  calls. Delivered through create/config; never the image, never `SESSION_DB`.
- Peer task tokens: minted per `(caller, target, task)` with a TTL, a
  single-use id and the caller id inside; delivered on the authenticated
  `/config` channel (§5.4).
- `reconcile_provider` and sidecar wiring are per sandbox; nothing about BYOK
  changes.

**Caddy**

- `/u/<user>/a/<agent>/...` → `resolve?user_id=...&agent_id=...`.
  `/u/<user>/...` keeps resolving `main`. The agent group is validated before
  it reaches `resolve`; `forward_auth` returns the per-agent browser token and
  Caddy strips any client-supplied copy before copying the manager's value
  onto the proxied request. `X-Sandbox-Endpoint` keeps its existing strip.

**Frontend**

- `sandboxUrl(event, path, agentId)`; every server call that talks to a sandbox
  takes the agent it targets, validated against `(event.locals.user.id,
  agentId)` before use. In trusted-manager mode `resolveEndpoint` keeps the
  `browserToken` returned by `/resolve` for the forwarded request.
- `chat_message.agentId`, `trace_session.agentId`, new `verification_report`;
  Drizzle migration, no hand-edited history. Every read predicate keeps
  `userId` and adds `agentId`.
- Chat: an agent selector (default `main`), session history filtered by agent,
  a verification panel reading `verification_report` for the selected entry,
  with report text sanitized (§5.7).
- Traces page: filter by agent; a verifier run can be started from a captured
  trace.

**Agent (`agent/`)**

- No change to `HarnessLifecycle`, `DurableHarness`, `#syncAgent`, pause or
  storage.
- One opaque inbound guard in front of the route table (§5.2): the caller
  class (browser token, control secret, peer task token) is decided before a
  tool runs, and a missing or foreign credential is 403. `/health` also
  answers the in-container probe (Docker healthcheck) and returns no tenant
  data.
- One new tool module implementing the peer surface (3.4), registered as an
  `HttpTool` with an explicit statement that it does not activate the agent;
  it checks the task token's target, direction and expiry before reading the
  payload.
- `AGENT_NAME` stays the container name; the agent id is delivered in
  `POST /config` so traces and peer calls have a stable identity independent
  of the container name.

**e2e**

- `security.sh`: cross-user agents still 403; same-user peer surface works;
  a peer cannot reach `/prompt`, `/config`, uploads, deletes, `/inspect` or
  `/artifact` on the other agent; a sibling cannot write the other sidecar's
  `/config` or use its proxy; `/peer/task` rejects missing, expired, foreign
  and replayed tokens; `agent_id` injection is rejected; quota holds under
  concurrent creates.
- A multi-agent suite: two agents, one chat, a delegation, a verifier verdict
  persisted, quota exceeded, delete keeps the other agent's volumes intact.
- The existing manager assertion (a sandbox peer is 403 even with the real
  `MANAGER_TOKEN`) must keep passing unchanged.

## 5. Security model

### 5.1 The trust boundary moves

Today a per-user network is single-principal: the only non-guest peer is the
user's own agent, which is why the agent HTTP server and the sidecar have no
inbound authentication — reachability *was* the authorization. This RFC puts N
agents and N sidecars on that network, so reachability stops meaning anything.
Every sentence of the form "a peer cannot call X" must name the mechanism that
enforces it, or it describes an intention rather than a property.

The external surface does not change: Caddy on `:18080`, `forward_auth` on
every tenant path, no published agent ports, `--internal` and the host wall
untouched. The widening is measured from a valid account and from an agent
that runs attacker-influenced content (a prompt-injected verifier, a poisoned
document). Cross-tenant must stay exactly as impossible as it is today;
nothing here relaxes RFC 0003 §11.

### 5.2 The agent API needs a caller credential

| Route | What a sibling gains without a guard |
|---|---|
| `POST /prompt`, `/session/*` | runs prompts on the sibling's key, rewrites its durable conversation |
| `POST /config` | repoints the sibling's model upstream, rotates its peer credential |
| `GET /inspect`, `/artifact`, `/uploads`, `/file` | reads its traces and documents |
| `POST /pause`, `/reset`, delete routes | availability loss, data deletion |
| `GET /health`, `/status` | probes only; the manager needs them |

Decision: every agent route requires a credential for the caller class, and
`/peer/*` accepts nothing but a task token.

- **Browser path.** `/resolve` already returns the endpoint; it also returns a
  per-agent browser token. Caddy strips a client-supplied copy and copies the
  manager's value onto the proxied request (`copy_headers`), the same
  discipline already used for `X-Sandbox-Endpoint` (GHSA-7r4p-vjf4-gxv4). The
  web app in trusted-manager mode takes the same token from `resolveEndpoint`.
- **Manager path.** The manager mints a per-agent control secret at create
  (not in the image, not in `SESSION_DB`) and presents it on `/config`,
  `/health`, `/status`.
- **Peer path.** Task token only, never the browser token or the control
  secret.

`GET /health` also answers the in-container probe (the Docker healthcheck
hits `127.0.0.1`) and returns no tenant data. A guard that fails open when a
credential is missing is not acceptable: the default is 403.

### 5.3 The sidecar is per pair, not per user

The RFC 0013 sidecar assumes "same network = the manager". With two agents,
the same user's network contains another principal that can:

- `POST /config` and repoint the victim's upstream at itself (model I/O
  exfiltration and prompt injection into the victim);
- use the proxy as an authenticated oracle on the victim's provider key (spend
  abuse and response reads).

`configureSlot` refusing a keyless non-faux slot is what keeps this from being
direct key theft; it fixes neither attack. The peer credential of §5.4 is
delivered over this channel too, so an unauthenticated `/config` also lets a
sibling rotate the credential and then authenticate to the victim's peer
surface.

Decision: the sidecar keeps its one-principal posture by credential, not by
topology. `/config` requires the manager's control secret for that pair; the
proxy requires a pair credential delivered to the agent with the model config.
A sibling holds neither. Per-agent networks were considered as the alternative
and rejected under §3.2.

### 5.4 Peer credential: scoped, directional, short-lived

One per-user peer secret shared by every agent is rejected: the verifier — the
agent that reads the least trustworthy content — could then instruct the lead,
and any agent could claim to be any sibling in the audit row.

- Mint per `(caller, target, task)` with a TTL, single use, and the caller's
  agent id inside the token. The callee authorizes by direction: lead →
  verifier and verifier → lead are distinct capabilities.
- Deliver the token on the authenticated `/config` channel (§5.3), never over
  a channel another container can write.
- The token is minted and recorded by whatever component authorizes the
  delegation (manager or hub, §7.2); an agent never mints or requests one for
  itself.
- Budgets are security controls here: a per-conversation cap on delegations,
  payload size and wall-clock, so a poisoned agent cannot fan out across the
  pool and burn the user's provider budget.

### 5.5 Identity, naming and IDOR

`agent_id` reaches Docker names, volumes and a URL path, so it is treated as
untrusted input (rules in §3.1):

- server-minted, or strict `^[a-z0-9][a-z0-9-]{0,23}$` with a 400 otherwise;
- every Docker name through `slug(user_id + "/" + agent_id)`;
- lookups by `(user_id, agent_id)` only, so a client-supplied id can never
  select another tenant's row;
- the Caddy route's agent group is validated before `resolve`, and `resolve`
  cross-checks the agent row against the session user before returning an
  endpoint — the existing user-only cross-check is not enough once the path
  selects a row inside the user;
- `DELETE /agents/{agentId}` resolves the agent inside the authenticated user;
  no path mixes a session identity with a body identity;
- tombstoned ids (§3.1) so a recreated sandbox cannot mount deleted volumes.

### 5.6 Quota is a security control

Five agents per user is 5 × (512m + 128m) of host memory, and §3.7 keeps
eviction per sandbox. The quota is therefore the cost bound for a valid
account, and it must not race: count and insert under one lock keyed by
`user_id`, in one transaction, on both `POST /agents` and the implicit create
in `POST /resolve` (§3.6). The limit comes from the manager's own state, never
from the request.

### 5.7 Verification reports

- Writes come only from the orchestrator; the agent has no write path to
  `verification_report`.
- A report is bound to `(targetAgentId, conversationId, entryId, trace sha)`
  so it cannot be replayed onto another entry or another agent.
- `checks[].claim`, `evidence` and `notes` are model output derived from
  documents an attacker may control: sanitize on render (no raw HTML), keep
  deterministic checks visually separate, and label the score as a judgment
  (§3.5).

### 5.8 E2E negatives before the UI ships

- sibling agent cannot call `/prompt`, `/config`, `/reset`, `/pause`,
  `/inspect` or `/artifact` on another agent (403);
- sibling agent cannot write a sibling sidecar's `/config` or use its proxy;
- `/peer/task` rejects missing, expired, foreign-target and replayed tokens;
- a delegation from A to B is recorded with A as caller, and B cannot present
  A's token for a different target;
- `agent_id` injection (`../`, `/`, `;`, 64 chars, empty) is rejected, not
  slugged silently;
- quota holds under 10 concurrent `POST /agents`;
- cross-user agents remain unreachable, and the manager still 403s a sandbox
  peer holding the real `MANAGER_TOKEN` (unchanged assertion).

### 5.9 Residual risk

A compromised agent still has its own key path, its own workspace and its own
quota, and can still consume the user's provider budget up to that limit. That
is the accepted cost of running user-facing models in a sandbox. What must not
happen — and what this section exists for — is a compromised agent reaching a
sibling's key, data or API, or any container outside its tenant.

## 6. Consequences

- README's "Each user gets one sandboxed agent" becomes "one or more, starting
  with one" once this is implemented; the control-plane diagram gains the
  per-user pool and the quota check. Do not edit those claims before the code
  lands.
- `AGENTS.md` durability invariants do not change; add one line that sandbox
  identity is `(user, agent)` and that cross-agent state is RPC, never shared
  storage.
- The trust boundary that moves is the per-user network, not the manager's
  peer guard (§5.1). The manager guard must keep rejecting every sandbox peer
  unchanged; a bug there would still turn one tenant's verifier into a path to
  every other tenant, and the new guard must not weaken it. Both get their own
  e2e before the UI ships (§5.8).

## 7. Open questions (decisions needed before implementation)

1. **Orchestration location.** Does the web app route prompts to agents
   (hub), or does `main` decide delegation itself? Recommendation: hub for the
   first version (observable, no agent-to-agent recursion), delegation as a
   `main` tool later.
2. **Peer token minting.** §5.4 fixes the shape (scoped, directional,
   short-lived, single use); still open is who mints them: the manager per
   delegation (authoritative, one more resolve hop) or the hub (already
   authorized the delegation, needs a signing key the manager verifies).
3. **Verifier data access.** Trace + citations only, or also read-only
   workspace artifacts of the target agent? The latter is more useful and
   more sensitive; either way the grant is a scope on the task token that the
   target enforces, not a UI checkbox.
4. **Quota source.** The manager owns the value and reads it under the lock
   (§3.6); still open is how billing writes it — a column on the user row or a
   manager-side config map for now.
5. **Tenancy boundary for collaboration.** Same user only in v1? (Cross-user
   collaboration is out of scope here.)
6. **Naming.** `agent_id` in the API/DB, or `sandbox_id`? The RFC uses
   `agent_id` because the user-facing object is "an agent"; the table and the
   container remain "sandbox".

## 8. Out of scope

- Cross-user collaboration and shared chats between tenants.
- Agent-to-agent chains deeper than one delegation.
- L2 gVisor checkpointing of multiple sandboxes (RFC 0002 §4 is unchanged;
  L1 `docker stop` remains the eviction path).
- Pricing, invoicing, and plan management; the manager enforces a limit it is
  given.
- Per-agent Docker networks (rejected in §3.2 for address-pool reasons).
