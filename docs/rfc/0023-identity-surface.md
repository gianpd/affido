# RFC 0023 — Machine identity surface on the gateway

| Field | Value |
|---|---|
| Status | Implemented |
| Author | Affido maintainers |
| Date | 2026-11-09 |
| Target | `sandbox-manager/`, `caddy/`, `frontend/` |
| Related | RFC 0003 (gateway/manager), RFC 0012 (BYOK runtime config), `docs/integration/affido-identity-request.md` |

## 1. Summary

The gateway gains four routes for server-to-server callers:

```
POST /identity/register   { email, password, name } -> 201 { user, session: { cookie } }
POST /identity/login      { email, password }       -> 200 { user, session: { cookie } }
POST /identity/logout     Cookie: ...               -> 204
GET  /whoami              Cookie: ...               -> 200 { user_id, email?, name? } | 401
```

They are implemented by `sandbox-manager`, gated by a scoped `X-Identity-Key`
(not `MANAGER_TOKEN`), and write `user` + `account` + `session` in one
transaction. The manager is the only writer of identity; the web app keeps
calling `auth.api.*` in-process. worldGraph can create graphs but cannot create
users, which is what this surface unblocks.

## 2. Why the manager writes identity

The manager already reads the session table (`user_from_session`), is Caddy's
`forward_auth` target, and owns the other OLTP writes. The alternatives both
fail:

- **better-auth over HTTP (`/api/auth/*`).** The app has no such route: better-auth
  is called in-process from `hooks.server.ts` and `+page.server.ts`, and Caddy
  has no web-app upstream (the compose stack has only `caddy`, `oltp`,
  `sandbox-manager`).
- **Hashing in the caller.** better-auth stores `salt:key` with the salt inside
  the stored value, so a caller cannot re-derive it at login. A transmitted
  pre-hash is a replayable credential, and a password reset would invalidate it
  anyway. The plaintext crosses worldGraph's process (TLS, server-to-server)
  and is hashed once, at the boundary that owns the DB.

Keeping the write in the manager also keeps the gateway the only door: no new
process, port, or DB grant.

## 3. Row layout

The schema is the web app's (`frontend/src/lib/server/db/auth.schema.ts`):
text primary keys, camelCase columns, no foreign keys. The manager does not
create these tables; it assumes the web app has run its migrations (rollout
step below). A missing table fails closed with `identity_unavailable`.

| Table | Values |
|---|---|
| `user` | fresh 32-char alphanumeric id, `name` trimmed, `email` lowercased, `emailVerified=false`, `image=NULL`, `createdAt/updatedAt=now()` |
| `account` | fresh id, `accountId=user.id`, `providerId='credential'`, `userId=user.id`, `password=salt:key`, timestamps |
| `session` | fresh id, 32-char token, `userId`, `expiresAt=now()+7d`, `ipAddress`/`userAgent` from the request, timestamps |

`POST /identity/logout` deletes only the row whose token matches the presented
cookie. `GET /whoami` reads the DB on every call; a cached answer would defeat
revocation.

## 4. Crypto parity with better-auth

The manager emits better-auth's formats, not a facsimile. Both vectors below
are tested in `sandbox-manager/test_sandbox_manager.py` and against
`better-auth/crypto` in `frontend/src/lib/server/identity-compat.spec.ts`.

### 4.1 Password

`@better-auth/utils@0.5.0` (node path) uses
`scrypt(NFKC(password), salt = the hex string, N=16384, r=16, p=1, dkLen=64,
maxmem=128*N*r*2)` and stores `hex(salt):hex(key)`. Python's `hashlib.scrypt`
reproduces it byte for byte:

| input | value |
|---|---|
| password | `correct horse battery staple` |
| salt | `00112233445566778899aabbccddeeff` |
| hash | `00112233445566778899aabbccddeeff:f5b22309b28fe412c82a4b2cab57498b8f8a42c849af16cb908974048f61c13933421858db3a8f111430bdc493c7cef90f61f904061c77206e3820a2e8b11bc2` |

### 4.2 Cookie

`better-call`'s `serializeSignedCookie` computes
`base64(HMAC-SHA256(secret, token))`, appends it after a dot, and
`encodeURIComponent`s the whole value. The cookie name follows `ORIGIN`:
`__Secure-better-auth.session_token` for `https://`, the plain name for
`http://`.

| input | value |
|---|---|
| secret | `test-secret-0123456789abcdef` |
| token | `TOKENaaaaaaaaaaaaaaaaaaaaaaaaaaaa` |
| cookie | `better-auth.session_token=TOKENaaaaaaaaaaaaaaaaaaaaaaaaaaaa.Xq2d1kPZRjP0gBzmdZjnv64vU89%2F1WahS6ao%2FekCtfU%3D` |

## 5. Gating

Order matters and is covered by tests:

1. **Origin absent.** Any request carrying `Origin` is `403 forbidden_origin`.
   A browser always sends one on a cross-origin POST; worldGraph never does.
   Caddy must not strip the header, or this check would only protect direct
   callers.
