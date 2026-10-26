# RFC 0012 implementation report

Implementation of `docs/rfc/0012-byok-user-selected-providers.md` (BYOK: user-selected
providers, per-user API keys). All gates pass; see §4.

## 1. Created

- `sandbox-manager/test_sandbox_manager.py` — manager unit tests: KEK round-trip (raw + base64), AAD-swap and wrong-KEK rejection, fingerprint shape, §5.1 baseUrl rules, §5.6 TOCTOU-safe validation client with per-catalog validatePath routing and suffix shape guard, quiet peer-disconnect handling (RFC §5.2, §5.6; M1).
- `agent/model.test.ts` — agent unit tests: `buildProvider` (built-ins + custom endpoints), `keyFingerprint`, `configureProvider` order, `ContainerAgent.configureModel` (status + harness pin), `ConfigTool` validation (RFC §3.2, §5.4; M2).
- `agent/scripts/gen-provider-catalog.mjs` — build-time generator of `provider-catalog.json` from pi-ai's static catalogs (RFC §5.1; M5, replaces any static fallback).
- `e2e-test/fake-upstream/server.mjs` + `Dockerfile` — the e2e-only fake OpenAI-compatible upstream (streaming `/v1/chat/completions`, `/v1/models`, auth log at `/_log`; RFC §10 M2).
- `e2e-test/providers.sh` — M1/M4 e2e in the default egress-off stack: catalog served, cookieless 401, `egress_blocked`, baseUrl rules, no-Origin 403, `no-store`, session binding, trusted-caller token wall, peer guard on `/providers/*`.
- `e2e-test/byok.sh` — M2/M3/M5 e2e with the fake upstream through Caddy: setup, bearer-seen-exactly-once, fingerprint in `/status`, key-free env/inspect/`/data`/logs, idempotent reconcile, rotation, §5.6 validation + `invalid_key`, L0/L1/`docker rm` durability, §7.13 cascade, manager log scan.
- `e2e-test/manager-call.py` — trusted-caller probe piped into the manager container for the token-path tests.
- `frontend/src/lib/server/providers.ts` — the manager `/providers` client, both modes (Caddy gateway with cookie + Origin, trusted manager with token + `user_id`; RFC §5.3, R9).
- `frontend/src/routes/api/providers/config/+server.ts` — POST/DELETE write route; the key travels in the body only and is never logged or echoed.
- `frontend/src/routes/dashboard/settings/+page.server.ts` + `+page.svelte` — the Settings UI: catalog, key entry, model selection, verify toggle, fingerprints and `verified` surfacing (RFC §12.3; M4).

## 2. Modified

- `sandbox-manager/sandbox_manager.py` — the whole control-plane half: `provider_key`/`provider_selection` tables (§5.2), AES-256-GCM with `AAD = user_id || provider` under the `secrets/llm_key_kek` KEK, `GET /whoami` + `GET|PUT|DELETE /providers/config` + `GET /providers/catalog` behind the peer guard / token / session walls with the write-path identity rule and the Origin CSRF wall (§5.3, §7.14), egress gate (§5.5), TOCTOU-safe upstream validation (§5.6), catalog extracted from `AGENT_IMAGE` (§5.1), `reconcile_provider` inside `resolve()` with `agent_image_old` 404 mapping and faux fallback (§5.4, §7.5), `?all=1` cascade (§7.13), fake-upstream guest attach, `AGENT_SECRETS_DIR` mount removed from `create_args()` (§4), `hostwall()` helper image by tag instead of digest (see §5).
- `sandbox-manager/Dockerfile` — pins `cryptography==46.0.1`; ships the unit-test file.
- `caddy/Caddyfile` — the `@providers` route with `forward_auth /whoami` before the proxy hop and the Caddy-pinned `X-Gateway-Route` marker (§5.3).
- `docker-compose.yml` — manager-only KEK mount `./secrets/llm_key_kek:/run/secrets/llm_key_kek:ro`, `PROVIDER_DEV_HTTP`, `FAKE_UPSTREAM_CONTAINER` env.
- `docker-compose.override.yml` — drops `AGENT_SECRETS_DIR` forwarding (RFC §4).
- `agent/model.ts` — `buildProvider` (catalog built-ins -> pi-ai factories; everything else `createProvider` + `openAICompletionsApi()`), `configureProvider` (credentials.modify -> setProvider), `keyFingerprint`, shared scripted-faux setup, `credentials` in the model bundle; the legacy secret-file branch stays for standalone runs (§3.2, §5.4).
- `agent/types.ts` — `credentials` in `ModelBundle`/`AgentOptions`, `ProviderConfig`, `configureModel` on `AgentApi` (§5.4).
- `agent/harness.ts` — `configureModel` on `HarnessLifecycle` and `DurableHarness`: serialized with prompts, rewrites the deployment agent and pins the conversation via `configure()` so `#syncAgent` follows BYOK selections (§3.4, §5.4, §7.6).
- `agent/agent.ts` — credential store held by the agent, `configureModel`, `keyFingerprint` in `/status` (§5.4 step 3).
- `agent/tools.ts` — `ConfigTool` (`POST /config`), an `HttpTool` subclass that activates the agent (§5.4).
- `agent/server.ts` — registers `ConfigTool`, passes `credentials` (no ad-hoc routing).
- `agent/Dockerfile` — runs the catalog generator into `/app/provider-catalog.json` (§5.1).
- `agent/package.json` — `model.test.ts` added to the test script.
- `agent/agent.test.ts`, `agent/session.test.ts`, `agent/citation-agent.test.ts` — fakes/fixtures updated for the new `HarnessLifecycle.configureModel` and `credentials` option; no behavior changed.
- `frontend/src/routes/dashboard/+layout.svelte` — "AI provider" sidebar entry.
- `frontend/src/lib/types.ts` — optional `keyFingerprint` on `SandboxStatus`.
- `verify.sh` — creates the KEK when missing, runs the manager unit tests, runs `providers.sh`, and a final BYOK phase (builds the fake upstream, re-creates the stack with egress open + dev flags, runs `byok.sh`, restores the keyless default) (R7).
- `e2e-test/run.sh` — runs `providers.sh` in the default suite.
- `dev.sh` — `--provider` removed (see §5), `ensure_kek`, egress taken from the environment, secrets map rewritten for BYOK.
- `openrouter-setup.sh` — removal notice pointing at BYOK and the standalone path.
- `.env.example` — BYOK section (KEK, TLS prerequisite, `AGENT_EGRESS` requirement, dev flags) and standalone-only `OPENROUTER_MODEL`.
- `README.md` — BYOK flow replaces the operator-openrouter flow, egress/TLS prerequisites, runtime provider delivery, updated `verify.sh` description.
- `docs/security.md` — the "model credentials" asset now describes ciphertext + KEK instead of the mounted secrets dir.

