# Provider configuration surface (machine callers)

**Audience:** worldGraph / KG team, or any partner UI that lets its users
configure the model behind their affido sandbox.

**Status:** exposed, tested (`e2e-test/providers.sh`). No new API is required:
these are the exact endpoints the affido web app calls from Settings -> AI
provider (RFC 0012 §5.3, §7.14). The partner owns how it collects the values;
affido owns what happens to them.

---

## 1. What this surface is (and is not)

One per-user, write-mostly surface for BYOK (bring your own key):

- it stores a provider key, sets the selection, and applies it to the user's
  sandbox on the next request;
- it never creates, starts, inspects or deletes a sandbox, and it is not a
  prompt endpoint — prompts stay on `POST /u/<user_id>/prompt`;
- it never returns a key, only a fingerprint. There is no read-key endpoint,
  for any caller;
- it is not the machine identity surface. Registration/login stay on
  `/identity/*` (RFC 0023); this surface assumes the user already has a
  better-auth session.

The identity of every call is the **better-auth session cookie**. There is no
token for this surface on the gateway path, and a body/query `user_id` is never
trusted. In particular: `X-Identity-Key` (the scoped key that opens
`/identity/*`) does not open `/providers/*`, and no caller outside the Docker
network can use `X-Manager-Token` — Caddy's route is session-only.

---

## 2. Transport and auth rules

Only the gateway: `{AFFIDO_BASE_URL}/providers/*`, i.e. Caddy. Do not dial the
manager or a sandbox. Caddy runs `forward_auth` against `/whoami` **before** the
proxy hop, so a request without a valid session is rejected before it can reach
a write handler.

| Rule | Detail |
|---|---|
| Cookie | Forward the user's `better-auth.session_token` (or `__Secure-better-auth.session_token`) verbatim. Accepts `name=value`; the name is not normalised. |
| Writes | `PUT`/`DELETE` must carry `Origin` (or `Referer`) equal to the gateway origin, scheme included: `http://localhost:18080` in dev, the public origin in production. This is the CSRF wall: `Origin` is a forbidden header in browsers, so it proves a server-to-server call. |
| No `user_id` | Do not send it. On a read, a `?user_id=` that differs from the cookie is `403`. On a write, a body `user_id` is ignored outright. |
| TLS | Production must terminate TLS at Caddy before exposing these endpoints. Plain HTTP on loopback is a dev-stack exception. |
| Key material | `apiKey` travels in the request body only. Never log it, never echo it, never store it in your session file beyond the request lifetime. Responses contain `fingerprint` (`sha256[:12]`), never the key. |

The affido web app reaches the same routes from its own server with
`Cookie: <session>` and `Origin: ${SANDBOX_GATEWAY_URL}`; this is the shape to
replicate.

---

## 3. Endpoints

All responses are JSON. Errors on this surface use `{ "error": "<code>",
"message": "<human text>" }` — note the field is `error`, unlike `/identity/*`
which uses `{ "code": ... }`.

### 3.1 `GET /providers/catalog`

Auth: session. Returns the catalog generated from the agent image; it is what
your provider/model pickers should render, so ids always match what the agent
accepts.

```json
{
  "version": 1,
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com",
      "builtin": true,
      "models": [
        { "id": "deepseek-flash", "name": "DeepSeek V4.1 Flash", "reasoning": true },
        { "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro", "reasoning": true }
      ]
    }
  ]
}
```

Entries may carry extra operator fields (for example `validatePath` on
OpenRouter). Ignore what you do not render; the manager owns their meaning.
`builtin: false` entries are operator-provided endpoints; treat them like the
others, but a user-supplied custom endpoint is still `provider: "custom"`
(§3.3).

### 3.2 `GET /providers/config`

Auth: session. Returns the **desired** state. `Cache-Control: no-store`.

```json
{
  "selection": { "provider": "deepseek", "modelId": "deepseek-flash" },
  "keys": [
    {
      "provider": "deepseek",
      "fingerprint": "6b531e3845ab",
      "verified": true,
      "verifiedAt": "2026-11-09T21:04:11.203000+00:00"
    }
  ]
}
```

- `selection: null` means **no selection**: the sandbox runs the keyless faux
  provider (`faux-1`). That is a valid state, not an error — every new account
  starts there. A fresh account answers with `{"selection": null, "keys": []}`.
- `keys` is keyed by provider; `verified` is the outcome of the optional
  upstream check at write time (`validate: true`), not a live probe.
- `baseUrl` appears only for stored custom endpoints.

This endpoint answers from OLTP; it does not provision or wake a sandbox.

