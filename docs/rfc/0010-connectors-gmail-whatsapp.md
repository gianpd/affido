# RFC 0010 — Connectors: Gmail (OAuth2) and WhatsApp (local bridge)

| Field | Value |
|---|---|
| Status | Draft |
| Author | pi-durable containers maintainers |
| Date | 2026-10-23 |
| Target | `agent/` (new `connectors/`, `tools.ts`, `server.ts`, `agent.ts`, `Dockerfile`), `frontend/`, `sandbox-manager/` (env forwarding), `e2e-test/` |
| Related | RFC 0002 (per-user sandboxes), RFC 0003 (manager, `create_args`), RFC 0004 (key exfiltration, gateway pattern), RFC 0008 (conversations), RFC 0009 (skills pattern: static tools, dynamic section) |

## 1. Summary

Today a user's sandbox agent is sealed. It can read the workspace, run bash,
and answer questions — but it cannot see the user's inbox or the user's
WhatsApp, because there is no mechanism at all for connecting an external
account to one sandbox:

```
user (chat): "summarize the emails about the Alpha offer I got this week"
  -> POST /api/chat -> Caddy /u/<id>/prompt
  -> agent: has read/write/edit/bash over an empty workspace. There is no
     credential, no tool, no route, no consent flow for Gmail. The honest
     answer is "I cannot access your email", every time.
```

This RFC adds the smallest complete connector plane, with exactly two
connectors:

- **Gmail** over the official API, connected by the user through an OAuth2
  authorization-code + PKCE flow driven by the frontend, tokens stored durably
  on the per-user volume. Zero new npm dependencies: the Gmail REST API and
  the token endpoint are plain `fetch` calls.
- **WhatsApp** over the local `whatsapp-mcp` bridge (Go + whatsmeow), compiled
  into the agent image as a second process, paired by the user through a QR
  code shown in the frontend, session stored durably on the per-user volume.