## 3. Relevant, unchanged

- `agent/http.ts` — `readBody`/`HttpError` reused by `POST /config`; no new plumbing needed.
- `agent/trace.ts`, `agent/corpus.ts`, `agent/workspace-store.ts`, the citation stack — BYOK changes nothing on the trace, corpus, or citation paths.
- `frontend/src/lib/server/sandbox.ts` — the sandbox client keeps both modes untouched; `providers.ts` mirrors its structure instead of modifying it (R9).
- `frontend/src/routes/api/chat/+server.ts` — the prompt contract is unchanged; provider switches reach the same conversation through `configure()` (R8).
- `verify-sandbox.sh` and the pre-existing e2e scripts — pass unmodified on the faux default; no BYOK selection means reconcile is a no-op.
- `docs/rfc/0004-multi-tenant-llm-keys.md` — the `llm-gateway` stays the operator-mode evolution; only its §4.7 crypto scheme is reused, as the RFC specifies.

## 4. Gates

- `cd agent && npm run typecheck && npm test` — pass (82 tests, 0 failures; includes the new `model.test.ts`).
- `cd frontend && pnpm check` — 0 errors, 0 warnings. `pnpm exec eslint .` — clean. `pnpm exec prettier --check` — clean for every file this change touched; the repo-wide `pnpm lint` still fails on the pre-existing `src/lib/components/brand.svelte` drift (file untouched here, last modified in commit `bb80e3d`). `pnpm test:unit -- --run` — 23/23 pass. Playwright not run (not requested).
- Manager unit tests (`docker compose exec -T sandbox-manager python3 -m unittest test_sandbox_manager`, wired into verify.sh) — 9/9 pass, also verified offline with `--network none`.
- `./verify.sh` — `ALL CHECKS PASSED` (100 checks), run three times consecutively from dirty stack states after the fixes in §5; the BYOK phase and the keyless default both pass in one invocation.
- Caddyfile validated with `caddy validate` (2.11.4).

## 5. Deviations

1. **`dev.sh --provider openrouter` and the `affido-agent:openrouter` derived image were removed** (and `openrouter-setup.sh` is now a notice). RFC §4 removes the `AGENT_SECRETS_DIR` mount from the manager path, which this flow requires to function; keeping a half-working flag would silently degrade every sandbox to faux — the exact surprise-switch behavior the RFC forbids. The command now fails with a pointer to BYOK; standalone `docker run` keeps the secret-file branch of `agent/model.ts` (tested in `model.test.ts` via `createModel`).
2. **`hostwall()` resolves its helper image by tag (`{{.Config.Image}}`) instead of digest (`{{.Image}}`)** — not RFC-driven. On this host's containerd-store daemon, repeated gate rebuilds can garbage-collect the digest a running manager still reports, and provisioning then 503'd mid-gate. The helper remains the manager's own pinned image; only the resolution changed.
3. **PUT validation order**: shape/baseUrl rules run before the egress gate, so a malformed custom URL answers `invalid_base_url` even under `AGENT_EGRESS=off` (the M1 test requires both behaviors). The RFC specifies both checks "at setup" without pinning an order; the gate pins this one.
4. **`e2e-fake` catalog entry requires both `FAKE_UPSTREAM_CONTAINER` and `PROVIDER_DEV_HTTP=1`** — §10 M2 says "http allowed by the dev flag"; two flags are used so the e2e-only upstream cannot appear in a real deployment by setting one variable.
5. **§7.13 frontend call is unwired**: the repo has no account-deletion flow to call `DELETE /providers/config?all=1` from. The manager side and the e2e proof exist; wiring the future deletion flow remains a one-line call.
6. **`verify.sh` starts with `docker compose down --remove-orphans`** before `up -d --build` — needed because the BYOK phase recreates the manager twice per run and back-to-back gate runs on containerd-store daemons could otherwise start from a manager container on a collected image (same root cause as deviation 2). The gate is deterministic from any prior stack state.
