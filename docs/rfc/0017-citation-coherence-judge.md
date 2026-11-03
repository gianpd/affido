# RFC 0017 — Post-gate citation-coherence judge

| Field | Value |
|---|---|
| Status | Implemented, rejected for enforcement (`CITATION_JUDGE=off` stays the default) |
| Author | Affido maintainers |
| Date | 2026-11-03 |
| Target | `agent/`, `sandbox-manager/` (env forwarding only) |
| Related | RFC 0006 (the deterministic gate), RFC 0012, `agent/citation-store.ts`, `agent/citation-judge.ts`, `agent/gliner-decide-judge.ts`, `agent/scripts/fetch-judge-model.mjs`, `agent/scripts/eval-citation-judge.mjs` |

## 1. Summary

RFC 0006's publish gate is mechanical: every cited line carries a token, every
token is a verified annotation of this run. It cannot see whether the *words on
the line* have anything to do with the quote behind the token. A line
"**L'assistenza è inclusa nel canone annuo [cit_…]**" passes today when
`cit_…` points at "La disdetta deve essere comunicata 90 giorni prima." — a
real, verified quote about a different clause.

This RFC adds an optional probabilistic layer behind an off-by-default flag:
after the deterministic gate accepts a publish, and before the publish exists,
a local encoder model classifies each (line, quote) pair as `supported`,
`unsupported` or `contradicted`. In `enforce` mode an incoherent line rejects
the publish with `incoherent_citation` and the model retries.

The layer is implemented, measured, and **not recommended for enforcement**.
On the agreed fixture set the judge cuts false accepts by 75% (100% → 25% on
the held-out test split) but falsely rejects 50% of *supported* pairs —
including verbatim repeats of the quote — against a fixed bar of 10%. The
deterministic gate is unchanged; the flag stays `off`.

## 2. Artifact decision (written before the integration)

Sizes are actual file bytes at the pinned revisions, verified by SHA256 in
`agent/scripts/fetch-judge-model.mjs`.

| Artifact | Weights | Runtime | Status |
|---|---|---|---|
| `onnx-community/GLiNER2.5-Decide-mobile-ONNX` @ `880d1921` | 345 MB q4f16 (353 MB with tokenizer) | `@huggingface/transformers` 4.3.2, Node CPU | **primary**; measured |
| `onnx-community/GLiNER2.5-Decide-ONNX` @ `18271032` q4f16 | 523 MB | same | parity reference; identical verdicts on all 74 fixtures |
| `antflydb/GLiNER2.5-Decide` GGUF Q8 | 465 MB encoder + 62 MB head | Antfly runtime | **rejected**: the card states the exporter strips `decide`/`typed_decisions`, and no qualified runtime exists here |
| `fastino/GLiNER2.5-Decide` FP32 | 1,946 MB | PyTorch `gliner2` | reference only: over the 1 GB cap, and Python is not in the toolbox |

Runtime choice. `open-jev` 0.1.2 (latest) **cannot load either ONNX build**:
its `detectFamily` supports only `open_jev` and `kev` config sections and
throws on this model's `gliner2` section — verified against the published
source and at runtime. The gliner2 adapter exists only as unmerged PR
nico-martin/open-jev#1, so the adapter is reproduced in
`agent/gliner-decide-judge.ts` (≈120 lines) on top of
`@huggingface/transformers` (pinned `4.3.2`). It is verified token-for-token
against the exporter's `conversion/reference.json`: identical `input_ids` and
`marker_positions` on all 6 reference cases, argmax agreement 12/13, worst
probability difference 0.068 at q4f16 (the card's own parity table reports
7.1e-2).

Capability. `open-jev`/GLiNER2.5-Decide exposes one state text plus typed
questions in one forward pass; there is no native (claim, evidence) input, so
the state concatenates both:

```
CLAIM:\n<line with tokens stripped>\n\nEVIDENCE:\n<quote>
```