The design principle comes from how Grok structures the same problem (xAI
"Connectors", `docs.x.ai/grok/connectors` and `docs.x.ai/grok-bot/computer-and-apps`,
retrieved 2026-10-23): **the model gets operations, never credentials.**
Authorization is a user action (OAuth consent, QR scan) that happens on
non-activating routes outside any conversation; the agent process holds and
refreshes tokens; the model can only invoke a fixed set of reviewed tool
operations whose blast radius is capped by an explicit access tier. Where we
differ from Grok Bot on purpose: their cloud computer shares sessions and
credentials across every bot on the account ("screens are separate work
surfaces, not separate security boundaries"); our per-user sandbox is a real
container boundary, and this RFC keeps connector material per-user and outside
the workspace.

Decisions, in one line each:

- **D1** — A connector is a named, per-sandbox capability with a durable store
  on the `SESSION_DB` volume, never in `WORKSPACE`.
- **D2** — Connector state lives in `CONNECTORS_DB` (default
  `/data/connectors.sqlite`); tokens and pairing survive pause, stop,
  eviction, and reprovision because the volume does.
- **D3** — Gmail OAuth2: frontend-driven consent, sandbox-side code exchange
  with PKCE, refresh tokens in the connector store, tiered scopes.
- **D4** — Gmail model tools (`gmail_search`, `gmail_read`, `gmail_draft`,
  `gmail_send`) installed in the registry when the connector is enabled;
  availability is checked per call.
- **D5** — WhatsApp bridge (whatsmeow) runs as a child process of the agent
  server, session at `/data/whatsapp/`; pairing QR is served through a
  non-activating route.
- **D6** — WhatsApp model tools (`wa_list_chats`, `wa_list_messages`,
  `wa_search_contacts`, `wa_download_media`, `wa_send_message`, `wa_send_file`)
  with outbound send behind a write gate that defaults to off.
- **D7** — Access tiers are chosen by the user at connect time and enforced by
  the agent process, not by the prompt.
- **D8** — Every connector operation lands in the durable trace; secrets
  never appear in tool results, traces, or the workspace.
- **D9** — Manager forwards one new env (`CONNECTORS`); no topology, network,
  or mount change; secrets ride the existing `SECRET_DIR` mechanism.
- **D10** — Frontend gains a Connectors panel; all connector routes are
  non-activating, so polling status cannot defeat the idle pause.

## 2. Problem

### 2.1 The four missing pieces

1. **No consent path.** Nothing lets a user say "this sandbox may read my
   mail". There is no OAuth flow, no QR pairing, no place for the result to
   live. The only credential channel is `SECRET_DIR`, which is
   platform-material (model keys), mounted at `docker create`, and shared —
   structurally wrong for per-user, per-account authorizations.
2. **No durable token home.** The durability invariants say anything that
   must survive `docker stop` belongs in `SESSION_DB` or `WORKSPACE`. A
   Gmail refresh token must not go in `WORKSPACE`: the model can read every
   byte of the workspace through `read`/`bash`. `SESSION_DB` is owned by the
   pi-durable harness; agent code adding tables to it would be squatting.
3. **No tool surface.** The registry (`createAgentRegistry`) installs
   `CodingTools` and the citation extension. There is no mechanism for
   "tools that exist when a connector is connected", and the registry is
   built once at process start while connections happen later — the two
   clocks must not be coupled (RFC 0009 solved the same problem for skills
   with static tools + a dynamic section).
4. **No audit story.** Once the agent can act on an inbox or send a message,
   "what did it do in my name" must be answerable. The durable trace already
   records every tool call verbatim; connectors must not route around it.

### 2.2 Why not the obvious alternatives

- **"Put the password in chat"** — the user pastes an app password to the
  model. Rejected by Grok too ("avoid pasting passwords or one-time codes
  into chat"): the credential would sit in the conversation forever, in the
  trace, in every model context replay. The connector store keeps secrets
  out of the conversation; the model sees only operation results.
- **IMAP/SMTP instead of Gmail API.** Fewer consent screens, but app
  passwords are all-or-nothing (no read-only tier), Google is retiring them
  for Workspace accounts, and the OAuth scope model gives us the tiering in
  D7 for free. IMAP stays available later as a second connector; it is not
  the shape of the first one.
- **WhatsApp Business Cloud API.** Official, but requires a business number,
  Meta verification, and per-conversation pricing. It cannot use the user's
  personal number. whatsmeow pairs as a companion device on the number the
  user already owns — the exact capability this RFC wants, with the honest
  caveat documented in §9 (unofficial protocol, re-pairing, ToS risk).
- **A connector gateway service (tokens outside the sandbox).** This is the
  RFC 0004 shape and it is where multi-tenant deployments must end up. It is
  deferred (§12): with per-user sandboxes, the Gmail token guards only the
  user's own single account, in a container only that user's prompts reach.
  The reduced blast radius — versus RFC 0004's shared platform keys — is
  what makes in-sandbox storage acceptable for the first cut. The gateway
  swap stays possible because the model only ever sees operations (D4/D6).

### 2.3 What this RFC does not change

- The corpus model (RFC 0005/0006): email bodies and WhatsApp messages
  fetched by tools are conversation material, not citable corpus; they never
  enter `corpus/raw/`.
- The conversation and durability model (RFC 0008): no new activation paths
  beyond `/prompt`; connector routes never open the harness.
- Sandbox topology: sandboxes are still created by `sandbox_manager.py`
  `create_args`; no new compose service, no new network, no new mount.
- The skill marketplace (RFC 0009): connectors are configured, not
  installed from a catalog; the two mechanisms are orthogonal.

## 3. Responsibilities and access types

This section is normative. "Agent" below means three different things, and
the connector plane keeps them separate.

### 3.1 The four parties

| Party | Who it is | Connector responsibilities | Never does |
|---|---|---|---|
| **Platform** | deployment maintainers | Curates which connectors exist in the image (D5, `CONNECTORS` env); holds the OAuth client id/secret as `SECRET_DIR` files; pins the bridge binary | Sees user content; participates in consent |
| **User** | the sandbox owner | Performs authorization (Google consent screen, WhatsApp QR scan); picks the access tier; can disconnect at any time; revokes at Google / unlinks the companion device in WhatsApp settings | Handles tokens; pastes codes into chat |
| **Agent process** | trusted code in `server.ts`/`connectors/` | Exchanges codes and refreshes tokens; stores connector state (D2); enforces tiers and gates (D7); proxies tool operations; redacts secrets (D8) | Exposes credentials to tool results; activates on connector routes |
| **Model** | untrusted reasoning inside a run | Invokes connector tool operations by name with arguments; reports tool errors honestly; follows the connector prompt section | Sees tokens, client secrets, QR payloads, or `/data` paths; mints capabilities; sends while the write gate is closed |

### 3.2 Access tiers

Tiers are chosen by the user at connect time (Gmail) or pairing time
(WhatsApp), stored in the connector store, and enforced by the agent process
before any tool operation runs. The model cannot raise its own tier: a
`gmail_send` call while tier R is connected fails with a structured error the
model must surface, not work around.

**Gmail** (each tier's scopes are requested only when that tier is picked —
the Grok tiered-scope model):

| Tier | OAuth scopes | Tools unlocked |
|---|---|---|
| `read` (default) | `gmail.readonly`, `openid`, `email` | `gmail_search`, `gmail_read` |
| `draft` | + `gmail.compose` | + `gmail_draft` (creates a draft, never sends) |
| `send` | + `gmail.send` | + `gmail_send` (implies `draft`) |

Upgrading a tier is a reconnect: a fresh consent with the larger scope set.
Disconnect deletes the stored tokens and calls Google's revoke endpoint.

**WhatsApp** (whatsmeow pairs as a full companion device, so tiering is our
tool gating, not the protocol's):

| Tier | Tool gate | Tools unlocked |
|---|---|---|
| `read` (default at pairing) | inbound | `wa_list_chats`, `wa_list_messages`, `wa_search_contacts`, `wa_download_media` |
| `send` | outbound toggle, default **off** | + `wa_send_message`, `wa_send_file` |

The outbound toggle is a connector-store flag the user flips from the
Connectors panel; it is never settable from a prompt.

### 3.3 What the agent process does per operation

```
model calls gmail_search({query: "from:alpha newer_than:7d"})
  -> connector tool (agent process)
       1. connector enabled?            else structured "not enabled"
       2. state = connected?            else structured "not connected; the user
                                          must connect Gmail from the panel"
       3. tier allows search?           else structured "tier read allows search" —
                                          (this op) or "write gate closed" (sends)
       4. access token fresh? else refresh with the stored refresh token
       5. fetch Gmail REST, map errors to structured tool errors
       6. result (message bodies included) returns to the model AND is recorded
          verbatim in the durable trace by the existing tool-call path
```

Every failure mode is a tool result the model can act on ("tell the user to
connect Gmail"), never an exception that kills the run.

## 4. Design

### D1 — A connector is a per-sandbox capability

A connector is identified by name (`gmail`, `whatsapp`) and owned by the
sandbox's user. Existence is deployment config; connection state is per-user
data. Nothing connector-related is ever written under `WORKSPACE`: the model
can read every byte of the workspace, so the workspace is the one place
connector material cannot live. `/run/secrets` stays platform-only (client
id/secret); `/data` gains the user's connector state.

### D2 — The connector store

New `agent/connectors/store.ts` over a dedicated SQLite database at
`CONNECTORS_DB` (default `/data/connectors.sqlite`), same volume as
`SESSION_DB`, so the existing per-user volume carries it through pause,
stop, eviction, and reprovision. Schema (single-user per sandbox, but keyed
for explicitness):

```sql
CREATE TABLE connector_state (
  name            TEXT PRIMARY KEY,      -- 'gmail' | 'whatsapp'
  status          TEXT NOT NULL,         -- 'available' | 'connected' | 'error'
  tier            TEXT,                  -- 'read' | 'draft' | 'send' (gmail)
  write_gate      INTEGER NOT NULL DEFAULT 0,  -- whatsapp outbound toggle
  refresh_token   TEXT,                  -- gmail only
  access_token    TEXT,                  -- gmail only, cached
  access_expires  INTEGER,               -- epoch ms
  account_email   TEXT,                  -- from userinfo, for the panel
  paired_at       INTEGER, error TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE oauth_handshake (           -- in-flight PKCE state, short-lived
  state           TEXT PRIMARY KEY,
  code_verifier   TEXT NOT NULL,
  tier            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
```

`whatsapp` rows never store session material: the whatsmeow session lives in
its own database owned by the bridge (D5). The row only mirrors status.

### D3 — Gmail OAuth2 flow

Web-application OAuth client; redirect URI points at the **frontend**
(`.../connectors/gmail/callback`), because the sandbox is not publicly
reachable and the frontend is the surface the user already trusts. Flow:

```
panel: "Connect Gmail" (tier selector)
  -> GET  sandbox /connectors/gmail/start?tier=read      [non-activating]
       agent process: state + code_verifier (PKCE S256) into oauth_handshake,
                      returns Google consent URL (prompt=consent, access_type=offline)
  -> browser: Google consent screen (user authenticates; agent never sees it)
  -> redirect: frontend /connectors/gmail/callback?code&state
  -> POST sandbox /connectors/gmail/code {code, state}   [non-activating]
       agent process: verify state, delete the handshake row, exchange code
                      (token endpoint, client id/secret from SECRET_DIR files
                      gmail_client_id / gmail_client_secret), store refresh
                      token, fetch userinfo email, set status=connected
  -> panel: connected as <email>, tier read
```

Tokens are refreshed inline at operation time (§3.3 step 4); there is no
background refresher, so a paused sandbox performs zero network calls — the
idle-pause invariant is untouched. If Google refuses the refresh, status
flips to `error` with the reason and the next tool call says so.

Zero new npm dependencies: consent URL construction, PKCE, the token
exchange, and all Gmail calls (`GET
gmail/v1/users/me/messages?q=…`, `GET …/messages/{id}?format=full`, `POST
…/drafts`, `POST …/messages/send`) are `fetch` + `URLSearchParams` + the
`node:crypto` already in the image. This keeps RFC 0009's position that
runtime capability is baked and reviewed, and here it costs nothing at all.

### D4/D6 — Model tools: static registration, dynamic availability

The registry is built once at boot, but connections happen later, so the
RFC 0009 skills pattern applies verbatim: **tools are installed once when
the deployment enables the connector; availability is checked per call; a
prompt section renders live state**.

`createAgentRegistry` gains, after the skills section:

```ts
registry.install(
    connectorExtension({ gmail: gmailClient(config), whatsapp: waClient(config) }),
);
// extension provides:
//   section("connectors", () => renderConnectorsSection(store), { tag: false })
//   tools: gmail_search, gmail_read, gmail_draft, gmail_send,
//          wa_list_chats, wa_list_messages, wa_search_contacts,
//          wa_download_media, wa_send_message, wa_send_file
```

The section text is the model's whole truth about connectors, rebuilt per
prompt from the store: which are connected, at what tier, whether outbound
send is open, and the standing instruction that it must report "not
connected" honestly and never fabricate mailbox or chat content. When
`CONNECTORS` is empty the extension is not installed and the section is
omitted — the prompt does not grow a single token.

Tool set (deliberately small; every tool is one HTTP-shaped operation):

| Tool | Args | Tier | Notes |
|---|---|---|---|
| `gmail_search` | `query` (Gmail operators), `max` (≤25) | read | returns id, from, subject, date |
| `gmail_read` | `id` | read | full body, headers, attachment names |
| `gmail_draft` | `to`, `subject`, `body` | draft | creates a draft; returns Gmail draft id |
| `gmail_send` | `to`, `subject`, `body` | send | sends; see send guard below |
| `wa_list_chats` | `query?`, `limit` | read | from the bridge's local index |
| `wa_list_messages` | `chat_jid?`, `query?`, `after?`, `before?`, `limit` | read | paginated, with context |
| `wa_search_contacts` | `query` | read | name/number match |
| `wa_download_media` | `message_id`, `chat_jid` | read | lands in `WORKSPACE/media/`, returns the relative path |
| `wa_send_message` | `recipient` (number or JID), `message` | send gate | |
| `wa_send_file` | `recipient`, `path` (workspace-relative) | send gate | refuses paths outside the workspace |

Media is the one place connector output touches the workspace — by design:
downloaded files are ordinary workspace material the model can then read,
cite-adjacent process, or attach to a draft.

**Send guard (both connectors).** `gmail_send` and the two `wa_send_*` tools
deduplicate per run: the client caches `(runId, op, recipient, hash(body))`
in memory for the process lifetime and makes a repeated identical call within
the same run a no-op returning the first result. This cannot make Gmail's
send endpoint transactional, but it closes the realistic double-send: a model
retrying a call inside one run. The `/prompt` idempotency (same `requestId`
returns the admitted submission without running) already covers HTTP-level
retries.

**Per-run budget.** The extension wraps every tool with a counter: at most
25 connector operations per run, then a structured "budget exhausted" error.
A runaway loop burns the budget, not the inbox.

### D5 — WhatsApp bridge in-image

The local `whatsapp-mcp` project's Go bridge (whatsmeow + SQLite) is compiled
into `pi-durable-agent` as a static binary and runs as a **child process**
spawned by `server.ts` when `CONNECTORS` contains `whatsapp`:

- Multi-stage `Dockerfile`: pinned `golang` builder stage compiles the
  bridge (vendored, exact-pinned like every other dependency in this repo);
  the runtime stage copies the static binary next to the Node sources.
- Session store at `/data/whatsapp/` (same per-user volume as `SESSION_DB`
  and `CONNECTORS_DB`): pairing survives pause, stop, eviction, and
  reprovision; only `dev.sh reset` removes it.
- The bridge serves its HTTP API on `127.0.0.1:8190` — loopback only, so no
  other container on the per-user bridge network can reach it. The agent
  process is its only client. (The Python MCP layer of `whatsapp-mcp` is not
  shipped: `tools.ts` handlers talk to the bridge API directly, which is
  fewer processes and one less protocol translation.)
- `server.ts` supervises the child: spawn at boot when enabled, forward
  SIGTERM, reflect liveness in connector status. A bridge crash marks the
  connector `error` — it does not crash the agent.

**Pairing.** whatsmeow pairs as a companion device via QR:

```
panel: "Pair WhatsApp"
  -> GET sandbox /connectors/whatsapp/pair      [non-activating]
       agent process -> bridge: start pairing; bridge returns the QR string
       response: { qr: "<pairing string>" }
  -> frontend renders the QR locally; user scans with WhatsApp > Linked devices
  -> panel polls GET /connectors                 [non-activating]
       status flips to connected once the bridge reports the device linked
```

The bridge is extended (it is our local fork) to expose the raw pairing
string over its HTTP API, because the terminal QR it prints today is useless
headless. whatsmeow sessions expire as companion devices do — re-pairing
every ~14–20 days is expected and is surfaced by the status route as
`status: error, error: "pairing expired"`.

No ffmpeg in v1: audio files can be sent with `wa_send_file`, but not as
playable voice notes. That is the one capability deferred to keep the image
delta to the Go binary.

### D7 — Tier and gate enforcement point

Enforcement lives in the connector clients (`agent/connectors/gmail.ts`,
`whatsapp.ts`), which are the only code that reads the store and holds
tokens. Tools are thin; sections are honest; **the client says no**. A model
cannot raise a tier because tiers change only through the connect flow, and
the write gate only through the panel — both non-activating routes with no
prompt-path equivalent.

### D8 — Trace and audit

Connector tool calls ride the existing durable tool-call path: arguments and
results land in the conversation verbatim, replayable through `/inspect` and
`/entry`. That is the audit trail for "what did the agent do in my name" —
stronger than Grok's, whose runs are not user-inspectable at this grain.

Two redaction rules are enforced at the client boundary, with a unit test
each: (1) no tool result ever contains `refresh_token`, `access_token`,
`code_verifier`, or the QR string; (2) token-refresh failures return the
Google error code, never the request body. The handshake row is deleted on
use; expired handshakes are reaped on the next `start`.

### D9 — Manager, compose, environment

One manager change: `create_args()` forwards `CONNECTORS` (comma list,
default empty). Sandbox env is fixed at `docker create`, which is fine — the
connector catalog is deployment config, like the model. Compose is
untouched: `caddy`, `oltp`, `sandbox-manager` only, and `e2e-test/run.sh`
keeps failing on any `agent*` service. The OAuth client files ride the
existing `SECRET_DIR` mechanism (`readSecret("gmail_client_id")` /
`readSecret("gmail_client_secret")`): absent files mean Gmail is not offered
even if listed in `CONNECTORS` — the panel says so, the tools are not
installed. `AGENT_SECRETS_DIR` remains the single-tenant dev path; its
multi-tenant replacement is the same problem RFC 0004 solves for model keys
and is intentionally out of scope (§12).

`.env.example` gains, in the existing comment style:

```
# Connector catalog for sandboxes: comma list of gmail,whatsapp. Empty = none.
CONNECTORS=
# Gmail OAuth client (Web application type). Files under the agent secrets
# dir; absent = the gmail connector is not offered.
#   gmail_client_id     -> Google OAuth client id
#   gmail_client_secret -> Google OAuth client secret
```

### D10 — Frontend

One new Connectors panel (both sandbox access modes, like the marketplace
page of RFC 0009):

- lists connectors with live status, account email, tier, write gate;
- Gmail: tier selector → `start` → redirect → callback page → `code` POST;
- WhatsApp: `pair` → QR render → status poll;
- write-gate toggle (WhatsApp) and disconnect for both, each calling the
  corresponding non-activating route.

## 5. HTTP surface

All new routes are `HttpTool` subclasses in `tools.ts`, registered in
`server.ts`. **All are non-activating** — the connector plane must not open
the harness; a panel polling status cannot defeat the idle pause.

| Method + path | Purpose | Activates |
|---|---|---|
| `GET /connectors` | statuses: name, status, tier, account, write gate, error | no |
| `GET /connectors/gmail/start?tier=` | consent URL + PKCE state | no |
| `POST /connectors/gmail/code` | `{code, state}` → exchange, store, connect | no |
| `POST /connectors/gmail/disconnect` | revoke + delete state | no |
| `GET /connectors/whatsapp/pair` | start pairing, return QR string | no |
| `POST /connectors/whatsapp/gate` | `{enabled}` outbound toggle | no |
| `POST /connectors/whatsapp/disconnect` | unlink device, delete session | no |

Model tools are not HTTP routes; they are registry tools (D4/D6) and run
inside a `/prompt` run like every other tool.

## 6. Durability matrix

| Event | Gmail tokens | WhatsApp pairing | Model tools after |
|---|---|---|---|
| Idle pause (L0) | kept (store on volume) | kept | work after resume |
| `docker stop` (L1) | kept | kept | work after restart |
| Eviction + reprovision (L2) | kept (per-user volume, RFC 0002) | kept | work after recreate |
| `dev.sh reset` | gone | gone | connector gone |
| Google refresh refused | status `error` | — | honest "reconnect" error |
| whatsmeow session expiry (~14–20 d) | — | status `error: pairing expired` | honest "re-pair" error |
| Connector not in `CONNECTORS` | not installed | not installed | section omitted |

## 7. Threat model

The starring risk is the **lethal trifecta** (private data + untrusted
instructions + outbound egress — the exact combination the `whatsapp-mcp`
README warns about): a prompt-injected instruction could try to make the
model exfiltrate mailbox or chat content, or spam sends.

| Threat | Mitigation in v1 | Residual |
|---|---|---|
| Model exfiltrates mail/chat content via a tool call | content only enters as tool results; egress from the sandbox is the model API (same as today); per-run op budget caps volume | prompt injection remains the platform-wide open problem; connector egress allow-listing is §12 |
| Model reads tokens via `bash` (same UID, same container) | tokens in `/data`, never `WORKSPACE`; not referenced by any path the prompt mentions | **accepted residual**: `bash` can `cat /data/connectors.sqlite`. This is the user's own per-user token in a per-user container — not RFC 0004's shared platform key. The gateway (§12) closes it fully |
| Send abuse (spam, wrong recipient) | write gate off by default; `gmail_send` behind the `send` tier; send-guard dedupe; every send in the trace | no per-message human approval in v1 (deliberate: Grok ships drafts-not-sends; our `draft` tier is the same offer, `send` is an explicit user opt-up) |
| OAuth phishing (model fabricates a consent URL) | consent URLs are issued only by the panel route; the section tells the model it cannot produce them | — |
| QR/session hijack | QR string leaves only via `GET /connectors/whatsapp/pair` to the panel; never in tool results, traces, or chat | — |
| Platform client secret theft | `SECRET_DIR` file, read at exchange time only, same tier as model keys today | same residual as model keys until RFC 0004's gateway exists |

The Grok comparison, for the record: Grok Bot shares one cloud computer —
browser sessions, files, CLI credentials — across every bot on the account,
and documents that this is not a security boundary. This RFC's per-sandbox
connector state is a real boundary: one user, one container, one volume, and
the model surface is operations-only.

## 8. E2E and unit tests

- **Unit (agent):** store lifecycle (handshake create/verify/reap, tier
  upgrade = reconnect); PKCE verifier/S256 correctness against a fixed
  vector; tier enforcement matrix (every tool × tier × gate state); redaction
  rules of D8; send-guard dedupe; per-run budget. Gmail client tested
  against a fake `fetch` (recorded token + message responses); bridge client
  against a stub HTTP server on loopback.
- **E2E (`e2e-test/run.sh`, through Caddy at `localhost:18080` only):**
  with no client secrets configured — `GET /connectors` lists both as
  `available`, Gmail connect start returns a structured "not configured"
  error, WhatsApp tools absent from behavior (a prompt asking to read mail
  yields an honest cannot-connect answer, not a fabricated one). With the
  faux provider, a scripted connect against a fake OAuth/token/message
  endpoint mounted on the sandbox's own loopback exercises the full
  handshake → search → read → draft path. No new compose service; the fake
  runs in the agent container's network namespace only when a test env var
  points the client base URLs at it.
- **Gate:** `cd agent && npm run typecheck && npm test` with the new test
  files added to the `test` script; `./verify.sh` at the end since the
  manager (`create_args`) and the image change.

## 9. Honest limitations (documented, not hidden)

- **whatsmeow is an unofficial protocol implementation.** Meta does not
  guarantee companion-device API stability and can ban numbers that automate
  it. This connector is for the user's own number in dev/research
  deployments; the Business Cloud API (§12) is the compliant production
  path.
- **Re-pairing every ~14–20 days** is a whatsmeow reality; the panel states
  it at pairing time.
- **No per-message human approval loop** in v1. The draft tier and the
  default-off write gate are the offered middle ground.
- **Gmail API quota** is per OAuth client; a deployment-wide client shared by
  all sandboxes pools that quota — acceptable at dev scale, another reason
  §12 exists.

## 10. Implementation order

1. `agent/connectors/store.ts` + tests (D2) — no behavior change yet.
2. Connector extension skeleton: section, not-connected errors, budget
   wrapper (D4 shape) — prompt grows only when `CONNECTORS` is set.
3. Gmail client + routes + fake-fetch tests (D3, D7, D8).
4. Bridge: Dockerfile stage, child-process supervision, pair/status routes,
   loopback stub tests (D5).
5. WhatsApp tools + gate (D6).
6. Manager env forwarding + `.env.example` (D9).
7. Frontend panel (D10).
8. E2E + README claims update (§11) + `./verify.sh`.

## 11. README claims to update in the same change

- New: sandboxes can connect the user's Gmail (tiered OAuth) and WhatsApp
  (QR pairing) through a Connectors panel; connector state survives
  pause/stop/eviction; all connector routes are non-activating.
- New: every connector operation is recorded in the durable trace.
- Unchanged: idle pause, resume, `/inspect`, per-user provisioning claims.

## 12. Future work (explicitly out of scope)

- **Connector gateway** (RFC 0004 symmetry): move token storage and API
  calls out of the sandbox into a per-user or shared gateway service; the
  sandbox keeps only a scoped capability. Closes the `bash` residual of §7
  and makes multi-tenant OAuth client pooling possible.
- **WhatsApp Business Cloud API** connector as the compliant production
  alternative to whatsmeow.
- **Google Calendar** connector (the tiered-scope machinery of D3/D7 is
  designed to be reused by `calendar.readonly` → `calendar.events`).
- **Connector egress allow-listing**: restrict sandbox outbound traffic to
  the model API + connector endpoints, now that the connector set makes the
  destination list finite.
- **Per-connector MCP compatibility**: expose the same operations as an MCP
  server for external clients (the Grok "custom MCP connector" direction) —
  the operations-only surface makes this a wrapper, not a redesign.
