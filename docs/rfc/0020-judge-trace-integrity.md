# RFC 0020 — Audit-grade judge trace: per-attempt verdicts, named failures, a derived budget

| Field | Value |
|---|---|
| Status | Implemented (V1–V6, V8 in `cd agent && npm run typecheck && npm test` and `cd frontend && pnpm check && pnpm lint && pnpm test:unit -- --run`; V7 is the operator-run `agent/scripts/harvest-judge-pairs.mjs`) |
| Author | Affido maintainers |
| Date | 2026-11-04 |
| Target | `agent/`, `frontend/`, `sandbox-manager/` (env forwarding only) |
| Related | RFC 0006 (deterministic gate), RFC 0017 (coherence judge), RFC 0018 (d1.1 classifier), RFC 0019 (web pairs). Code: `agent/citation-judge.ts`, `agent/judge-model.ts`, `agent/citation-tools.ts`, `agent/citation-run.ts`, `agent/citation-report.ts`, `frontend/src/lib/components/judge-verdicts.svelte` |

## 1. Summary

The judge of RFC 0017/0018 decides correctly and its trace cannot be audited.
In one real run it judged 47 (line, quote) pairs and the stored report mixes the
verdicts of three *different* documents under line numbers that mean different
text, drops the cause of its two failures, and rejected two publish attempts on
a 5.6 s cold-start latency spike against a 4.4 s retry ladder — two of its three
rejections in that run were infrastructure, not incoherence.

This RFC changes the judge's *record keeping and its latency envelope*, not its
decision:

- **Per-attempt verdicts.** The run stores one record per publish attempt, with
  the attempt index, its verdicts, its errors and its outcome. The run-level
  numbers the UI shows come from the attempt that published.
- **Named failures.** Every judge failure is stored with its cause
  (`timeout`, `transport`, `http_4xx`, `http_5xx`, `protocol`, `aborted`), its
  duration and its message. The publish rejection reason
  `judge_unavailable` is retired; the replacement is `judge_error_unverified`,
  which says what it means.
- **A derived budget.** The per-pair deadline is computed from the envelope
  instead of hand-set, pairs are judged with bounded concurrency, and a cold
  start is covered by the deadline rather than charged to the publish. A
  per-run budget names its own exhaustion.
- **Verdict reuse.** A republish re-judges only the (claim, quote) pairs that
  changed; the rest are served from the run's own store.
- **A probability record and a calibration gate.** The full label distribution
  and the endpoint confidence are stored, and any future confidence floor must
  be justified by a harvested, in-the-wild fixture set rather than by the
  74-pair set where d1.1 scores 1.00.

The labels, the frozen question, the per-line aggregation (`supported` passes,
`contradicted` vetoes, `enforce` fails closed) and the deterministic gate of
RFC 0006 are unchanged.

## 2. The trace that motivated it

Run `8G9lKEW7XFlpFNw0`, conversation 1487, agent
`uP0XwEF3RrviA5fYxpD4HnB5bknYedcpp-26dfbd85ae6e`,
`deepseek/deepseek-v4.1-flash` through the sidecar, strict citations, judge mode
`enforce`. The model published five times:

| Entry | Attempt | Judge records | Result |
|---|---|---|---|
| 1652 | A | — (gate stopped it) | `uncited_line`, line 33 |
| 1656 | B | 2 | `judge_unavailable`, line 9 |
| 1660 | C | 0 | `judge_unavailable`, line 5 |
| 1664 | D | 23 | `incoherent_citation`, line 29 |
| 1668 | E | 22 | published |

`GET /inspect?report=citations` reports, for this one run:

```
judgeVerdicts 47 · supported 36 · unsupported 11 · contradicted 0
judgeRejections 3 · judgeTruncated 8 · judgeErrors 2
```

Reconstructed per attempt from the stored record order (a line number that goes
backwards starts a new attempt):

| Attempt | Pairs | Lines judged | supported | unsupported | min supported confidence | max pair latency | truncated |
|---|---|---|---|---|---|---|---|
| B | 2 | 5, 9 | 1 | 1 | 0.52 | 351 ms | 0 |
| D | 23 | 5, 9, 13, 17, 21, 25, 29 | 17 | 6 | 0.34 | 606 ms | 4 |
| E | 22 | 5, 9, 13, 17, 21, 25 | 18 | 4 | 0.24 | 1320 ms | 4 |

The published answer is E: 22 pairs, of which 4 are `unsupported` (tolerated by
the per-line rule because another id on the same line was supported), and one
line passed on `cit_79660bcb12` at confidence **0.24**.

Attempt D's rejection is the layer working: line 29 was the meta-line
"*File-writing and shell tools are disabled in this run…*" cited to
`cit_51da329482`, judged `unsupported` at 0.95, and the model removed it.

