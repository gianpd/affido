# Task: Implement RFC 0012 — BYOK (user-selected AI providers, per-user API keys)

You are implementing `docs/rfc/0012-byok-user-selected-providers.md` in this repository (affido). Read the RFC in full before writing any code. It is the specification: every requirement R1–R9, every design decision in §4–§9, and every verification item in §10 must be traceable to code and tests. The RFC's §3 study of `pi-ai`/`pi-durable` 1.3.0 has been verified against the installed packages — trust it and use the exact APIs it cites (`createModels`/`MutableModels.setProvider`, `createProvider` + `openAICompletionsApi()`, `CredentialStore.modify`, `InMemoryCredentialStore`, `conversation.configure`, `ModelRef`).

## Ground rules

1. `AGENTS.md` at the repo root is binding: durability invariants, code quality rules, commands, git rules. Re-read it before starting.
2. Fidelity contract: implement the RFC as written. If a point is ambiguous or you believe it is wrong, stop and ask — never deviate silently and never drop a requirement to save effort.
3. Supporting context you must read first: `docs/audit/secrets-and-llm-providers.md` (the factual baseline the RFC's §1 quotes), RFC 0003 (manager), RFC 0004 §4.7 (the KEK/AES-256-GCM scheme you reuse), `caddy/Caddyfile`, `sandbox-manager/sandbox_manager.py`, `agent/model.ts`, `agent/tools.ts`, `agent/harness.ts`, `frontend/src/lib/server/sandbox.ts`.
4. Three review clarifications resolve ambiguities in the RFC. Apply them as if they were in the text:
   - **Write-path identity (§5.3).** The manager must define one explicit rule for distinguishing browser path from trusted caller on `PUT`/`DELETE /providers/config`: if a valid session cookie is present, the session is the only identity and any body `user_id` is ignored; if no session is present, the request is treated as trusted-caller only when it did not transit the Caddy `/providers/*` route (pin this with the peer/source check you design, and document it in the code). The Caddy `forward_auth /whoami` gate must run before the proxy hop, so a cookieless browser request can never reach the manager's write handlers. Add the test: `PUT` through Caddy with no session cookie → 401.
   - **Custom `baseUrl` validation (§5.6).** Close the TOCTOU window: resolve the DNS name once, enforce the §5.1 rules (https-only, no RFC1918/docker-network answers, length ≤ 2048) on the resolved address, then connect to that verified IP while keeping the hostname in `Host`/SNI. Re-resolve and re-check on every validation request.
   - **Residual-risk note (§7.4/§8.4).** While implementing, keep the documented claim accurate: with `AGENT_EGRESS=open`, a custom `baseUrl` also lets the sandbox reach same-network guests (web, caddy), not just exfiltrate to the internet. The manager is covered by the peer guard; state the rest in the code comment and in the README security note.

## Milestones — in this order, each one gated

**M1 — Manager storage and API** (RFC §5.1–§5.3, §5.5, §5.6, §12.1)
- `provider_key` and `provider_selection` tables exactly as §5.2 (AES-256-GCM, `AAD = user_id || provider`, 32-byte KEK in `secrets/llm_key_kek` mounted into the manager only, fingerprint = `sha256(key)[:12]`).
- `GET /providers/catalog`, `GET|PUT|DELETE /providers/config`, `GET /whoami` behind the existing walls (peer guard, `X-Manager-Token`, session on the browser path). `/whoami` never provisions.
- Caddy `@providers` route with `forward_auth /whoami` as in §5.3; trusted-caller mode mirrors `POST /resolve` semantics.
- Egress gate: reject `PUT` with `provider != faux` and `egress_blocked` when `AGENT_EGRESS != open`; fail closed, no silent faux fallback anywhere.
- Optional upstream validation per §5.6 with the clarification above.
- M1 tests (RFC §10): ciphertext round-trip and AAD-swap rejection; catalog served; session binding (cross-user 403, token path 401); `egress_blocked`; log scan proving no key bytes ever appear in manager output including exception traces.

**M2 — Agent runtime config + reconciliation** (RFC §5.4, §12.2)
- `POST /config` and the `/status` fingerprint extension as `HttpTool` subclasses in `agent/tools.ts` — no ad-hoc routing in `server.ts`. `/config` joins the `DurableHarness` serialization chain (`credentials.modify` → `models.setProvider` → `conversation.configure`, exactly the §5.4 sketch); `/status` still never activates the agent.
- `buildProvider` in `agent/model.ts`: catalog built-ins resolved to pi-ai factories; everything else via `createProvider` + `openAICompletionsApi()`. Keep the legacy secret-file branch for standalone image runs.
- Manager-side reconcile loop inside `resolve()` (§5.4 steps 1–5), including the faux fallback when desired state is unset, and `503 agent_image_old` on 404 (§7.5).
- E2E with the fake OpenAI-compatible upstream through Caddy at `localhost:18080` (never dial a sandbox directly): setup → first prompt answered by the upstream → upstream saw `Authorization: Bearer <key>` exactly once → `/status` shows the fingerprint → rotation changes the bearer → `docker exec … env` and `/data` greps find no key. Keep `verify.sh` and the default e2e keyless/faux (R7).

**M3 — Durability** (RFC §10 M3)
- With the fake upstream: L0 pause + resolve → same model and fingerprint; `docker stop` + resolve → re-delivery, session intact; `docker rm` + resolve → reprovision + re-delivery, session intact.

**M4 — Frontend** (RFC §12.3)
- Settings UI (catalog, key entry, selection, verify, fingerprint + `verified` surfacing) using existing bits-ui/shadcn-svelte components and RFC 0011 design tokens; SvelteKit server routes working in both modes (Caddy gateway and `SANDBOX_MANAGER_URL`). Never log or persist the key client-side.

**M5 — Hardening and docs** (RFC §12.4)
- Catalog generated from pi-ai's static catalogs (build step in the agent image), replacing any static fallback.
- Security suite additions: no-Origin `PUT` → 403; peer guard on `/providers/*`; `Cache-Control: no-store` on config GET; `provider_key` unreadable without the KEK; account-deletion cascade (§7.13).
- Update `.env.example` (same comment style) and `README.md` where behavior claims change (TLS prerequisite for BYOK in production, egress requirement, `AGENT_SECRETS_DIR` removal from the manager path).

## Gates

- Agent: `cd agent && npm run typecheck && npm test` (add new test files to the `test` script).
- Frontend: `cd frontend && pnpm check && pnpm lint`, unit tests with `pnpm test:unit -- --run`. Do not run Playwright unless explicitly asked.
- Stack: `./verify.sh` when a change crosses the agent/manager/Caddy boundary — that includes every milestone here except pure frontend work.
- Never commit unless explicitly asked. If asked, stage only files you changed.

## Non-negotiable invariants (restated from the RFC and AGENTS.md — violating any of these fails the task)

- The plaintext key exists only in: browser POST, TLS-terminated Caddy memory, manager process memory, agent process memory, OLTP ciphertext (R3). Never in env, image, filesystem, URLs, logs, or GET responses — the fingerprint is the only key-derived value any API returns.
- No new published ports (R6); manager stays reachable only via Caddy or the trusted-caller path.
- Existing sessions survive provider switches: `configure()`, never a wipe (R8); both frontend modes keep working (R9).
- `docker inspect`, `/proc/1/environ`, crash dumps stay key-free; a stopped sandbox holds no key material at all.
- Fail closed in every error path the RFC names: `egress_blocked`, `kek_unavailable`, `agent_image_old` — no silent degradation to faux when the user chose a real provider.

## Out of scope — do not implement

- RFC 0004's `llm-gateway` (stays the operator-mode evolution).
- Per-conversation provider overrides (RFC open question 1), dual-network egress (open question 2), orphan-cleanup ownership beyond what §7.13 requires (open question 4).

## Final deliverable: implementation report

When all milestones pass their gates, write `docs/rfc/0012-implementation-report.md` — a simple report, in English, with exactly these sections:

1. **Created** — one line per new module/file: path, what it does, which RFC section it implements.
2. **Modified** — one line per changed module: path, what changed and why, which RFC section drove the change.
3. **Relevant, unchanged** — modules the RFC touches conceptually but that needed no change, with one line on why not.
4. **Gates** — the commands run and their outcome.
5. **Deviations** — any point where the implementation differs from the RFC text, each with a justification. This section should be empty unless you were explicitly instructed to deviate.

Keep the report factual and short: no marketing prose, no restating the RFC.
