# RFC 0004 — Multi-tenant LLM API keys for durable sandboxes

| Field | Value |
|---|---|
| Status | Draft |
| Author | pi-durable containers maintainers |
| Date | 2026-10-19 |
| Target | `sandbox-manager/`, new `llm-gateway/`, `agent/model.ts`, `docker-compose.yml` |
| Related | RFC 0003 (`docs/rfc/0003-python-sandbox-manager.md`), `agent/model.ts`, `sandbox-manager/sandbox_manager.py` |

## 1. Summary

Two facts first.

**How keys are handled today.** The agent reads a provider key from a file under
`SECRET_DIR` (default `/run/secrets`) at process start, puts it in an
`InMemoryCredentialStore`, and uses it directly against the provider
(`agent/model.ts`). The key is not in an environment variable. Selection is
`openrouter_api_key` → `openai_api_key` → the keyless faux provider.

**What the sandbox manager uses at provisioning.** Nothing. `create_args()` in
`sandbox_manager.py` forwards no key and no `*_MODEL` variable, so as shipped,
manager-created sandboxes run the faux provider. There is one legacy
escape hatch: if `AGENT_SECRETS_DIR` is set, the manager bind-mounts that one
host directory read-only at `/run/secrets` into **every** sandbox. That path is
single-tenant by construction: one key shared by all users, no rotation, no
per-user binding, and the key is readable from inside the sandbox.

**Proposal.** Keep the key out of the sandbox entirely. Put a pool of keys in
the OLTP, bind one key to each sandbox as a **durable lease** in Postgres, and
inject the key at request time in a new `llm-gateway` service. The sandbox gets
a gateway URL and a per-sandbox token — a scoped capability, not the provider
key. The manager selects the lease; it never sees plaintext key material.

Rotation becomes a property of lease creation: with 10 keys, sandboxes 1–10 get
keys 1–10, sandbox 11 reuses key 1, and so on. Existing leases are never
reshuffled. Because the lease is keyed by `user_id` and not by container, a
sandbox that pauses, stops, or is recreated comes back on the same key.

## 2. How it works today

### 2.1 Agent side

```
sandbox start
  └─ server.ts
       └─ createModel()
            ├─ readSecret("openrouter_api_key")  -> OPENROUTER_MODEL required
            ├─ readSecret("openai_api_key")      -> OPENAI_MODEL required
            └─ fauxProvider()                    -> no key needed
```

Facts that matter for this RFC:

- The key is a **file**, not an env var. This is already the right instinct:
  env vars leak through `docker inspect`, `/proc/<pid>/environ`, and crash
  dumps.
- `readSecret()` returns `undefined` for an empty file, so an empty placeholder
  keeps the faux provider.
- The provider choice is made **once at process start**. The key lives in the
  agent process memory for the lifetime of the process, and the agent's own
  `bash` tool runs in that same container and under the same UID.
- Putting a key file in the container does **not** hide it from the agent. A
  concrete trace:
  ```
  docker exec u<slug> bash -lc 'cat /run/secrets/openrouter_api_key'
  ```
  prints the key. That command is exactly the kind of command the model can run
  through the `bash` tool. Deleting the file after boot does not create a
  boundary either: the key remains in agent memory, same UID, same container.

### 2.2 Manager side

`create_args()` currently builds:

```
docker create ... \
  -e AGENT_NAME=... -e WORKSPACE=/workspace -e SESSION_DB=/data/session.sqlite \
  -e IDLE_MS=... -e PORT=8080 \
  [-v $AGENT_SECRETS_DIR:/run/secrets:ro] \
  pi-durable-agent:latest
```

- Compose does not set `AGENT_SECRETS_DIR`, so the default is the faux provider
  (`.env.example` documents this).
- When it is set, **all** sandboxes mount the **same** directory. One key, N
  tenants, no accounting, no revocation.
- The mount is fixed at `docker create`; the container environment is fixed at
  `docker create`. There is no per-sandbox key and no way to change a key for
  one sandbox without recreating it.
- Enabling it today also fails at boot: `create_args()` does not forward
  `OPENROUTER_MODEL`/`OPENAI_MODEL`, and `createModel()` throws
  `"OPENROUTER_MODEL is required when the openrouter_api_key secret is set"`.
  This path is effectively untested.