Attempts B and C are the layer failing for infrastructure reasons. B lost one of
its two pairs (line 9, `cit_51da329482`) with the other answered `unsupported`;
C lost the only pair it tried (line 5, same id). `enforce` failed closed both
times because no supported pair was left. Both failures are unrecorded: the
stored state keeps a counter, not the cause.

## 3. Defects

### R1 — The aggregate is not a document

`agent/citation-tools.ts:323` appends across attempts:

```ts
s.judge = { mode, verdicts: [...prior.verdicts, ...coherence.records], … };
```

`coherenceOf` returns at the first failing line, so an attempt appends only the
pairs it reached before returning: 2, 23, 22 records for B, D and E, and none
for C, which failed on its first pair. The 36/11/0 the UI shows is a sum over
three judged attempts holding three different documents, and `line 25` denotes
the divergence paragraph in D and the principle paragraph in E. The judge tab
therefore cannot answer the only question a reviewer asks: *what did the judge say about the answer that shipped?* The
answer is 18/4/0, and it is not visible anywhere.

### R2 — Failures are anonymous

`agent/citation-judge.ts:182`:

```ts
} catch {
	errors++;
	unverified = citationId;
}
```

The message is discarded, and `agent/citation-tools.ts:309` collapses the reason
to a single string, `judge_unavailable`, rendered in the UI's *Friction* column
next to `uncited_line` and `incoherent_citation`. Read as English it says "no
judge results exist", which is the opposite of the truth here: 47 verdicts
exist. Without a cause, the only way to learn why attempt B failed was to
replay the pair against the live sidecar.

### R3 — The budget is smaller than the latency it must absorb

`agent/judge-model.ts:73-75` and `agent/citation-judge.ts:38`:

```
ATTEMPTS 2 · ATTEMPT_TIMEOUT_MS 2200 · BACKOFF_MS 300   → 4.7 s worst case
JUDGE_TIMEOUT_MS 5000                                   → envelope
```

Measured on this stack, with the same endpoint the run used:

| Call | Latency |
|---|---|
| first classification after a container start | **5650 ms** |
| the exact pair attempt B lost (line 9, `cit_51da329482`) | **5729 ms** |
| this run's 47 answered pairs | 45 of them at 206–351 ms (p50 221, p95 351); two outliers at 606 and 1320 ms |

A cold path exceeds both the 4.4 s of attempt timeouts and the 4.7 s including
backoff, so both attempts abort and the pair is an error. Two of the three
judge rejections in this run were this, not
incoherence. The constants are also unlinked: changing `JUDGE_TIMEOUT_MS` alone
silently leaves the retry ladder outside the envelope.

### R4 — Sequential pairs, paid again on every attempt

Pairs are judged in a loop. At 22 pairs the shipped attempt spent ~5 s in the
judge, and a republish after fixing one line re-judges all 22. On a failing
layer the cost is `n × 4.7 s` with no ceiling.

### R5 — The score is not what it looks like

`judge-model.ts` stores `answer.confidence`. That is not the label probability:
one call returned `confidence 0.3768` with `probabilities.supported 0.5845`.
Confidence is also uncalibrated against production input. On the RFC 0017
74-pair set d1.1 scores accuracy 1.00 / FA 0 % / FR 0 %; on this run, with
1–2 kB multi-sentence quotes from two PDFs, the shipped answer carries supports
at 0.24, 0.45 and 0.51. The fixtures contain short, single-clause pairs; the
trace contains long, multi-clause ones. Nothing in the record lets anyone
measure that gap.

## 4. Design

### 4.1 Per-attempt records

`CitationRunState.judge` becomes:

```ts
judge: {
	mode: Exclude<JudgeMode, "off">;
	attempts: JudgeAttemptRecord[];   // in publish-attempt order
} | null;

type JudgeAttemptRecord = {
	attempt: number;                  // 1-based publish attempt of this run
	at: number;                       // epoch ms of the judgement
	lines: number;                    // judged lines in this attempt's markdown
	verdicts: JudgePairRecord[];       // unchanged shape, call order
	errors: JudgeErrorRecord[];
	truncated: number;
	outcome: "published" | "incoherent_citation" | "judge_error_unverified" | "judge_budget_exhausted";
	latencyMs: { p50: number; p95: number; max: number } | null;
};
```

`judgeReportOf` (`agent/citation-report.ts`) is a pure function over this state
and returns two things: `published` (the record with `outcome: "published"`, or
the last attempt of an unpublished run) and `attempts` (the same records,
summarised: index, outcome, counts, error causes). Every attempt that reaches
the judge produces a record, including one that answered no pair at all — that
is how attempt C's single timeout becomes visible instead of a bare counter.
The run-level `supported` / `unsupported` / `contradicted` / `latencyMs` are
computed **only** from `published`; `judgeRejections` stays a run-level counter
because it counts attempts, not pairs.

