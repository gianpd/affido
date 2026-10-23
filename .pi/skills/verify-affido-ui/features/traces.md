# Traces

## Sub-features

- Session list: paused status, run counts, citations mode (`cited` / `plain` / `none` badges).
- Session detail (`/dashboard/traces/[id]`): the timeline of runs, tool calls, prompt text.
- Sidebar badge shows the user's trace count.

## How to get to it (user POV)

Sidebar → *Traces* (`/dashboard/traces`). Click a session row to open the detail.

## Driving it with Playwright

`drive.mjs traces --state <run>/state.json` screenshots the list and, if any session exists, opens the first detail. The `chat` scenario also asserts a trace row appears for its own prompt — that cross-check (chat side effect visible in traces) is the strongest proof the whole pipeline ran.

## Gotchas

- Trace rows are the UI copy (`trace_session`/`chat_message` tables) of the agent's durable session; after `cleanup.sh` removes the verify user, traces go too.
- An empty traces page right after a chat run is a failure of the run, not of this page: go back to chat evidence and the sandbox logs before blaming the UI.
- The detail route is `/dashboard/traces/[id]` with server-side loading — a 500 there shows in `facts.json.httpErrors`.