### 2.3 Why this cannot be extended to multi-tenant

| Requirement | Today |
|---|---|
| Different key per sandbox | No: one mounted directory for all |
| Rotate through a pool of 10 | No: no pool, no selection |
| Binding survives pause/stop/restart | No binding exists |
| Key not readable from the sandbox | No: `bash` can read `/run/secrets` |
| Per-tenant attribution and limits | No |
| Revoke one tenant without touching others | No |

## 3. Requirements and threat model

Requirements:

1. **R1 — Pool and rotation.** N keys per provider; leases are spread
   round-robin. With N=10, the first 10 sandboxes use distinct keys and the
   next 10 reuse them.
2. **R2 — Durable binding.** A sandbox keeps its key across L0 pause, L1
   `docker stop`, `docker restart`, and container recreation. The binding is
   part of the durable sandbox record.
3. **R3 — No key material in the sandbox.** The provider key must not appear in
   the sandbox filesystem, environment, image, or agent process memory.
4. **R4 — Manager selects, agent does not.** The manager chooses the lease at
   provisioning; the agent does not choose or read a key.
5. **R5 — Rotation and revocation without fleet-wide recreation.** Adding,
   draining, or revoking a key must not require recreating every sandbox.
6. **R6 — Attribution and limits.** Requests are attributable to a `user_id` and
   a key, with per-lease concurrency/rate limits.
7. **R7 — No new exposed surface.** No new published ports; the gateway sits on
   the internal Docker networks.
8. **R8 — Tests stay keyless.** The faux provider remains the default for
   `verify.sh` and the e2e suite.

Threat model: the user controls `bash` inside the sandbox. They can read files,
environment, and their own process memory; they can make arbitrary network calls
from the sandbox; they can call the gateway. They cannot access the Docker
socket or the host. The design must prevent them from obtaining the provider
key, using another tenant's lease, or sending the key outside. Compromise of the
host, the Docker daemon, or the manager is out of scope (those are already
root-equivalent).

## 4. Design

### 4.1 Components

```
             provisioning (rare)                        each model request
  manager ── lease(key_id) ──> OLTP                 agent ── token ──> llm-gateway ── key ──> provider
     │                          │                         ▲                 │
     │ docker create/start      │ llm_key                 │                 │ decrypt with KEK
     └── env: gateway URL,      │ llm_key_lease           │                 │ (gateway-only secret)
         sandbox token, model   └─────────────────────────┘                 └── OLTP lookup
```

| Component | Owns | Never sees |
|---|---|---|
| `sandbox-manager` | lease selection, sandbox token generation, container lifecycle | provider key plaintext, KEK |
| `llm-gateway` | token → lease lookup, key decryption, header injection, quotas, upstream allowlist | — (trusted credential broker) |
| `oltp` | `llm_key` ciphertext, `llm_key_lease`, usage ledger | KEK |
| sandbox agent | gateway URL, scoped sandbox token, model id | provider key, KEK, ciphertext |

The manager keeps its existing DB credentials, so it can read the `llm_key`
rows, but it cannot decrypt them: the KEK is mounted only into the gateway.

### 4.2 Data model

```sql
CREATE TABLE llm_key (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,                 -- 'openrouter' | 'openai' | ...
  label          text NOT NULL UNIQUE,          -- 'openrouter-01'
  ciphertext     bytea NOT NULL,                -- AES-256-GCM, AAD = id || provider
  nonce          bytea NOT NULL,
  kdf_version    int  NOT NULL DEFAULT 1,
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','draining','revoked')),
  last_leased_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);

CREATE TABLE llm_key_lease (
  user_id      text NOT NULL REFERENCES sandbox_registry(user_id) ON DELETE CASCADE,
  provider     text NOT NULL,
  key_id       uuid NOT NULL REFERENCES llm_key(id),
  token_hash   bytea NOT NULL UNIQUE,           -- sha256(sandbox token)
  leased_at    timestamptz NOT NULL DEFAULT now(),
  rekeyed_from uuid REFERENCES llm_key(id),
  PRIMARY KEY (user_id, provider)
);

CREATE INDEX llm_key_lease_key_idx ON llm_key_lease (key_id);

-- Attribution and quotas. No FK on user_id: the ledger outlives the user.
CREATE TABLE llm_usage_daily (
  day               date   NOT NULL,
  user_id           text   NOT NULL,
  provider          text   NOT NULL,
  key_id            uuid   NOT NULL REFERENCES llm_key(id),
  requests          bigint NOT NULL DEFAULT 0,
  prompt_tokens     bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, provider)
);
```

