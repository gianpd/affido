# RFC 0018 — Default coherence judge: LiquidAI d1.1 via OpenRouter

| Field | Value |
|---|---|
| Status | Implemented |
| Author | Affido maintainers |
| Date | 2026-11-24 |
| Target | `agent/`, `sandbox-manager/` (env forwarding only) |
| Related | RFC 0017 (the coherence layer; its artifact decision is superseded here), RFC 0012 (BYOK), RFC 0013 (key-injection sidecar) |

## 1. Summary

RFC 0017 shipped the post-gate coherence layer with the local GLiNER2.5-Decide
encoder and rejected enforcement: on the frozen fixtures the encoder cut false
accepts by 75% but falsely rejected 50% of supported pairs, against a bar of
10%. The flag stayed `off`.

The follow-up zero-shot experiment (`agent/scripts/eval-zero-shot-judges.mjs`,
report `docs/zero-shot-judge-eval.html`) re-ran the same 74 fixtures, the same
state text, question, truncation and aggregation, through hosted decision
models that answer one typed-choice question in a single forward pass — no
generation, no parsing:

| Judge | test accuracy | FA (unrelated+contradicted) | FR (supported) |
|---|---|---|---|
| Typesafe System One (jev-latest) | 1.00 (30/30) | 0% (0/16) | 0% (0/14) |
| **LiquidAI d1.1 via OpenRouter** (`liquid/d1.1`) | **1.00 (30/30)** | **0% (0/16)** | **0% (0/14)** |
| LiquidAI d1-2B, local GGUF | 0.97 (29/30) | 0% | 7% (1/14) |
| GLiNER2.5-Decide (RFC 0017 artifact) | 0.53 | 25% | 50% |

d1.1 passes both bar criteria (FA cut ≥ 60%, FR ≤ 10%) on the held-out split
and on dev. Run of 2026-11-03, served snapshot `liquid/d1.1-20261027`; raw
outcomes in `agent/judge-eval/zero-shot-d1or/`.

Decision: the default coherence judge of RFC 0017's layer becomes **d1.1 via
OpenRouter**, and the layer's default mode flips **off → enforce**. The GLiNER
runtime stays selectable (`CITATION_JUDGE_BACKEND=gliner`) as the no-egress
artifact; it is no longer the default.

## 2. Serving shape

OpenRouter serves `liquid/d1.1` as a *decision model*: `chat/completions`
refuses it ("is a decisions model"), and the typed-choice endpoint is

```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer <openrouter key>
{ "model": "liquid/d1.1", "state": "CLAIM:\n…\n\nEVIDENCE:\n…",
  "questions": { "relation": { "type": "choice", "instructions": "…",
                               "criteria": { "supported": "…", "unrelated": "…", "contradicted": "…" } } } }
→ { "answers": { "relation": { "choice": "supported", "probabilities": {…}, "confidence": 0.95 } } }
```

The frozen prompt is exactly the eval's: question "How does the evidence relate
to the claim?", one neutral definition per label (the definitions describe the
dataset's gold semantics and do not leak pairs), state `CLAIM:\n<claim>\n\n
EVIDENCE:\n<quote>`. `unrelated` maps to the verdict class `unsupported`,
`score` is `confidence` (fallback: the choice's probability). Cost ≈ 138 input
tokens, 0 output tokens, ~$0.000003 per pair; latency p50 ≈ 220 ms, p95 ≈
430 ms (host-measured). The layer's aggregation, truncation, `JUDGE_TIMEOUT_MS`
(5 s per pair) and rejection reasons are unchanged from RFC 0017.

## 3. Key routing (no new key, no new key surface)

The judge rides the run's existing OpenRouter credential — the same key the
model calls use, under the same discipline (RFC 0012 R3 / RFC 0013 R1: in
memory only, never env, image, SESSION_DB or WORKSPACE). There is no separate
judge key and no config field for one.

`ContainerAgent.judgeEndpoint()` resolves per call from live runtime state:

| Runtime state | Endpoint |
|---|---|
| active provider ≠ openrouter (faux, others) | `null` — layer absent |
| openrouter, `keyVia: "direct"` (standalone secret file, or a direct BYOK delivery) | the pinned decisions URL with the key from the in-memory credential store |
| openrouter, `keyVia: "sidecar"` (managed BYOK, RFC 0013) | `POST {SIDECAR_URL}/judge/decisions`, no key in the agent process |

**Keyless deployments are unchanged.** The default stack (faux, no egress)
resolves `null`; a judge that cannot run is *absent*, not erroring: the
publish path skips the layer when `available()` is false, so `enforce` never
rejects a publish because no key exists. Judge availability follows the
provider selection at runtime: switching to openrouter turns the layer on,
switching away turns it off. A judge that *is* available and then fails
(network, 5xx, timeout) still rejects under `enforce` (`judge_unavailable`) —
RFC 0017's fail-closed rule, unchanged.

## 4. Sidecar route (RFC 0013 amendment)

The sidecar's proxy scheme pins the upstream at `/config` time and requires the
agent-supplied base to equal it; OpenRouter's chat base is
`https://openrouter.ai/api/v1`, but the decisions endpoint lives at
`https://openrouter.ai/api/alpha/decisions` — outside the pinned base and not
reachable through `/{provider}/~/{base}/...` (verified: `/api/v1/alpha/decisions`
is 404). Widening that scheme to accept a second agent-supplied base would
weaken R3 (agent-controlled redirect of the stamped key).