Five question forms were measured on the dev split (§8): the `noul` yes/no
form ("The evidence supports the claim.") separates nothing (it answers "yes"
for near-misses); the three-way `choice` without label descriptions separates
best (`supported`/`unrelated`/`contradicted`, question "How does the evidence
relate to the claim?"). Label descriptions consume the 512-token budget
without improving separation. That form is frozen in `GlinerDecideJudge`.

Mobile fidelity. The mobile card claims a max probability difference of 0.028
versus the non-mobile q4f16 on 42 unrelated decision prompts. Re-measured on
our fixtures: **verdict agreement 74/74 (100%) on both splits, worst
probability difference 0.019**. The mobile build is the primary artifact;
the 523 MB build would buy nothing.

Language. The model is English-trained; the corpus is Italian. Measured
per-language (§8): Italian is not uniformly worse than English — the failures
are task failures (verbatim repeats, numbers in words, partial entailment),
not language failures. `GLiNER2.5-multi-Decide` was **not** substituted (it
needs its own approval per the brief); neither was the 1B model.

Length. `max_position_embeddings` is 512, shared by question, labels and both
fields. Truncation is defined before judging (`agent/citation-judge.ts`): the
claim is capped at 600 characters, the quote at 1,400, the quote is cut at a
sentence boundary preferring the sentence with the most lexical overlap with
the claim (the sentence carrying the annotation match), the encoder cuts whole
words only, and every cut pair is counted (`judgeTruncated`).

## 3. Flag

`CITATION_JUDGE=off|warn|enforce`, default `off`, read once at agent boot:

- **off** — the layer is absent. The registry is built without a judge and the
  deterministic gate runs exactly as RFC 0006 specifies.
- **warn** — verdicts, scores, latencies and truncations are recorded in the
  run state and the report; nothing is ever rejected.
- **enforce** — an incoherent line rejects the publish with
  `incoherent_citation` (line preview, failing verdict, score); a judge that
  errors or times out (5 s per pair) rejects with `judge_unavailable`. In both
  cases nothing is written, `publishRejections` counts the reason, and the
  model retries — no publish without a pass, the same rule the gate applies to
  itself.

The manager forwards `AGENT_CITATION_JUDGE` / `AGENT_CITATION_JUDGE_MODEL_DIR`
into `docker create` exactly like `AGENT_CITATIONS_DEFAULT` (sandbox env is
fixed at create). The weights are not in the repo and not in the default
image; an operator who enables the flag bakes the fetched cache into a derived
image (`COPY … /app/judge-models`) and points `AGENT_IMAGE` at it — no ad-hoc
mounts. The agent loads with `env.allowRemoteModels = false` and
`env.localModelPath` pinned to the cache, and a boot-time presence check fails
loudly when the cache is incomplete, so nothing ever downloads mid-run.

## 4. Where the check runs and what it sees

`answer_publish` terminates the turn on success, so there is exactly one place
a rejected line can retry: inside the publish body, after `evaluatePublish`
returns ok and **before** `state.published` is written. A failure writes
nothing. An async post-hoc audit is explicitly rejected: once published there
is no second chance.

Judge input is state the run already stores — the `Annotation.quote` of each
declared id and the published line with `[cit_…]` tokens stripped
(`claimOf`). The corpus is never re-read, no span is ever re-located.

Aggregation (unit-tested, `agent/citation-judge.test.ts`): for each
non-heading, non-blank line with tokens (the same line set the gate's
`uncited_line` check walks), for each id on the line, judge
`(claim, quote)`. **A line passes iff at least one pair is `supported` and no
pair is `contradicted`** — support is split across the line's ids, a
contradiction overrides it. Headings and blank lines stay exempt.

## 5. Port and runtime

```
agent/citation-judge.ts       CitationJudge port, JudgeVerdict, JudgeMode,
                              truncation, aggregation, ScriptedJudge
agent/gliner-decide-judge.ts  GlinerDecideJudge + the gliner2 encoding +
                              pinned manifests (bytes + SHA256); the only
                              file that imports @huggingface/transformers
```

`CitationJudge` is one method: `judge({ claim, quote }): Promise<JudgeVerdict>`
with `JudgeVerdict = { verdict: "supported" | "unsupported" | "contradicted";
score: number }` (score = the softmax probability of the returned verdict).
The gate and tools depend on the port; every test drives `ScriptedJudge`.

`GlinerDecideJudge` owns load/judge/close: lazy load on the first judged
publish (cold start ≈ 1.2 s, model session 0.8 s of it), `close()` disposes
the ONNX session.

## 6. Run state and report

`CitationRunState.judge` (null until the first judged publish; the commit
layer snapshots a doc property at assignment time, so the value is built in
full and assigned once — create-then-mutate was observed to drop the first
attempt's verdicts):

```
judge: { mode, verdicts: [{line, citationId, verdict, score, ms, truncated}],
         rejections, truncated, errors }
```

The citations report gains, per run: `judgeVerdicts`, `judgeRejections`,
`judgeTruncated`, `judgeErrors`, per-verdict counts, and latency p50/p95 —
`GET /inspect?report=citations` shows exactly what the layer did.

## 7. Runtime footprint (measured)

| Item | Value |
|---|---|
| Weights on disk (mobile) | 353 MB (345 MB q4f16 + 8.3 MB tokenizer) |
| `@huggingface/transformers` 4.3.2 install | ≈ 484 MB node_modules (onnxruntime-node 288 MB, onnxruntime-web 141 MB included) |
| `affido-agent:latest` image | 552 MB → 1.56 GB (**+1.0 GB** with the judge off — the dependency is unconditional) |
| Cold start (config + tokenizer + session) | ≈ 1.2 s |
| Latency per pair, 20-CPU host, CPU | p50 ≈ 240 ms, p95 ≈ 280–520 ms |
| Peak RSS while judging | ≈ 930 MB mobile, ≈ 980 MB full |

`AGENT_MEMORY` defaults to 512m: **an enforcing sandbox OOMs**. Raising it to
≥1g is a deployment prerequisite for `warn`/`enforce`, documented in
`.env.example`. If the layer stays `off`, dropping the dependency (and with it
the 1 GB image delta) is a single revert commit.

## 8. Eval (the decision evidence)

Fixtures: 74 hand-labeled pairs (no LLM labeling), 41 Italian, 33 supported /
21 unrelated / 20 contradicted, split 44 dev / 30 test. The dev split tuned
the question form and confirmed argmax as the decision rule (any score
threshold τ ≥ 0.4 pushed false rejects on supported above the 10% bar); the
test split was authored after freezing and touched once, at this run. The
test split contains the mandated cases: the exact unrelated failure from the
brief ("La disdetta deve essere comunicata 90 giorni prima." backing
"L'assistenza è inclusa nel canone annuo [cit_…]"), multi-citation lines
(split support, contradiction override, neither-supported), number/date/negation
flips, one English pair from `agent/citation-agent.test.ts`, one Italian pair
from `e2e-test/citations.sh`, and near-/over-cap quotes exercising truncation.

One command, deterministic (pinned weights, argmax, no sampling):
`node agent/scripts/eval-citation-judge.mjs` — writes raw JSON and
`SUMMARY.md` under `agent/judge-eval/` (gitignored).

Run of 2026-11-03 (20-CPU host, node 24, both caches local):

| Run | n | FA unrelated+contradicted | FR supported | latency p50/p95 |
|---|---|---|---|---|
| baseline (gate only), dev | 44 | 100% (25/25) | 0% | — |
| gate + mobile, dev | 44 | 24% (6/25) | 21% (4/19) | 244/277 ms |
| gate + full 523 MB, dev | 44 | 24% (6/25) | 21% (4/19) | 287/325 ms |
| baseline (gate only), test | 30 | 100% (16/16) | 0% | — |
| gate + mobile, test | 30 | **25% (4/16)** | **50% (7/14)** | 240/522 ms |
| gate + full 523 MB, test | 30 | 25% (4/16) | 50% (7/14) | 287/663 ms |

Mobile vs non-mobile verdict agreement: 44/44 dev, 30/30 test (worst
probability difference 0.019). Truncated pairs: 0 (the over-cap fixture was
cut and the cut still judged the pair correctly).

**The agreed success bar is missed**: false accepts are cut by 75% (bar: ≥60%)
but false rejects on supported pairs are 50% on the held-out test (bar: ≤10%;
dev was already 21%). Per the protocol: no tuning on test, the flag stays
`off`.

What the model actually fails at (all on the held-out run):

- **Verbatim repeats judged contradicted** — "Il contratto si rinnova
  tacitamente il 1 marzo 2027." against an identical quote returns
  `contradicted`. The same for the English verbatim pair (`unsupported`).
- **Numbers written differently** — "24 mesi" vs "ventiquattro (24) mesi"
  → contradicted.
- **Partial entailment** — the quote adds "e non si rinnova automaticamente"
  to a claim that only states the first half → contradicted.
- **Harmless widening** — "90 giorni prima della scadenza" vs "90 giorni
  prima" → contradicted.
- **Negation flips accepted** — "non-refundable" over "refunded within 30
  days" judged `supported` (2 of the 4 remaining false accepts).

The conclusion: GLiNER2.5-Decide is a routing/decision classifier, not an
entailment model. Its `contradicted` head fires on near-identity and on
numeric paraphrase — precisely the shapes a citation line takes when the model
quotes well.

## 9. Recommendation

- `CITATION_JUDGE=off` (the shipped default). `enforce` would reject half of
  correct publishes; that is a worse product than the unchecked false accept.
- `warn` is safe to run for observability (records only) but costs ≈1 GB of
  image, ≈930 MB RSS and ≈250 ms per pair, and nothing acts on the data yet.
- Artifact: if the layer is ever re-enabled, the mobile build — it is
  verdict-identical to the 523 MB build on every fixture.
- The layer is worth revisiting with an entailment-trained model, or with a
  cheaper deterministic pre-filter (number/date/negation token overlap) that
  catches the flips the model misses. The port (`CitationJudge`), the
  aggregation, the flag plumbing and the eval harness all stay as they are.

## 10. Testing

- `agent/citation-judge.test.ts` — unit: claim extraction, truncation
  (boundary cut, overlap sentence preference, counting), the line walk,
  aggregation (supported, unsupported, contradicted, multi-id split support,
  contradiction override, judge error, judge timeout, error-with-support,
  headings/blank exemption).
- `agent/citation-agent.test.ts` — integration through the real strict path
  with `ScriptedJudge`: `enforce` rejects with `incoherent_citation`, records
  verdicts, and the retry publishes; `warn` records and publishes anyway; a
  failing judge in `enforce` rejects with `judge_unavailable` and the run ends
  visibly unpublished.
- Deterministic-gate tests are untouched: `citationExactness`, `unreportedUsed`,
  `padded` and every existing rejection reason behave exactly as before
  (142 agent tests pass).
- `sandbox-manager` unit tests cover the env forwarding.