Invariants:

1. **One active lease per `(user_id, provider)`.** The primary key enforces it.
   The lease is tied to the durable sandbox identity, not to a container.
2. **Only ciphertext at rest.** `ciphertext` is written by the `keys` CLI and
   read only by the gateway. No table stores a plaintext key.
3. **`token_hash` is a hash.** The manager generates the token, stores only
   `sha256(token)`, and passes the plaintext to the container at create time.
4. **Only the manager writes leases.** The gateway reads them. One writer per
   field, consistent with RFC 0003's registry ownership.
5. **Deleting a user releases the lease.** `ON DELETE CASCADE` from
   `sandbox_registry`; the key returns to the pool for future leases.
6. **Usage is additive and body-free.** The gateway upserts `llm_usage_daily`
   from the provider's `usage` block; it stores no prompt or completion text.

### 4.3 Leasing and rotation

Leasing happens only when a sandbox gets its first lease or needs a replacement
key. It is serialized by one transaction-scoped advisory lock, so the order is
deterministic. Provisioning is low-QPS; serializing the pool is cheap.

```python
def lease(user_id: str, provider: str, *, rotate_token: bool = False):
    """Return (key_id, token). token is plaintext only when it was (re)generated."""
    with db() as conn, conn.transaction():
        row = get_lease(conn, user_id, provider)
        if row and row.key_active and not rotate_token:
            return row.key_id, None          # idempotent: keep the binding

        conn.execute("SELECT pg_advisory_xact_lock(hashtext('llm-key-pool'))")
        row = get_lease(conn, user_id, provider)  # re-read under the lock
        if row and row.key_active:
            if not rotate_token:
                return row.key_id, None
            token = secrets.token_urlsafe(32)
            update_lease_token(conn, user_id, provider, sha256(token))
            return row.key_id, token

        key = conn.execute(
            """
            SELECT k.id
            FROM llm_key k
            LEFT JOIN llm_key_lease l ON l.key_id = k.id
            WHERE k.status = 'active' AND k.provider = %s
            GROUP BY k.id
            ORDER BY count(l.user_id), k.last_leased_at NULLS FIRST,
                     k.created_at, k.id
            LIMIT 1
            """,
            (provider,),
        ).fetchone()
        if key is None:
            raise PoolExhausted(provider)

        if row is None:
            token = secrets.token_urlsafe(32)
            insert_lease(conn, user_id, provider, key.id, sha256(token))
        else:
            # Re-key: move the lease to a live key and record the old one, keep
            # the sandbox token unless the container was recreated.
            update_lease_key(conn, user_id, provider, key.id)  # rekeyed_from = old id
            token = None
            if rotate_token:
                token = secrets.token_urlsafe(32)
                update_lease_token(conn, user_id, provider, sha256(token))

        conn.execute("UPDATE llm_key SET last_leased_at = now() WHERE id = %s", (key.id,))
        return key.id, token
```

`rotate_token=True` is used only by the recreate/repair path (§4.4). Normal
resolve calls do not touch the token.

The selection rule is **least live leases, then least recently leased, then
oldest key**. It produces exactly the requested rotation and self-balances when
keys are added or drained.

Example with 10 keys and 25 sandboxes, one provider:

| sandbox | key | live leases on that key after the assignment |
|---|---|---|
| u1 … u10 | K1 … K10 | 1 each |
| u11 | K1 | 2 |
| u12 | K2 | 2 |
| … | … | … |
| u20 | K10 | 2 |
| u21 | K1 | 3 |
| … | … | … |
| u25 | K5 | 3 |