### 3.3 `PUT /providers/config`

Auth: session + `Origin`. Upserts a key when `apiKey` is present, sets the
selection, optionally validates the key upstream, and tries to apply it live to
the running sandbox.

Request:

```json
{
  "provider": "deepseek",
  "modelId": "deepseek-flash",
  "apiKey": "sk-...",
  "validate": true
}
```

| Field | Required | Rules |
|---|---|---|
| `provider` | yes | Catalog id, `"faux"`, or `"custom"`. |
| `modelId` | yes | 1-200 chars. For built-ins it must exist in that provider's catalog; for `faux` it must be `"faux-1"`; for `custom` it is free-form. |
| `apiKey` | conditional | 1-4096 chars. Required when selecting a real provider for which the user has no stored key. Omit it to keep the stored key (model-only change). Empty string is `400 invalid_api_key`. |
| `baseUrl` | custom only | HTTPS, host required, no userinfo/query/fragment, all DNS answers must be public. Built-ins take no `baseUrl`. |
| `validate` | optional | `true` performs `GET {base}/models` (or the catalog's auth-checked path) with the key before storing. Non-2xx is `400 invalid_key` and nothing is stored. Recommended for every new key. |

Semantics:

- `provider: "faux"` stores the keyless selection and ignores `apiKey`/
  `baseUrl`. Offer it as "default, no key".
- A key is encrypted with AES-256-GCM under the per-user KEK
  (`AAD = user_id || provider`) and delivered at resolve time to the user's
  sidecar; it is never written into the sandbox image, container env or disk.
- The selection is per user, not per conversation. Changing it keeps the
  conversation history; an in-flight prompt finishes on the old provider and
  the next run uses the new one.
- The response is the masked view plus `delivery`:

```json
{
  "selection": { "provider": "deepseek", "modelId": "deepseek-flash" },
  "keys": [{ "provider": "deepseek", "fingerprint": "6b531e3845ab", "verified": true, "verifiedAt": "2026-11-09T21:04:11.203000+00:00" }],
  "delivery": "delivered"
}
```

`delivery` is best-effort: `delivered` (running sandbox reconciled now),
`no_sandbox` (first request will provision), `sandbox_stopped` (next request
starts it), or `pending: <code>` (a later resolve retries; the write already
succeeded). `GET /providers/config` does not include `delivery`.

A real provider is refused with `400 egress_blocked` when the deployment runs
`AGENT_EGRESS != open`; nothing is stored. Fail closed is intentional: no
silent fallback to faux.

### 3.4 `DELETE /providers/config`

Auth: session + `Origin`. Always clears the selection; optional query:

- `?provider=<id>` also revokes that provider's stored key;
- `?all=1` drops the selection and every stored key (account-deletion cascade).

Returns the masked view plus `delivery`, like `PUT`. Idempotent. After any
`DELETE` the agent falls back to faux on the next request — tell the user that
explicitly, especially when they revoke the key that was active.

---

## 4. The state model your UI should show

There are two states, and they can differ for one request:

1. **Desired** — `selection` from `GET /providers/config`.
2. **Runtime** — what the sandbox is actually running, from
   `GET /u/<user_id>/status` (`model.provider`, `model.modelId`, `keyVia`).

The runtime call goes through `resolve`, so it can provision/wake a sandbox;
use it after a save or in the chat header, not on every page load. `GET
/providers/config` is cheap and side-effect free.

Display rules that avoid the failure this integration already hit (a user
asked a question and got `ls -la` output back):

| Desired (`selection`) | Runtime (`model.provider`) | Show |
|---|---|---|
| `null` | `faux` | "No key configured — the agent runs the deterministic faux provider and does not answer from a model." Do not present this as a working AI. |
| set | same provider | "Active: `<provider>` / `<modelId>`" (with the key fingerprint/verified badge when stored). |
| set | `faux` or another provider | "Saved, applying on the next request" (`delivery` was pending / sandbox stopped). |

A key can exist without being selected (the `keys` list).

---

## 5. Client-side rules the manager does **not** enforce

These are gates the affido Settings page applies; a partner UI must apply the
same ones or it can store a state that fails at prompt time.

1. **Key required before selecting a real provider.** The manager accepts
   `{provider, modelId}` without `apiKey`, but if the user has no stored key for
   that provider the agent will have no credential and the prompt fails
   upstream. Require the key, or require that `GET /providers/config` already
   lists it.
2. **Only send `apiKey` when the user typed one.** Omit it to keep the stored
   key when only the model changes.
3. **Never send an empty `apiKey`.** Drop the field instead (`400` otherwise).
4. **Validate new keys** (`validate: true`) unless the upstream is known to
   reject the check; surface `invalid_key` as "the provider rejected this key".
5. **Custom endpoints**: enforce HTTPS and a public host in the UI; the manager
   re-checks and rejects private/Docker addresses (`invalid_base_url`).
6. **After `DELETE`**, reload `GET /providers/config` and say that the agent
   fell back to faux.

---

## 6. Examples

```bash
BASE=${AFFIDO_BASE_URL:-http://localhost:18080}
COOKIE='better-auth.session_token=<user session>'

# catalog and desired state
curl -s -H "Cookie: $COOKIE" "$BASE/providers/catalog"
curl -s -H "Cookie: $COOKIE" "$BASE/providers/config"

# store a key and select it (validate performs a real upstream check)
curl -s -X PUT -H "Cookie: $COOKIE" -H "Origin: $BASE" \
     -H 'content-type: application/json' \
     -d '{"provider":"deepseek","modelId":"deepseek-flash","apiKey":"sk-...","validate":true}' \
     "$BASE/providers/config"

# change only the model, keeping the stored key
curl -s -X PUT -H "Cookie: $COOKIE" -H "Origin: $BASE" \
     -H 'content-type: application/json' \
     -d '{"provider":"deepseek","modelId":"deepseek-v4-pro"}' \
     "$BASE/providers/config"

# back to the keyless default
curl -s -X PUT -H "Cookie: $COOKIE" -H "Origin: $BASE" \
     -H 'content-type: application/json' \
     -d '{"provider":"faux","modelId":"faux-1"}' \
     "$BASE/providers/config"

# revoke a key (also clears the selection)
curl -s -X DELETE -H "Cookie: $COOKIE" -H "Origin: $BASE" \
     "$BASE/providers/config?provider=deepseek"

# runtime truth after a save
curl -s -H "Cookie: $COOKIE" "$BASE/u/<user_id>/status"
```

---

## 7. Errors

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_json` | body is not a JSON object |
| 400 | `invalid_provider` | provider id is malformed |
| 400 | `unknown_provider` | provider is not in the catalog |
| 400 | `invalid_model` | model id missing/malformed, unknown for that catalog, or `faux` != `faux-1` |
| 400 | `invalid_api_key` | `apiKey` sent but not a string of 1-4096 characters |
| 400 | `invalid_base_url` | non-HTTPS, private host, bad shape, or a `baseUrl` on a built-in |
| 400 | `invalid_key` | `validate: true` and the upstream rejected the key |
| 400 | `validation_failed` | `validate: true` and the upstream did not answer |
| 400 | `egress_blocked` | real provider while `AGENT_EGRESS != open`; stores nothing |
| 401 | `unauthorized` | no/expired session (Caddy `forward_auth` also answers 401) |
| 403 | `forbidden` | write without a matching `Origin`; read with a mismatched `?user_id` |
| 503 | `kek_unavailable` | the per-user key encryption key is unavailable; fail closed |
| 503 | `catalog_unavailable` | the agent image has no catalog; rebuild it |
| 500 | `invalid_catalog` | the catalog entry's validation path is malformed |
| 500 | `internal` | unexpected write failure |

Validation failure stores nothing (§7.2): `validate: true` is TOCTOU-safe and
the key remains absent rather than unverified.

---

## 8. Verification

`e2e-test/providers.sh` already proves, through Caddy: catalog contents, 401
without a session, the egress gate, custom-URL rules, the Origin wall, the
masked-view round-trip, `no-store`, session binding (cross-user read `403`,
body `user_id` ignored), the token-only trusted path, and the peer guard
(a sandbox calling `/providers/*` is `403`).

Minimal contract check for a partner:

1. `GET /providers/catalog` **without** a cookie → `401`.
2. `GET /providers/config` with a cookie → `200`, `selection` and `keys`.
3. `PUT` with a cookie but no `Origin` → `403`.
4. `PUT` with a cookie and `Origin: <gateway>` and `{"provider":"faux",
   "modelId":"faux-1"}` → `200`, `selection.provider == "faux"`, `keys == []`.
5. `GET /u/<user_id>/status` after step 4 → `model.provider == "faux"`.
6. `DELETE /providers/config` → `selection == null`.

The reference implementation of the client side is
`frontend/src/lib/server/providers.ts` (gateway and trusted-caller modes);
the server side is `sandbox_manager.py` (`providers_get`, `providers_put`,
`providers_delete`, `reconcile_provider`), with the route in
`caddy/Caddyfile` (`@providers`) and the contract in RFC 0012 §5.3.