Reading rule: a version-1 run stores the flat shape
(`verdicts`/`rejections`/`truncated`/`errors`). It reads as one attempt with
`attempt: 1`, `legacy: true`, `outcome` derived from the run (`published` when
`state.published !== null`, else `incoherent_citation`). No write migration and
no doc-family version bump: the fields are additive and the reader tolerates
their absence, which is how `artifactBaseline` is already handled.

UI: the judge tab shows the published attempt with an attempt selector
(`attempt 5 of 5 · published`) and one row per attempt carrying its outcome
badge; the traces list's Judge column shows the published attempt only, with a
`4 attempts` badge and an error badge carrying the causes.

### 4.2 Named failures

```ts
type JudgeErrorRecord = {
	line: number;
	citationId: string;
	cause: "timeout" | "transport" | "http_4xx" | "http_5xx" | "protocol" | "aborted";
	ms: number;
	message: string;      // ≤ 200 chars, the binding's existing error text
};
```

The binding (`judge-model.ts`) already produces distinguishable messages
(`decisions endpoint HTTP 429: …`, `judge timed out after …`, `judge returned an
unexpected answer`); `Judge.judge` (`agent/judge.ts`) maps them to `cause`
instead of throwing a bare `Error`, and `coherenceOf` stores the record instead
of `errors++`. The payload never contains the key, the URL or the request body:
the message comes from the `ClassifierResult.errorMessage` the binding already
composes.

The publish rejection reason becomes `judge_error_unverified`. `judge_unavailable`
is retired with no alias: it has two meanings today (layer absent, pair failed)
and the trace cannot tell them apart, so keeping it would keep the confusion.
The layer-absent case never produces a rejection at all (`available()` is
checked before the loop, RFC 0018), so no reader loses a state it could see
before.

### 4.3 A derived budget

Constants with one invariant, asserted at module load and by a unit test:

```
pairDeadlineMs   = JUDGE_PAIR_TIMEOUT_MS            (new, env CITATION_JUDGE_PAIR_TIMEOUT_MS, default 8000)
attemptDeadline  = floor((pairDeadlineMs - BACKOFF_MS) / ATTEMPTS)
assert  ATTEMPTS * attemptDeadline + BACKOFF_MS <= pairDeadlineMs
assert  JUDGE_TIMEOUT_MS (outer, per attempt) >= pairDeadlineMs
```

8000 ms is chosen from the measurement above: it covers the 5.65 s cold path
plus one retry, and it is 22× the steady-state p95. The value is a starting
point; §6 V7 replaces it with the harvested p99.9.

Concurrency: `JUDGE_CONCURRENCY` (default 4) pairs in flight, results written in
line order, so `verdicts` stays deterministic. Wall clock becomes
`ceil(n / 4) × latency` instead of `n × latency`; for attempt E that is 6 rounds
(~1.3 s) instead of 22 calls (~5 s).

Per-run budget: `JUDGE_RUN_BUDGET_MS` (default 30 000) across all attempts of
one publish. On exhaustion the unresolved pairs become `timeout` errors, the
attempt's outcome is `judge_budget_exhausted`, and — under `enforce` — the
publish is still rejected: fail-closed is unchanged. What changes is that the
rejection names the cause, so an operator can tell a dead endpoint from a
hostile document.

Not changed: a layer that answers nothing is still a rejection if the run
entered the loop with `available()` true. That asymmetry (credentials absent →
publish stands; credentials present but everything times out → publish rejected)
is deliberate: a key that disappeared is a configuration fact, an endpoint that
stopped answering after the fact is a verification we now know we did not do.

### 4.4 Verdict reuse within the run

The run keeps `judge.cache: Record<string, CachedVerdict>` keyed by
`sha256(claim ␟ quote ␟ modelId ␟ questionVersion)`, capped at 128 entries,
written in the same commit as the records. A pair found in the cache is stored
as a verdict with `cached: true` and `ms: 0`, never re-called. A republish that
changes one line therefore pays for that line only. Entries are per run, not per
conversation: a later run is a different document and must be judged again.

### 4.5 The score record, and the gate on any floor

`JudgePairRecord` gains:

```ts
probabilities?: { supported: number; unrelated: number; contradicted: number };
endpointConfidence?: number;   // what the binding stored as `score` before
margin: number;                // best supported − best non-supported, per line, −1 when no support
```

`score` keeps its current value for compatibility of meaning and is documented
as *the endpoint's confidence*, which is not the label probability (R5). New
consumers read `probabilities`.

No floor is introduced here. The 74-pair fixture set cannot justify one: d1.1
answers it perfectly, and on the real pairs in this trace the answers that
mattered sat at 0.24–0.53. §6 V7 adds the instrument that can: a harvested pair
set from stored runs, human-labelled, reported as accuracy per confidence bin
with expected calibration error. The floor becomes a follow-up RFC with a stated
bar — the RFC 0017 one (FA cut ≥ 60 %, FR ≤ 10 %) measured on the harvest set,
in the bin that would gate.