So `u11` reuses `u1`'s key, `u12` reuses `u2`'s, and every key ends up with at
most `ceil(25/10)=3` tenants. The first 10 are distinct, and the mapping repeats
with period 10 as long as the pool does not change. No sandbox is moved when a
new sandbox is added.

`draining` keys are excluded from new leases but keep serving their existing
leases. `revoked` keys are excluded from both: the next `/resolve` sees the
lease pointing at a non-active key, leases a live key, updates the row
(`rekeyed_from` records the old one), and keeps the same sandbox token. The
agent does not notice.

### 4.4 Durable binding across sleep and restart

| Event | Container | Lease row | Key seen by the gateway |
|---|---|---|---|
| L0 pause (`IDLE_MS`) | same process, harness closed | unchanged | same |
| L1 stop (`STOP_AFTER_S`) | stopped, `/data` keeps the session | unchanged | same |
| `docker start` / next request | same container, same env | unchanged | same |
| manager `docker rm` + reprovision | new container, new token | row kept, token hash rotated | same `key_id` |
| key revoked | untouched | row points at the new `key_id` | new key |
| user deleted | removed | cascade-deleted | released to the pool |

The sandbox never stores the key, so there is nothing to lose on sleep. The
binding is a row keyed by `user_id`; `docker inspect` contains only the gateway
URL, the model id, and the scoped token.

On `docker rm` the manager cannot recover the old plaintext token (it stores
only the hash), so it generates a new token, updates `token_hash`, and passes
the new value to the new container. The key lease is unchanged.

### 4.5 Request path

The agent is configured with:

```
LLM_GATEWAY_URL=http://llm-gateway:8099
LLM_GATEWAY_TOKEN=<per-sandbox token>      # capability, not the provider key
OPENROUTER_MODEL=<model id>
```

The provider's base URL becomes
`http://llm-gateway:8099/openrouter/api/v1`. A request is handled as follows:

```
POST /openrouter/api/v1/chat/completions
Authorization: Bearer <sandbox token>

gateway:
  1. provider = path segment; reject unknown providers
  2. allowlist method + path (chat/completions, embeddings, models, models/user)
  3. token_hash = sha256(token); look up llm_key_lease JOIN llm_key
  4. provider in path must equal lease.provider            -> else 403
  5. strip inbound Authorization / x-api-key / api-key
  6. decrypt key (cached), set Authorization: Bearer <provider key>
  7. forward to https://<provider base>/<rest>, stream the response
  8. ledger: user_id, key_id, model, status, usage (no prompt/body)
```

The upstream host comes only from the gateway's provider table. A request cannot
name a host, and an optional `LLM_ALLOWED_MODELS` list pins the model ids a lease
may use. That is the SSRF boundary: the sandbox can call the provider endpoints
through the gateway, but it cannot turn the gateway into a request forwarder or
spend the key on a model outside the allowlist.

Status codes:

| Case | Response |
|---|---|
| Missing/unknown token | 401 `unknown_sandbox_token` |
| Token valid, provider mismatch | 403 `provider_mismatch` |
| Lease points at a revoked key | 503 `key_unavailable` (next `/resolve` re-keys) |
| Pool empty at provisioning | manager returns 503 `key_pool_exhausted` |
| Per-lease concurrency/rate exceeded | 429 with `Retry-After` |
| Gateway down | agent surfaces 502 from the provider call |

The gateway is on the `agents` network and is attached to each per-user network
at provision time, exactly like Caddy and the manager. It publishes no port. It
does not need the Docker socket. A token copied out of the Docker network is
useless from the internet because there is no route to the gateway; invalid
tokens are rate-limited per source address.

The gateway caches `token_hash -> (lease, decrypted key)` for 30 seconds. A
`401/403` from the upstream invalidates the cache entry immediately, and a
gateway restart simply warms it from the OLTP again. A re-key (§4.4) is
observed on the next cache miss or on the first failed request, so the agent
never restarts because of a key change.

### 4.6 Agent change

`agent/model.ts` gets one branch before the secret-file branch:

