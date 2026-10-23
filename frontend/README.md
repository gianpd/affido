# Durable web client

SvelteKit front end for the pi-durable control plane: better-auth accounts, a
dashboard with documents and corpus collections, an AI SDK chat against the
user's sandbox, and a trace page for the durable session.

## Stack

- SvelteKit 3 + Svelte 5 (runes)
- better-auth (email + password)
- Drizzle ORM / Postgres
- shadcn-svelte components, Tailwind CSS 4
- AI SDK (`ai` + `@ai-sdk/svelte`), Perplexity-inspired theme

## Routes

| Route                    | Purpose                                                  |
| ------------------------ | -------------------------------------------------------- |
| `/`                      | Landing page; redirects signed-in users to `/dashboard`  |
| `/login`                 | Sign in and create account tabs                          |
| `/login/forgot`          | Requests a single-use password-reset link                |
| `/login/reset?token=...` | Sets a new password and revokes every session            |
| `/logout`                | POST only; clears the better-auth session                |
| `/dashboard`             | Overview: documents, corpus, traces, usage, quick prompt |
| `/dashboard/documents`   | Upload or paste text documents, view, delete, search     |
| `/dashboard/corpus`      | Corpus collections and per-corpus document membership    |
| `/dashboard/chat`        | AI SDK chat with the user's sandbox                      |
| `/dashboard/traces`      | Every captured snapshot of every conversation            |
| `/dashboard/traces/[id]` | Decision graph, entries, live tasks, submissions, raw    |
| `/api/chat`              | Streams the sandbox answer as a UI message stream        |
| `/api/chat/reset`        | Starts a new agent context and clears the visible chat   |

## Setup

The control plane lives at the repository root. Start Postgres and the manager
first:

```bash
cd ..
docker compose up -d --build
```

Postgres is published on `localhost:15432` by default (`OLTP_PORT` overrides).

```bash
cp .env.example .env
# set BETTER_AUTH_SECRET (32+ random characters) and DATABASE_URL
pnpm install
pnpm db:migrate
pnpm dev
```

`pnpm db:migrate` is safe against a database the e2e suite already used: the
migration creates the four-column seeded `session` table only when absent and
adds the better-auth columns if it is present.

Create an account at `/login`. The first dashboard request provisions a
sandbox for that user through the manager.

### Password recovery

There is no mail transport on this stack. `emailAndPassword.sendResetPassword`
writes the link to the server log, and `RESET_PASSWORD_LINK_INLINE=true` (the
`.env.example` default) also shows it on `/login/forgot` right after the
request. Inline delivery reveals which addresses have an account, so leave it
off in a deployment and wire a real mail sender into `sendResetPassword`
(`src/lib/server/auth.ts`). Links expire after an hour and work once; a
successful reset revokes the user's sessions.

## How the web app reaches a sandbox

Two modes, selected by environment:

1. **Gateway (default, host development).**
   `SANDBOX_GATEWAY_URL=http://localhost:18080`. Every request goes to
   `/u/<user_id>/...` on Caddy. Caddy's `forward_auth` asks the manager to
   validate the session cookie and resolve the upstream sandbox, then proxies
   there. The web app forwards the browser cookie unchanged.
2. **Trusted caller (container deployment).**
   Set `SANDBOX_MANAGER_URL` (for example `http://sandbox-manager:8090`) and
   `MANAGER_TOKEN`. The app authenticates the user itself, calls
   `POST /resolve`, and dials the returned endpoint. The web container must be
   on the `agents` network and the manager must know its container name via
   `WEB_CONTAINER`, so it can attach the container to each per-user network.

The manager accepts better-auth's signed cookie (`<token>.<hmac>`): it looks up
the token part, so gateway mode works with real accounts, not only the seeded
test sessions.

## Chat bridge

The sandbox exposes a non-streaming `POST /prompt`. `/api/chat`:

1. takes the newest user message from the AI SDK request body,
2. stores it in `chat_message`,
3. calls the sandbox with the message id as `requestId` (idempotent retries),
4. stores the assistant answer and captures a trace snapshot,
5. re-emits the answer as AI SDK UI message chunks (`start`, `text-delta`,
   `data-citations`, `finish`).

The browser uses the AI SDK `Chat` class with `DefaultChatTransport`. The
database copy is the renderable history; the sandbox remains the agent's durable
memory. Assistant text is rendered as Markdown with `markdown-it` (raw HTML
disabled, so model output cannot inject markup).

**Strict citations** (RFC 0006): the composer carries a Strict citations switch.
It is a per-question command — `citations: "required" | "off"` rides each
submission's request body, and the choice is stored with the user message
(`data-strict` part). A gated reply renders `[cit_...]` tokens as numbered
superscripts plus a Files used panel (title, filename, version, line, quote);
a `plain` reply shows the "No document evidence" badge. The evidence envelope
arrives as a `data-citations` part on the assistant message and persists with
it. Quote links open the document preview scrolled to the cited line
(`/dashboard/documents?doc=<id>#L<line>`).

**New session** calls `/api/chat/reset`, which posts `/reset` to the sandbox and
drops the user's `chat_message` rows. The sandbox records a `pi.reset` entry and
starts a new model context; older entries stay in storage and on the trace page.

## Trace capture

`/inspect` reports the current conversation only. The app stores every capture in
`trace_session` (append-only): the chat page load, every prompt, and
**Capture current trace** / **Refresh from sandbox** each add a new snapshot, so
the trace page shows the full capture history of the user — not just the newest
state of each conversation — without activating every sandbox on page load.
Snapshots of the same conversation are numbered (capture n/m) and the detail page
links to the older and newer capture of that conversation. Usage totals count
only the newest snapshot per conversation, because snapshots overlap.

## Decision graph

`/dashboard/traces/[id]` opens on the **Decision graph** tab: the snapshot
projected as a swimlane graph (user / agent / tools / context lanes, time flowing
down). Entries are nodes; the transitions between them are labelled edges:
`prompt` (user turn), `calls` (an assistant decision to invoke a tool), `ran` /
`failed` (tool result), `observed` (results fed back into the next decision),
`answer` (final reply). The projection (`src/lib/trace-graph.ts`) is pure and
offline: it reads the stored snapshot only, falling back to the `tool:<name>`
summary markers for snapshots captured before the structured fields existed.
Clicking a node fetches that entry's exact stored content from the sandbox
(messages, tool-call arguments, thinking). A summary strip counts turns, tool
decisions, calls, errors, and per-tool usage.

## Commands

```bash
pnpm dev            # dev server
pnpm check          # svelte-check
pnpm lint           # prettier + eslint
pnpm build          # production build
pnpm db:generate    # generate a migration from the schema
pnpm db:migrate     # apply migrations
pnpm db:push        # dev-only schema push (interactive)
pnpm auth:schema    # regenerate better-auth tables (see caveat)
```

`auth:schema` writes snake_case physical columns and foreign keys. This project
uses camelCase columns in `src/lib/server/db/auth.schema.ts` because the sandbox
manager queries `"session"."userId"` / `"expiresAt"`, and it omits the session
foreign key so e2e-seeded sessions remain valid. Re-apply those edits if you
regenerate the file.

## Scope

- One root conversation per sandbox. A new session resets the model context in
  that conversation; the agent does not create additional conversations yet.
- Documents are text only (up to 10 MB, the same cap the sandbox enforces). The agent does not currently read the
  Postgres document table; it reads its workspace through the file API.
- The trace page shows the snapshot captured by this app, not a live tail.