2. **Scoped key.** `X-Identity-Key` compared with `hmac.compare_digest` against
   `IDENTITY_API_KEY` and, during rotation, `IDENTITY_API_KEY_PREVIOUS`. Keys
   shorter than 32 characters are ignored, so a weak value fails closed with
   401. The key is never read from a query string.
3. **Configuration.** Both `BETTER_AUTH_SECRET` and `ORIGIN` must be set; else
   `503 identity_unavailable` (no cookie the web app cannot verify).
4. **Rate limit, per route and client IP.** Login 5/min, register 10/hour, a
   sliding window in process memory (override with `IDENTITY_LOGIN_PER_MINUTE`
   and `IDENTITY_REGISTER_PER_HOUR`; `verify.sh` raises both so a back-to-back
   gate run does not trip its own throttle). `429 rate_limited` carries
   `Retry-After`.
   The client IP is the last `X-Forwarded-For` hop (the one Caddy appends), so
   the manager sees worldGraph's caller, not Caddy.
5. **Peer guard.** `/identity/*` sits behind the same `is_sandbox_peer` wall as
   every manager endpoint: a sandbox container cannot register an account.

Every answer, including errors and `405`s, carries `Cache-Control: no-store`.
Passwords, hashes, cookies and keys are never logged; DB failures log the
exception without statement parameters.

`GET` on the three POST routes answers `405` JSON with `Allow: POST`, so
`pnpm affido:doctor` can tell a missing route (Caddy catch-all `200`) from a
present one without creating an account. Unknown `/identity/*` paths answer
`404` JSON.

## 6. `/whoami`

The route already existed for `forward_auth`. It gains optional `email` and
`name` from a `LEFT JOIN` on `user`. The join is tolerant of the e2e's seeded
session rows, which have no user row; those answers keep only `user_id`. If the
`user` table is missing entirely, the query falls back to the session-only
lookup so the browser path keeps working before the web app's migration.

## 7. Configuration

`.env` (compose interpolation, control plane only):

| Variable | Meaning |
|---|---|
| `IDENTITY_API_KEY` | scoped key; `./dev.sh up|reload` and `verify.sh` generate one when missing |
| `IDENTITY_API_KEY_PREVIOUS` | optional old key during rotation |
| `BETTER_AUTH_SECRET` | must equal `frontend/.env`'s secret; seals the cookie |
| `ORIGIN` | must equal the web app's `ORIGIN`; selects the cookie name |

The manager receives them as environment, alongside `MANAGER_TOKEN`; the agent
sandboxes never see any of them.

## 8. Caddy

```
@identity path /identity/*
handle @identity {
    reverse_proxy sandbox-manager:8090
}
handle /whoami {
    reverse_proxy sandbox-manager:8090
}
```

The identity request does **not** carry `X-Manager-Token`: the manager's
`/identity/*` branch runs before `authorized()`. The blocks deliberately do not
strip `Origin`, deviating from the integration request's suggested snippet,
because stripping it would disable the 403 wall through the gateway.

`frontend/.env` and `frontend/.env.example` now use
`ORIGIN=http://localhost:5174`, and `vite.config.ts` pins the dev server to that
port with `strictPort`. 5173 was Vite's default, not an aFFido decision; a
mismatch between `ORIGIN` and the served port breaks cookies and reset links
silently.

## 9. Tests

- Manager unit: golden hash, NFKC, golden cookie, secure-name derivation, key
  rotation, email normalization, the HTTP gate order, `405/401/403/409/429/503`
  answers, `/whoami` fields, rate windows.
- Frontend unit: `verifyPassword` accepts the manager golden hash; `makeSignature`
  reproduces the golden cookie; a memory-adapter better-auth instance signs in
  with a manager-shaped credential row and resolves a manager-sealed cookie.
- E2E (`e2e-test/identity.sh`, through Caddy): wrong key and Origin write zero
  rows, register writes one user/account/session, hash and cookie verify,
  duplicate and concurrent registrations yield one row and a 409, login is
  indistinguishable for wrong password and unknown address, the cookie passes
  `forward_auth` on `POST /prompt`, logout revokes it for `/whoami` and the sandbox route.

The e2e stack has no web app, so `e2e-test/lib.sh:ensure_auth_tables` creates
the three tables with the same shape as the Drizzle schema (idempotent, like
the migration). If it had to create `user`/`account`, `identity.sh` drops them
on exit and leaves a schema the web app's migration can still create; if they
already existed, only this run's rows are deleted.

## 10. Rollout and rollback

1. Deploy the manager and Caddy changes.
2. Set `IDENTITY_API_KEY` (32+ random bytes, base64) on the manager and on
   worldGraph. Set `BETTER_AUTH_SECRET`/`ORIGIN` to the web app's values.
3. Ensure the web app's migrations have created `user`, `account`, `session`.
4. Run `verify.sh` (or `e2e-test/identity.sh` on a running stack).

Rollback is removing the two Caddy blocks and the key. worldGraph then gets the
catch-all instead of the surface; the graph side keeps working and no schema is
changed. Rotating the key: move the current value to
`IDENTITY_API_KEY_PREVIOUS`, set the new one, switch worldGraph, then clear the
old one.
