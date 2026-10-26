# Chat

## Sub-features

- Send a prompt to the per-user sandbox agent; the reply streams in (AI SDK UI message stream over `POST /api/chat`).
- Strict-citations switch next to the composer (`aria-label="Strict citations mode"`).
- Stop button (`aria-label="Stop generating"`) replaces the send button while the run is in flight.
- Run deliverables (RFC 0009): per-file download buttons once the agent produced artifacts.
- Every run becomes a trace session (see [traces.md](traces.md)).

## How to get to it (user POV)

Dashboard sidebar → *Chat* (`/dashboard/chat`). Type in the composer (`Ask your agent…`), press send. While the agent works the page shows "Agent is working in its sandbox…".

## Driving it with Playwright

`drive.mjs chat --state <run>/state.json --prompt "..."`. The scenario: waits until the composer is enabled (disabled means the server-side sandbox status call failed; the driver reloads for up to 150 s because the first visit triggers provisioning), fills the prompt, clicks `Send message`, waits for the stop button to appear and detach (up to 5 min — first run includes container create + agent boot + model call), screenshots the conversation, then asserts `/dashboard/traces` lists the run.

`--strict` flips the `Strict citations mode` switch (role `switch`, aria-label on the composer toolbar) before sending, screenshots it in the on state (`chat-strict-enabled.png`), and the run then carries `citations: "required"` to `/prompt`.

Cost note: one prompt per run. On the faux provider (`affido-agent:latest`) it is free and fast; on `affido-agent:openrouter` it is a real model call — keep the prompt tiny.

## Gotchas

- The full chain is frontend → Caddy `/u/<user_id>/prompt` → `forward_auth` → manager `/resolve` → sandbox container. A 401 means auth, a 502/503 means manager/provisioning, a stream that never ends usually means the sandbox stopped mid-run (idle eviction `AGENT_IDLE_MS`).
- If the composer stays disabled past 150 s: `./dev.sh status` (does the sandbox exist?), `docker logs <container>`, and the manager log (`docker logs sandbox-manager`).
- The reply must be visible in the screenshot as an assistant bubble under your prompt — if the bubble is empty but the run "finished", read the trace detail before declaring success.