```ts
const gateway = process.env.LLM_GATEWAY_URL;
if (gateway !== undefined) {
  const token = process.env.LLM_GATEWAY_TOKEN;
  const modelId = process.env.OPENROUTER_MODEL;
  if (!token || !modelId) throw new Error("gateway mode needs LLM_GATEWAY_TOKEN and OPENROUTER_MODEL");
  const provider = openrouterProvider();          // reuse the catalog and API implementation
  models.setProvider({ ...provider, baseUrl: `${gateway}/openrouter/api/v1` });
  await credentials.modify("openrouter", async () => ({ type: "api_key", key: token }));
  return { models, model: { provider: "openrouter", modelId } };
}
```

The exact override can be an optional `baseUrl` parameter on the provider
factory instead of an object spread; the RFC only requires that the provider
catalog and API implementation are reused and the URL is the gateway. The
OpenAI case mirrors it with `OPENAI_MODEL` and `/openai/v1`. The direct-file
branch stays for running the agent image standalone. The faux branch stays the
default when neither is set.

This is the only `agent/` change. No key material is read in gateway mode.

### 4.7 Key lifecycle

The `keys` CLI ships in the gateway image (it needs the KEK) and never prints a
plaintext key:

```
keys add --provider openrouter --label openrouter-01 < key.txt
keys list
keys drain  --label openrouter-01     # no new leases, existing keep working
keys revoke --label openrouter-01     # fail closed; next resolve re-keys
keys rekey  --from openrouter-01 --to openrouter-02
```

- `add`: reads a key from stdin, generates the UUID, encrypts with AES-256-GCM
  (`nonce = 12 random bytes`, `AAD = id || provider`), inserts the ciphertext.
  The plaintext never enters the shell history, the SQL log, or the audit log.
- `drain`: `status='draining'`. Use it before removing a key from the provider.
- `revoke`: `status='revoked'`, `revoked_at=now()`. Existing leases fail closed
  and are re-keyed on the next `/resolve`.
- `rekey`: one transaction moves every lease from one key to another, keeping
  each sandbox's token. This is how an operator rotates the fleet without
  recreating a single container.

The KEK is a 32-byte value in `secrets/llm_key_kek` (gitignored), mounted
read-only into the gateway only. `docker compose exec llm-gateway keys ...` (or
`docker compose run --rm llm-gateway keys ...` when the service is down) is the
intended admin path. The gateway refuses to start if the KEK is missing (fail
closed, never silently fall back to faux).

Operator runbook:

```bash
# create a KEK once, then keep it backed up
openssl rand -base64 32 > secrets/llm_key_kek
docker compose up -d llm-gateway
docker compose exec -T llm-gateway keys add --provider openrouter --label openrouter-01 < key.txt
# rotate: add K11, drain K1, then rekey K1 -> K11 and revoke K1
```

## 5. Implementation sketch

| File | Change |
|---|---|
| `sandbox-manager/sandbox_manager.py` | add `llm_key`/`llm_key_lease` schema; `lease()` selection; generate token and store hash; forward `LLM_GATEWAY_URL`, `LLM_GATEWAY_TOKEN`, `OPENROUTER_MODEL` in `create_args()`; connect the gateway to each per-user network; re-key on resolve when the lease key is not active; rotate token on recreate |
| `llm-gateway/` | new small service (Python stdlib + `psycopg` + `cryptography`): token lookup, decrypt, allowlist, inject, stream, ledger, `/healthz`, token-gated `/metrics` |
| `agent/model.ts` | gateway branch (§4.6); existing file/faux branches unchanged |
| `docker-compose.yml` | `llm-gateway` service on `agents`, no published port, KEK secret, `LLM_GATEWAY_CONTAINER` passed to the manager |
| `.env.example` | `LLM_GATEWAY_PORT`, `LLM_GATEWAY_CONTAINER`, optional `LLM_MAX_INFLIGHT_PER_SANDBOX` |
| `scripts/keys` or gateway subcommand | admin CLI (§4.7) |
| `verify.sh` | add the keyless lease/gateway tests (§7); real-key e2e stays opt-in |
| `README.md` | replace "Use a real model" with the gateway flow and the pool |

`create_args()` becomes:

