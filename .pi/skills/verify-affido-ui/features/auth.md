# Auth

## Sub-features

- Signup (name/email/password, min 8 chars) via the `Create account` tab of `/login`.
- Signin via the `Sign in` tab; failure shows an inline `Field.Error`, not a toast.
- Sign out from the sidebar user menu (`POST /logout`, revokes the session, redirects to `/login`).
- Password reset: `/login/forgot` → link (no mail transport; with `RESET_PASSWORD_LINK_INLINE=true` the link is shown on the page) → `/login/reset` sets a new password and revokes every session.

## How to get to it (user POV)

Landing page → *Sign in* → `/login`. Two tabs: *Sign in* and *Create account*. After signup/signin you land on `/dashboard`. Unauthenticated `/dashboard` visits bounce to `/login?next=/dashboard`.

## Driving it with Playwright

`drive.mjs signup` (then `login` with `--email/--password` to reuse the account, `logout` to end the session). Forms are addressed by action: `form[action*="signIn"]` / `form[action*="signUp"]`, fields by label (`Email`, `Password`, `Name`), submit via `button[type="submit"]`. Success is the redirect to `/dashboard`; the scenario saves `state.json` (session cookie) for the other scenarios.

## Gotchas

- Both tabs' forms exist in the DOM; always scope `getByLabel` to the right form or Playwright hits strict-mode violations.
- The session cookie is the same credential Caddy's `forward_auth` validates against Postgres (manager `user_from_session`): if signin works but chat 401s, the `session` table and the cookie disagree — check `docker exec oltp psql -U pi -d pi -c 'select * from session'`.
- `ORIGIN` in `frontend/.env` must equal the URL you drive (`http://localhost:5173`); a mismatch breaks better-auth's cookie/baseURL silently.
- Password reset is covered by unit tests (`frontend/src/lib/server/password-reset.spec.ts`); the UI path is drivable but changes the password of whatever email you enter — only drive it on a verify user.