Instead the sidecar gains one fixed route, carrying no URL at all:

```
POST {SIDECAR_URL}/judge/decisions
```

- Served only when the slot's provider is `openrouter` and the catalog entry
  pins a `decisionsUrl` (operator-built image artifact, same file as every
  other pin; a slot for any other provider, faux included, answers 404
  `no_decisions_endpoint`; an unconfigured sidecar answers 503 like every
  other route).
- Target, auth header and key come from the slot and catalog exactly as for
  chat calls: inbound auth headers stripped, key stamped, body relayed
  verbatim, response relayed unbuffered. The agent controls only the JSON
  body; the model id is pinned in the agent's judge code, not negotiated.

## 5. Flag surface

| Env (agent) | Env (manager forwards) | Values | Default |
|---|---|---|---|
| `CITATION_JUDGE` | `AGENT_CITATION_JUDGE` | `off` `warn` `enforce` | **`enforce`** (was `off`) |
| `CITATION_JUDGE_BACKEND` | `AGENT_CITATION_JUDGE_BACKEND` | `d1` `gliner` | `d1` |
| `CITATION_JUDGE_MODEL_DIR` | `AGENT_CITATION_JUDGE_MODEL_DIR` | path | `/app/judge-models` (gliner only) |

The model id is pinned in code (`liquid/d1.1`); the eval numbers are for that
model and the pin is the drift control. `gliner` keeps RFC 0017's boot-time
cache check and footprint; `d1` adds no dependency (native `fetch`) and no
weights.

Egress: `d1` needs the sandbox to reach `openrouter.ai` — the same requirement
as real model calls (`AGENT_EGRESS=open`), and in the managed stack the
sidecar already has that path. The keyless default stack never makes a judge
call.

## 6. Port change

`CitationJudge` gains one optional method:

```ts
available?(): Promise<boolean>
```

Absent means always available (`ScriptedJudge`, `GlinerDecideJudge` — its boot
check already fails loudly). `OpenRouterDecideJudge.available()` is true iff
the endpoint resolver returns non-null. The publish path enters the layer only
when the mode is not `off` *and* the judge is available.

## 7. Testing

- `agent/openrouter-decide-judge.test.ts` — verdict mapping
  (`unrelated → unsupported`), confidence score, retry on 5xx then success,
  no-retry on 401, `available()` false with a null endpoint, Bearer stamping
  in direct mode, endpoint resolution from credential-store state
  (direct/sidecar/placeholder/faux).
- `agent/sidecar.test.ts` — `/judge/decisions`: 200 relay with the stamped key
  against the catalog pin, 503 faux slot, 404 non-openrouter provider, inbound
  Authorization stripped.
- `agent/citation-agent.test.ts` — `enforce` + an unavailable judge publishes
  (layer absent), matching the keyless default stack.
- `sandbox-manager` unit tests cover `AGENT_CITATION_JUDGE_BACKEND` forwarding.

## 8. Caveats carried from the experiment

- 74 pairs, one domain (Italian/English contract clauses); a perfect score
  there does not guarantee generalization.
- d1.1 ran once (remote determinism not re-checked, as it was for System One);
  the endpoint is OpenRouter-alpha and the served snapshot is date-stamped in
  every report.
- The split-support fixture sits near a boundary for d1.1 too (supported 0.515
  vs unrelated 0.463 on the first half) — it lands on the correct side, but
  boundary cases exist.