```python
args += [
    "-e", f"LLM_GATEWAY_URL=http://{LLM_GATEWAY_CONTAINER}:{LLM_GATEWAY_PORT}",
    "-e", f"LLM_GATEWAY_TOKEN={token}",
    "-e", f"OPENROUTER_MODEL={model}",
]
```

The legacy `AGENT_SECRETS_DIR` mount is removed from the manager path. It
remains usable only for running the agent image directly, where there is no
manager and no per-user isolation.

## 6. Migration

1. Run the two `CREATE TABLE`s (after `sandbox_registry` exists, because
   `llm_key_lease` references it). No backfill.
2. Add keys with `keys add`. The pool can be empty; nothing breaks until a
   sandbox is provisioned with gateway mode enabled.
3. Set `LLM_GATEWAY_CONTAINER` and the default provider/model in the manager.
   Without them the manager keeps the faux behavior, so existing tests and
   deployments are unchanged.
4. Existing sandboxes that predate the RFC have no `LLM_GATEWAY_TOKEN`. On the
   first `/resolve` in gateway mode, the manager detects the missing env in
   `docker inspect` and recreates the container with the same volumes and
   network; the lease is created lazily and the SQLite session is untouched.
5. Rollback: unset the gateway variables and recreate sandboxes. The lease rows
   are inert. Never copy key material into the sandbox as a rollback path.

## 7. Verification

The default gate stays keyless: a fake upstream server (a local HTTP server)
plays the provider and records the `Authorization` header.

**M1 — lease and rotation (no gateway).**
- Seed 10 keys, provision 25 users.
- Assert: the first 10 leases use 10 distinct keys; `u11` uses `u1`'s key;
  `u12` uses `u2`'s key; max live leases per key is 3.
- 20 parallel `/resolve` calls: 20 leases, one per user, and the least-loaded
  distribution still holds.
- A `draining` key receives no new lease. A revoked key's lease is moved on the
  next resolve, with `rekeyed_from` set and the token unchanged.

**M2 — durability.**
- Provision `u1`, record `key_id`; let L0 pause and L1 stop; resolve again:
  same `key_id`, same `token_hash`, same `conversationId` and `entries`.
- `docker rm` + resolve: same `key_id`, new `token_hash`, session intact.

**M3 — gateway.**
- Fake upstream sees `Authorization: Bearer <leased key>`, never the sandbox
  token, and never a client-supplied `Authorization`.
- Unknown token → 401; token for provider A on path B → 403; revoked key → 503;
  non-allowlisted path → 404; oversized body → 413; per-lease concurrency over
  the limit → 429.
- Streaming responses are not buffered.

**M4 — no key in the sandbox.**
- `docker exec u<slug> bash -lc 'grep -R "<key prefix>" /run/secrets /proc/1/environ /workspace /data'`
  returns nothing.
- `docker exec u<slug> bash -lc 'curl -s https://openrouter.ai/api/v1/models'`
  fails with 401: the sandbox cannot call the provider directly.
- The gateway logs contain no `Authorization` value and no request body.
- The manager process has no KEK and cannot decrypt the `llm_key` rows.

**M5 — real key (opt-in).**
- Add one real key, set the gateway variables, prompt through Caddy. The reply
  comes from the real provider; the fake upstream test is skipped. Then revoke
  the key and confirm the next prompt fails over to a second key without
  recreating the sandbox.

## 8. Alternatives considered

| Alternative | Verdict |
|---|---|
| Per-sandbox key file mounted at `/run/secrets` | **Rejected.** It fails R3: `bash` in the sandbox reads it. Deleting it after boot leaves it in agent memory under the same UID. |
| Per-sandbox env var | **Rejected.** Visible in `docker inspect`, `/proc/1/environ`, and crash output; fixed at create. |
| `hash(user_id) % pool_size` | **Rejected.** Deterministic only while the pool is fixed; adding or removing a key reshuffles every tenant and breaks the durable binding. Least-live-lease rotation self-balances without moving existing leases. |
| Per-sandbox sidecar proxy holding the key | **Viable but heavier.** Isolates the key per sandbox, but doubles the container count and places N plaintext copies instead of one broker. Keep as a fallback if a hard per-tenant network boundary is required. |
| Source-IP identity instead of a sandbox token | **Hardening option.** Removes even the scoped token from the sandbox, at the cost of mapping `(gateway interface, source IP)` to a lease and dropping `NET_RAW` to prevent spoofing. The token is not the provider key, so v1 keeps the simpler token. |
| Direct provider keys minted per sandbox by the provider | **Future refinement.** If the provider offers programmatic key minting, `llm_key_lease` can hold the provider key id and the gateway still brokers requests. The pool remains the fallback. |

