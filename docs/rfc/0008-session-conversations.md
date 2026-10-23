# RFC 0008 — Session conversations: "New session" creates a conversation

## Problem

The UI's "New session" mapped to `POST /reset`, which appends a `pi.reset` head
marker to the one eternal conversation. That is a context cut, not a session:
the visible chat rows were deleted, all topics piled into conversation 1's
timeline and usage totals, and the old topic became permanently unreachable for
the model (entries above a head marker are invisible to it forever).

A user starting a totally different topic wants a separate session: fresh
context, previous chats kept, previous traces kept, per-session usage.

## Decision

**"New session" creates a real conversation; reset stays a context cut.**

- `DurableHarness.newSession()` calls `runtime.createConversation({ ownership:
  { kind: "ownerless" }, agent })` — the same agent config as the root — and
  switches the active conversation. Exposed as `POST /session/new`.
- The active conversation is **durable state**: the session-scoped document
  `agent.active-conversation` in `SESSION_DB`. `#open` resolves root → pointer →
  conversation, falling back to the root when the pointer names nothing. Pause,
  restart and eviction therefore reopen the same conversation.
- **Crash order:** create first, point second. A crash between the two commits
  leaves one unused empty conversation and the pointer on the old one — the safe
  direction. The reverse order could land prompts in a conversation that was
  never committed.
- **Resume is a first-class action.** `POST /session/switch { conversationId }`
  makes an existing conversation the active one again: resolve, then one
  pointer commit — the exact inverse of `/session/new`. Nothing is copied,
  reset, or deleted; the conversation resumes with its full model context. An
  unknown id is 404, never a silent fall-back to the root, and the target's
  stored `pi.agent` is re-synced to the current deployment, like every
  conversation the pointer names on open.
- `POST /reset` is unchanged: a `pi.reset` marker inside the current
  conversation ("clear this session's context"), not a session switch.
- Nothing is deleted by either route. Old conversations stay readable through
  `/inspect?conversation=`; conversation ids come from the storage-wide
  monotonic sequence, so a new conversation is not necessarily "2".

## Web app

- `chat_message` gains `conversationId` (migration `0004`); the chat page loads
  only the active conversation's rows, and prompt rows are persisted under the
  `conversationId` the sandbox itself reported for that submission. Starting a
  new session no longer deletes anything.
- The chat view has a **History** action: `listChatSessions` groups
  `chat_message` by conversation (first question as the title, message count,
  last activity, newest first) and always includes the active conversation even
  when it is still empty. Selecting an entry calls `POST /api/chat/switch-session`
  → `/session/switch`, then replaces the view's messages with that
  conversation's rows — the endpoint returns them, so the swap is independent
  of the page reload.
- The traces page was already conversation-aware (per-conversation snapshot
  timelines, `DISTINCT ON` usage totals); it now simply sees more than one
  conversation.

## Alternatives rejected

- *Archive chats, keep reset-only:* "sessions" would be a UI fiction over one
  ledger, and the model could never see an old topic again (head markers are a
  one-way door).
- *Fork:* pi-durable's entries scans walk the parent chain, so a fork's trace
  includes the old topic; fork means "alternative continuation of this history",
  not "fresh topic".