## 5. What this does not fix

- **A semantically adjacent quote still publishes.** If one pair on a line is
  labelled `supported`, the line passes, at any confidence. This RFC makes that
  visible (`margin`, `probabilities`) and measurable; it does not change the
  rule.
- **The judge sees one quote, not the document.** A quote that is real and
  topically adjacent is indistinguishable from one that is load-bearing without
  more context. RFC 0019 makes the same observation for web pairs.
- **Long quotes are truncated** (4 of 22 pairs in the shipped attempt). The cap
  stays; the truncation is now attributed to the attempt instead of summed.
- **The endpoint is a single upstream** with an alpha URL and no failover. The
  budget makes its outages cheap and legible, not impossible.

## 6. Verification

Every row is a check that fails on today's code and passes after.

| # | Claim | Check | Expected |
|---|---|---|---|
| V1 | the aggregate describes the published answer | unit test replaying a **redacted** shape fixture (labels, scores, ms, truncated, line numbers; no claim or quote text) that reproduces this run's four judge attempts | `attempts.length === 4` with verdict counts 2/0/23/22; attempt 3 is a `timeout` with no verdicts; published attempt is 5 with 22 records, 18 supported, 4 unsupported, min score 0.24; run aggregate equals the published attempt, not 36/11 |
| V2 | a legacy flat run still renders | unit test with a version-1 `judge` object | one attempt, `legacy: true`, same counts as today |
| V3 | a failure names its cause | `judge.test.ts` fake decisions server with a 6 s delay | one `timeout` record with `ms ≥ pairDeadline`, the endpoint message in `message`, `publishRejected.judge_error_unverified`, and no `judge_unavailable` anywhere |
| V4 | the budget cannot be configured inconsistently | unit test asserting the module-level invariant for the defaults and for three env overrides | `ATTEMPTS * attemptDeadline + BACKOFF_MS <= pairDeadline <= JUDGE_TIMEOUT_MS`; a violating override throws at load |
| V5 | pairs are judged concurrently and deterministically | fake server, 12 pairs, 200 ms each, concurrency 4 | wall clock in [600, 1400) ms and `verdicts` ordered by line |
| V6 | a republish pays only for what changed | scripted judge counting calls; attempt 1 with 6 lines, attempt 2 with one line edited | attempt 2 issues calls for the edited line only; the rest are `cached: true`, `ms: 0` |
| V7 | the deadline is derived from real latency | `agent/scripts/harvest-judge-pairs.mjs` (operator-run, output untracked like the judge-eval artefacts): samples (claim, quote) pairs from a copied session DB, labels them, reports per-bin accuracy and ECE | `JUDGE_PAIR_TIMEOUT_MS` set to the measured p99.9 rounded up; any floor proposal carries FA/FR on this set. Not in CI |
| V8 | the trace surface reads it | `frontend/src/lib/components/judge-verdicts.svelte` renders attempts, causes and probabilities | screenshot of conversation 1487's run: header `attempt 5 of 5 · published`, four attempt rows, published counts 18/4/0, four truncated, attempt 3 showing `1 timeout` |

The unit tests are the gate: `cd agent && npm run typecheck && npm test`. `e2e-test/citations.sh` keeps its scripted faux dance unchanged (no OpenRouter
key exists in e2e, so the layer is absent there); the frontend gate is
`cd frontend && pnpm check && pnpm lint`.

## 7. Deletion test

Remove the per-attempt split and the trace goes back to summing three judged
attempts under one line numbering: the numbers 36/11 describe nothing, and a
reviewer cannot see that the shipped answer carries four unsupported pairs on a
0.24 support. Remove the derived budget and a cold start rejects a publish the
judge would otherwise accept — 5650 ms after a container start, 5729 ms on the
replayed pair, against 4.4 s of attempt timeouts. Remove the failure records and
the only way to diagnose a rejection is to replay it live against a production
endpoint, which is how this RFC's evidence had to be obtained.

## 8. Open questions

1. **Per-line rule.** `any supported` tolerates a line that leans on one 0.24
   support next to three `unsupported` pairs. A margin-based rule
   (`best supported − best non-supported ≥ τ`) is the obvious next step, but τ
   cannot be chosen before V7 exists. Same RFC or a follow-up?
2. **Cold start.** A single warm-up classification at run admission (~0.000003
   USD) would move the 5.65 s off the publish path. Worth the admission latency?
3. **Cost.** Concurrency and reuse cut judge spend in this run by roughly the
   number of republishes. Should the corpus-call budget of RFC 0006 count judge
   pairs too?