## 9. Risks

| Risk | Mitigation |
|---|---|
| One shared key hits the provider's rate limit and affects its whole lease group | Least-live-lease distribution, per-lease concurrency/rate limits, `429` backoff per key, `keys drain` to stop new leases, `keys rekey` to move tenants |
| A leaked key is used outside the gateway | Revoke at the provider and in `llm_key`; affected leases fail closed and re-key on the next resolve; the gateway never logs the key |
| Gateway is a new single point of failure on the model path | Stateless process over Postgres plus an in-memory key cache; agent returns 502 without corrupting the session; retry the prompt |
| Gateway sees prompts in plaintext | No body logging; internal Docker network only; no published port; upstream over HTTPS. It is a trusted component, not a sandbox |
| KEK compromise exposes the whole pool | KEK only in the gateway; rotation re-encrypts ciphertexts under a new `kdf_version`; back up the KEK offline |
| Sandbox token leaks to the user | It is a scoped capability: one lease, allowlisted paths, quotas, no provider key. Rotate it by recreating the container (new `token_hash`) |
| Upstream error body echoes credentials | The gateway never forwards upstream response headers verbatim and never logs bodies; a test asserts the key prefix is absent from gateway logs |
| Gateway parsing bugs (path traversal, request smuggling) | Strict allowlist on the normalized path, reject encoded/absolute URLs and `CONNECT`, cap headers and body size, no host from the request |
| Pool empty | Provisioning fails with `key_pool_exhausted`; the sandbox stays `error`; no silent fallback to faux in production |
| Shared keys prevent provider-side per-user billing | The gateway ledger attributes requests and usage to `user_id`; provider invoices remain per key. If per-user invoicing is required, use per-tenant keys (BYOK) later |

## 10. Non-goals

- A billing system. The ledger is for quotas and attribution, not invoicing.
- Per-user BYOK. The lease table can grow a `source` column for it later.
- Prompt confidentiality from the gateway. The gateway is trusted infrastructure.
- Provider-side key minting. The pool works with ordinary static keys.
- Changing `pi-durable` durability. The lease lives in the existing OLTP; the
  agent's SQLite remains the session checkpoint.

## 11. Open questions

1. **Hard cap per key.** Should the pool refuse a lease once a key reaches
   `ceil(N)` leases, or keep sharing to preserve availability? v1 warns and
   keeps sharing; a cap is a one-line policy change.
2. **Token vs source-IP identity.** v1 uses a per-sandbox token in the
   environment, which the sandbox can read. It is not the provider key. If the
   requirement is literally "no credential material in the sandbox", adopt the
   source-IP variant and drop `NET_RAW`.
3. **Multi-provider leases.** The table is keyed by `(user_id, provider)`, but
   the agent currently runs one provider at a time. A second provider needs a
   second token or a token that resolves to multiple leases.
4. **Automatic revocation.** Should the gateway mark a key `revoked` after N
   consecutive `401/403` responses, or only alert? Auto-revoke is faster but can
   be triggered by transient provider errors.

## 12. Milestones

1. **M1 — schema and lease.** Tables, `lease()`, pool-lock serialization,
   rotation tests. No gateway, no agent change.
2. **M2 — gateway with a fake upstream.** Token lookup, decryption, allowlist,
   header injection, streaming, 401/403/503/429 tests.
3. **M3 — manager integration.** Token generation, `create_args()` env, gateway
   network attach, lazy lease on resolve, one-time recreate for old sandboxes.
4. **M4 — agent gateway branch.** `model.ts` override; the direct-file and faux
   branches still pass their tests.
5. **M5 — operations.** `keys` CLI, drain/revoke/rekey runbook, metrics, opt-in
   real-key e2e, README update.
