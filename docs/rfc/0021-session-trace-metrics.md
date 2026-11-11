# RFC 0021 — One trace owner: per-session metrics in the trace report

| Field | Value |
|---|---|
| Status | Proposed |
| Author | Affido maintainers |
| Date | 2026-11-06 |
| Target | `agent/`, `frontend/` (schema, trace pages), `e2e-test/` |
| Related | RFC 0006 §5.8 (citation report), RFC 0008 (conversations), RFC 0017/0020 (judge trace), RFC 0019 (web citations). Code: `agent/trace.ts`, `agent/citation-report.ts`, `frontend/src/lib/trace-graph.ts`, `frontend/src/lib/server/trace-store.ts` |

## 1. Summary

A trace report is currently described in four places with four different
semantics: `TraceReader` projects entries (`agent/trace.ts`), `citationsReportOf`
summarises citation runs (`agent/citation-report.ts`), `summarizeDecisions`
aggregates the stored snapshot in the browser (`frontend/src/lib/trace-graph.ts`),
and `traceTotals` sums two columns in SQL (`frontend/src/lib/server/trace-store.ts`).
No place answers, for one conversation: how many tool calls, how many of them
failed, which tools, how many judge decisions, how many citations were used.

This RFC makes `TraceReader` the only producer of a trace report and adds one
`metrics` block to it. The block is computed once, by one pure projection over
the same entries the report already reads, and persisted with the capture. The
frontend renders it; `summarizeDecisions` is deleted. The same RFC fixes
`usage`, which today reports the whole agent's ledger inside a report about one
conversation, and adds the missing session-level judge and citation counts.

The block is windowed, not unlimited: it describes the newest
`MAX_TRACE_LIMIT` (500) entries of the conversation and carries its own bounds
and a `complete` flag. A count is never presented as a session total when the
window is incomplete. This is the central rule: an aggregate that does not name
its scope is not a metric.

"Session" in this RFC means one conversation (RFC 0008), not the agent
container. One `SESSION_DB` holds many conversations; metrics are per
conversation.

Writes are not moved. pi-durable writes entries; `trace-store` writes the
snapshot row. A single class cannot own both sides without forking the durable
runtime. "Write" in `TraceReader`'s scope means: the class decides what a trace
report is, and the snapshot writer stores exactly that.

## 2. The state today

A conversation with three user turns, five assistant entries (one ended
`error`, one `aborted`), four tool calls of which one has no result and one
failed:

| Metric | Where it is computed today | What it actually counts |
|---|---|---|
| errors | `summarizeDecisions.errors` | `toolResult.isError` only |
| total tool calls | `summarizeDecisions.calls` | `toolCall` parts of assistant entries |
| per-tool distribution | `summarizeDecisions.ranking` | `toolResult` entries, not calls |
| judge decisions | `judgeReportOf` per run | the attempt that published, not the session |
| citations used | `run.used` per run | no session scalar; exactness only |
| usage | `foldUsage(runtime.usage())` | every conversation of the agent |

The implementations do not agree with each other:

- `calls` counts a call when the assistant asks for it; `ranking` counts a call
  when a result comes back. With the entry above, `calls = 4`, the ranking sums
  to 3, and the call that never returned is invisible.
- `errors` only sees tool results. The assistant entry that ended `error` and
  the judge attempt that timed out contribute zero.
- `TraceReport.usage` is produced by `Harness.usage()`, which scans every
  conversation and sums each conversation's `UsageDoc`
  (`pi-durable/dist/harness/harness.js:185-194`). The report is about
  conversation 1; the counters are about all of them. `captureTrace` stores
  those counters in `trace_session.tokens`, and `traceTotals` sums them per
  conversation: two conversations with 100k and 10k tokens, both captured after
  the second existed, are reported as 220k, not 110k.
- The judge report is correct per RFC 0020, but it is per run and per published
  attempt. In the run from RFC 0020 §2 the judge emitted 47 verdicts across
  three attempts; the report shows 22 (18 supported, 4 unsupported) and the
  other 25 are not counted anywhere at session level.
- The citation report can say `citationExactness = 2/3` but not `11 citations
  used`. It also stops at the newest 500 entries, like everything else, without
  saying so.

`TraceReader.report()` itself is the read side of one sandbox: it reads a page
of entries (`DEFAULT_TRACE_LIMIT = 50`, clamped to 500), live tasks and
submissions, and folds usage. `#citationReport` scans 500 entries for
`citations.strict` request ids and reads each run's state. The list page calls
`citationsReportSandbox()` on every load, so browsing the index already
activates the sandbox.

## 3. Defects

### R1 — Four aggregators, three semantics

`summarizeDecisions` (`frontend/src/lib/trace-graph.ts:297`) is a pure function
over the stored page. It counts calls from assistant parts and errors from tool
results, so `ranking` totals can differ from `calls`. It is the only place
that computes the five cards and the tool table, and it is not reachable from
the agent, so the API and the UI cannot agree by construction.

### R2 — The window is invisible

The detail page stores 500 entries, the graph draws the newest 150, and the
summary uses as many entries as the capture happened to contain. Nothing in the
stored report says where the window starts, how many entries it covers, or
whether the conversation continues. A 5,000-entry conversation and a 300-entry
conversation produce the same shape of report, and the UI presents both as the
session.

### R3 — Usage is agent-wide

`TraceSource.usage()` has no conversation id and returns the harness total.
`TraceReport.usage` is therefore not the usage of the conversation in the same
object. This is not a display bug: `captureTrace` persists the number in
`trace_session.tokens`/`cost`, and `traceTotals` sums those columns over the
latest snapshot per conversation. The headline "Tokens" on the traces page is
wrong for any user with more than one conversation.

### R4 — Judge decisions are not aggregated

`judgeReportOf` exposes per-run counts from the published attempt, a
`judgeRejections` number that counts attempts, and per-attempt summaries. There
is no session count of verdicts emitted, no split between "all attempts" and
"attempts that shipped", and no aggregate of error causes. A session with two
rejected attempts and one published attempt cannot answer how much judging it
paid for.

### R5 — Citations have no session scalar

`used`, `reported`, `unreportedUsed` and `padded` exist per run. The only
conversation-level numbers are `gatedReplies`, `exactReplies` and
`citationExactness`. "How many citations did this session use" requires
summing the runs in the client, and the client only sees the live report for
the active conversation.

### R6 — Model and transport errors are dropped

`TraceEntry` projects `stopReason` and `model` for an assistant message, but not
`errorMessage`; an assistant entry with `stopReason: "error"` is not counted as
an error anywhere. The error taxonomy is "tool result failed", which is one
class of failure, not the total.

### R7 — Metrics are not an artifact

The snapshot stores the report; the list selects only scalar columns
(`entries`, `tokens`, `cost`); the summary is recomputed in the browser. A
snapshot captured before a frontend change and the same snapshot rendered after
it can show different numbers. There is no stored metrics object to audit.

### R8 — The index wakes the sandbox

`frontend/src/routes/dashboard/traces/+page.server.ts` calls
`citationsReportSandbox()` on load. The index is a Postgres read of stored
captures, but it opens the runtime to fill one citations card. The detail
page's Judge tab already fetches the live per-run report on demand; the index
does not need it.

## 4. Design

### 4.1 One owner and two writers

`TraceReader` is the single owner of the trace contract:

- `report(query)` returns `TraceReport` (with `metrics`) or
  `CitationsTraceReport` (per-run detail, with the same `metrics`).
- The metrics are produced by one pure function, `traceMetricsOf`, in
  `agent/trace-metrics.ts`. It has no storage access and no public consumers;
  `TraceReader` is the only caller. In tests it is exercised with a fixture, not
  with a database.
- `TraceReader` never writes. pi-durable remains the writer of entries;
  `trace-store.captureTrace` remains the writer of the snapshot row.

Rejected alternatives:

- *A shared `packages/trace` workspace.* It would unify the wire types, but the
  agent and the frontend run in different containers with different storage
  (SQLite vs Postgres), and the repo has no workspace package. The contract is
  small enough to mirror; the current `#lib/types.ts` already mirrors
  `TraceReport`.
- *Compute the metrics in the frontend from the stored report.* It preserves
  the duplicate that caused R1 and cannot serve the agent API. It also has to
  keep the `tool:<name>` summary fallback for old snapshots, which is the
  compatibility hack `trace-graph.ts` already carries.
- *Add a `report=metrics` mode.* The report already reads the entries; a second
  mode would activate the sandbox again for a projection of the same window.
  `report=citations` remains because it is a different, per-run audit view.

### 4.2 The metrics contract

```ts
export type VerdictCounts = {
	readonly total: number;
	readonly supported: number;
	readonly unsupported: number;
	readonly contradicted: number;
};

export type TraceMetrics = {
	/** The counts describe this window and nothing else. */
	readonly window: {
		readonly newestEntryId: EntryId | null;
		readonly oldestEntryId: EntryId | null;
		readonly entries: number;
		/** No older entry exists: the window is the conversation. */
		readonly complete: boolean;
	};
	/** User entries: one per prompt. */
	readonly turns: number;
	/** Assistant entries, by stop reason (`stop`, `toolUse`, `length`, `error`,
	 * `aborted`, `pending`, `deferred`; `unknown` on old snapshots). */
	readonly responses: {
		readonly total: number;
		readonly byStopReason: Readonly<Record<string, number>>;
	};
	readonly toolCalls: {
		/** `toolCall` parts of assistant entries: what the model asked for. */
		readonly total: number;
		/** `toolResult` entries: what came back. */
		readonly results: number;
		readonly errors: number;
		/** Assistant entries with at least one call. */
		readonly decisionTurns: number;
		/** `max(0, total - results)`: calls with no result in the window. */
		readonly unanswered: number;
		/** `max(0, results - total)`: results whose call is outside the window. */
		readonly orphanResults: number;
		/** One row per tool seen as a call or a result, sorted by calls desc,
		 * then tool name. A result without a tool name is `unknown`. */
		readonly byTool: readonly {
			readonly tool: string;
			readonly calls: number;
			readonly results: number;
			readonly errors: number;
		}[];
	};
	/** `total` is the arithmetic sum of the three named classes. `aborted` and
	 * `length` are response outcomes, not errors. Citation gate rejections are
	 * friction and have their own counters under `citations`. */
	readonly errors: {
		readonly total: number;
		readonly tool: number;
		readonly model: number;
		readonly judge: number;
	};
	/** null when no readable run carries a judge state. */
	readonly judge: {
		readonly runs: number;
		readonly attempts: number;
		readonly shippedAttempts: number;
		readonly rejectedAttempts: number;
		/** Every attempt: the judge work actually paid for. */
		readonly all: VerdictCounts;
		/** Attempts with outcome `published`: the decisions behind the answers
		 * that shipped. Never the last attempt of an unpublished run. */
		readonly shipped: VerdictCounts;
		readonly errors: number;
		readonly byCause: Readonly<Record<string, number>>;
		readonly truncated: number;
	} | null;
	/** null when no `citations.strict` run id is in the window. */
	readonly citations: {
		readonly runs: number;
		readonly withState: number;
		readonly missingState: number;
		readonly gated: number;
		readonly plain: number;
		/** Neither published nor plain: the run did not exit through the gate. */
		readonly abandoned: number;
		readonly exact: number;
		/** exact / gated; null before the first gated run. */
		readonly exactness: number | null;
		/** Annotation uses, summed per run. The same citationId used in two runs
		 * counts twice. */
		readonly used: number;
		/** Distinct citationIds across the window. */
		readonly uniqueUsed: number;
		/** Reported ids, summed per run; same double-count rule as `used`. */
		readonly reported: number;
		readonly unreported: number;
		readonly padded: number;
		readonly annotateRejected: Readonly<Record<string, number>>;
		readonly publishRejected: Readonly<Record<string, number>>;
		readonly corpusCalls: number;
	} | null;
};
```

`avgCallsPerDecision` stays a UI derivation:
`decisionTurns === 0 ? 0 : total / decisionTurns`. It is not a separate field
because it has no meaning without both numbers.

Semantics that the type makes explicit:

- **Calls and results are different counts.** A call that never returned is an
  unanswered call, not a result. The per-tool table therefore has three
  numbers, and `calls` is the distribution the user asked for.
- **`errors.total` = tool + model + judge.** The classes do not overlap: a tool
  error is a `toolResult.isError`; a model error is an assistant
  `stopReason === "error"`; a judge error is a `JudgeErrorRecord` on any
  attempt. An `aborted` response is visible in `responses.byStopReason` but is
  not counted as an error.
- **Judge `all` and `shipped` are both reported.** `all` answers "how many
  decisions did the judge emit in this session"; `shipped` answers "what did it
  say about the answers that went out". Summing them into one number is the
  defect RFC 0020 R1 fixed at run level; this RFC does not reintroduce it at
  session level.
- **`used` and `uniqueUsed` are different questions.** "How many citations did
  the session use" is `used` (annotation uses). "How many distinct evidence
  points" is `uniqueUsed`. The UI shows `used` and puts `uniqueUsed` next to
  it.
- **Missing run state is a count, not a silent skip.** `runs` is the number of
  distinct strict run ids in the window; `withState` is how many states were
  readable; `missingState` is the difference. Old images and deleted docs are
  visible as a number.

### 4.3 One window, independent of `limit`

`TraceReader.report()` always reads `MAX_TRACE_LIMIT` (500) entries for the
window, regardless of `query.limit`. It returns `items.slice(0, query.limit)` as
the page and computes the metrics from all 500. This makes a metric independent
of the page size: `/inspect?limit=10` and `/inspect?limit=500` describe the same
window, and the page is a view of it.

```
page = entries(MAX_TRACE_LIMIT)        // ≤ 500, newest first
returned = page.items.slice(0, limit)  // what the caller asked for
hasMore = page.items.length > limit || page.next !== undefined
metrics.window.complete = page.next === undefined
```

The current `report()` reads only `limit` entries; with the default of 50, a
500-entry conversation would produce metrics over 50 entries on one request and
over 500 on another. That is R2. The cost of the change is one bounded read of
500 entries instead of 50 on `/inspect`; the detail page reads stored snapshots
and pays nothing. `/inspect` already activates the agent and already scans for
usage, so this does not add a new activation class.

Run states are read for the unique `citations.strict` request ids in the
window, in parallel with a concurrency cap of 8. The cap is a constant, not a
query parameter: it bounds SQLite snapshot reads and keeps the order of the
report deterministic. `report()` reads the window once, before branching: both
`TraceReport` and `CitationsTraceReport` take the same `entries` and run
reports, so `report=citations` builds the per-run list and the metrics from one
read.

The window rule is enforced at the type level: there is no `total` field
anywhere in `TraceMetrics`. A consumer that wants a session total must check
`window.complete`. The UI labels an incomplete window as `newest 500 entries`
and does not print "session total".

### 4.4 Usage becomes the conversation's ledger

`TraceSource.usage` gains the conversation id:

```ts
usage(conversationId: ConversationId): Promise<UsageState | undefined>;
```

`DurableHarness.trace` implements it as
`runtime.snapshot(UsageDoc, conversationId, context)` instead of
`runtime.usage(context)`. `UsageDoc` is already exported by pi-durable and is
the per-conversation ledger (`UsageState` doc: "Ledger of one conversation's own
spend"). `TraceReader` folds that state; a missing state reads as empty.

Consequences:

- `TraceReport.usage` means the conversation in the same object. The detail
  page's Tokens/Cost cards become correct.
- `captureTrace` stores the conversation's numbers in
  `trace_session.tokens`/`cost`; `traceTotals` (latest snapshot per
  conversation) becomes a true per-conversation sum.
- Snapshots captured before this RFC keep agent-wide numbers in those columns.
  There is no reliable way to split them after the fact: the old numbers are
  the sum over conversations that existed at capture time, and the per-
  conversation ledgers were not stored. They stay as they are and are labelled
  as legacy (the `metrics` column is null for them; the UI can use that as the
  discriminator). No backfill.

### 4.5 Persistence, list and UI

Schema: add one nullable `jsonb` column to `trace_session`:

```ts
metrics: jsonb('metrics').$type<TraceMetrics | null>()
```

`captureTrace` writes `metrics: report.metrics`; `listTraceSessions` selects
it. The full report keeps its own copy (the snapshot remains the exact wire
artifact); the column exists so the list does not deserialize 500 reports.

`traceTotals` sums over the latest snapshot per conversation, as today, and
gains the headline numbers from the JSON (the subquery must select `metrics`
next to `tokens` and `cost`):

```sql
coalesce(sum(coalesce((latest.metrics #>> '{toolCalls,total}')::int, 0)), 0)  -- toolCalls
coalesce(sum(coalesce((latest.metrics #>> '{errors,total}')::int, 0)), 0)     -- errors
coalesce(sum(coalesce((latest.metrics #>> '{judge,all,total}')::int, 0)), 0)  -- judgeAll
coalesce(sum(coalesce((latest.metrics #>> '{citations,used}')::int, 0)), 0)   -- citations
```

Rows with `metrics = null` contribute zero and are counted separately as
`legacyCaptures`. The totals are sums of the latest windows, not all-time
numbers; the dashboard label says "latest capture per conversation".

UI:

- **Detail page.** The five cards and the tool table read
  `report.metrics` instead of `summarizeDecisions(report)`. Extract them into
  `frontend/src/lib/components/trace-metrics.svelte` so the projection has one
  component and one test; the page passes `report.metrics`. The cards keep
  their labels (Turns, Tool decisions, Tool calls, Errors, Avg calls/decision);
  the Errors card gets three subcounts (tool / model / judge). The tool table
  uses `byTool`, so a call with no result appears with `0 results`. The graph
  itself (`buildDecisionGraph`) is unchanged. The Judge tab is unchanged and
  stays live; it is a per-run audit, not a metric.
- **Index page.** The sessions table gains four columns: tool calls, errors,
  judge decisions (`judge.all.total`), citations used. The header stats keep
  Captures, Conversations, Tokens, Cost and add the same four totals from
  `traceTotals`. The live Citations card is removed from the index: the per-run
  table already lives on the detail page, and the index stops waking the
  sandbox (R8). `citationsReportSandbox` is no longer called from
  `+page.server.ts`.
- **Old snapshots.** `report.metrics` is absent and the `metrics` column is
  null. The detail page renders the graph and entries, hides the metric cards,
  and shows "metrics not captured (pre-RFC 0021)". The index shows `—` in the
  new columns. No recomputation from the old report: that would keep the
  duplicate implementation alive and produce numbers with the old semantics.

`CitationsTraceReport` loses its top-level `gatedReplies`, `exactReplies` and
`citationExactness`; they are `metrics.citations.gated`, `exact` and
`exactness`. The per-run `runs` array is unchanged. The frontend mirror
(`CitationsReport` in `#lib/types.ts`) drops the same three fields.
`e2e-test/citations.sh` and `agent/citation-agent.test.ts` read the new path.

### 4.6 Wire compatibility

- `TraceReport.metrics` is required on the agent side and optional in the
  frontend wire type, because stored snapshots predate it and a rolling deploy
  can meet an old agent image. The frontend treats `undefined` as "not
  captured", never as zeros.
- `TraceReport.usage` keeps its shape and changes its meaning (agent-wide to
  conversation). This is deliberate and is the fix for R3; it is not
  backward-compatible in value. The README line about folded usage is updated
  to say "the conversation's folded usage".
- `parseTraceQuery` is unchanged: no new mode, no new parameter. `limit` still
  clamps to 500; it now selects the page, not the metric window.
- `GET /entry` is unchanged.
- The wire ids in `TraceMetrics.window` are numbers, not branded `EntryId`s;
  the frontend mirror uses `number`. This is the same convention as
  `TraceEntry.id`.

## 5. What this does not fix

- **The window is still not the session.** 500 is the current cap. A
  full-conversation metric needs pagination with a latency budget (or a
  storage-side aggregate), which this RFC does not add. The `complete` flag
  makes the limitation visible; it does not remove it.
- **Model error causes are not classified.** A model/transport failure is
  counted as `errors.model` from `stopReason: "error"`, but the report does
  not project `errorMessage`, so it cannot say `timeout` vs `http_5xx`. The
  message is still in `/entry`. A cause taxonomy for model errors is a
  projection change, not a metric change.
- **No per-tool latency.** `durationMs` per result exists, but the requested
  metrics are counts. Percentiles per tool would be a separate contract (and a
  per-tool sample, not a sum).
- **No cost attribution per tool or per run.** `usage` is conversation-level;
  the runtime's `UsageState` buckets by model and tool name but the report
  folds them. The raw buckets are still in the snapshot if a later RFC needs
  them.
- **The Judge tab is still live.** A stored snapshot freezes the metrics, not
  the per-run verdict table; the detail page fetches that from the sandbox on
  demand. Storing the citation report with the capture would make the audit
  self-contained and is a separate decision.
- **No UI distributions beyond the tool table.** The judge classes are counts,
  not a confusion matrix; P/R/F1 stay in the offline eval scripts
  (`agent/scripts/eval-zero-shot-judges.mjs`), as before.
- **`endedReason` is not reported.** `CitationRunState.endedReason` is declared
  but never written; a run that neither publishes nor answers plain is counted
  as `abandoned`, without a cause. Fixing the writer is a citation-run change,
  not a trace change.

## 6. Verification

Every row fails on today's code and passes after.

| # | Claim | Check | Expected |
|---|---|---|---|
| V1 | one projection counts calls, results and errors correctly | unit test for `traceMetricsOf` with a fixture: 3 user entries, 5 assistant (2 `toolUse`, 1 `error`, 1 `aborted`, 1 `stop`), 4 calls, 3 results (1 error), 1 unanswered call | `turns = 3`; `responses.byStopReason = {toolUse: 2, error: 1, aborted: 1, stop: 1}`; `toolCalls = {total: 4, results: 3, errors: 1, decisionTurns: 2, unanswered: 1, orphanResults: 0}`; `byTool` has the unanswered tool with `calls: 1, results: 0`; `errors = {total: 2, tool: 1, model: 1, judge: 0}` |
| V2 | judge `all` and `shipped` are not the same number | unit test with three run reports: run A has two attempts (first `timeout` with 1 error and 2 verdicts, second `published` with 3 verdicts), run B is a legacy published run with 1 contradicted, run C has no judge | `judge.runs = 2`; `attempts = 3`; `rejectedAttempts = 1`; `all = {total: 6, …}`; `shipped = {total: 4, …}`; `errors = 1`; `byCause.timeout = 1`; run C contributes to `citations.runs` but not `judge.runs` |
| V3 | citations have a session scalar | unit test with three runs: two gated (one exact), one plain; `used` lengths 5/4/3, one unreported, one publish rejection `uncited_line` | `gated = 2`, `plain = 1`, `abandoned = 0`, `exact = 1`, `exactness = 0.5`, `used = 12`, `uniqueUsed = 11` (one id repeated), `reported = 11`, `unreported = 1`, `publishRejected.uncited_line = 1`; `agent/citation-agent.test.ts` reads `metrics.citations.exactness` and passes |
| V4 | usage is the conversation's, not the agent's | fake `TraceSource.usage(id)` returns 10 for conversation 1 and 99 for conversation 2 | `report(conversation 1).usage.totalTokens = 10`; the report for 2 shows 99; the fake records one call with the requested id |
| V5 | the window names itself | fake page of 500 entries with `next` set; second case 499 with no `next` and `limit=500` | case 1: `window.entries = 500`, `complete = false`, bounds equal the oldest/newest ids, `hasMore = true`; case 2: `complete = true`, `hasMore = false` |
| V6 | metrics do not depend on `limit` | same fake page, `report({limit: 10})` and `report({limit: 500})` | `entries.returned` is 10 and 500; `metrics` is deep-equal; `window.entries = 500` in both |
| V7 | the capture persists the metrics and the list reads them | dev check: drizzle migration adds the column; `captureTrace` writes `report.metrics`; `listTraceSessions` returns it; `traceTotals` sums the latest row per conversation and counts legacy rows separately | `pnpm db:migrate` applies on the dev DB; a captured row has `metrics.toolCalls.total`; two conversations with 4 and 6 calls total 10, not 8 or 20; a null row is `legacyCaptures = 1` |
| V8 | the UI no longer aggregates | `summarizeDecisions` and `DecisionSummary` are gone from `trace-graph.ts`; `trace-graph.test.ts` keeps the graph tests; a component test renders the detail cards from a `TraceReport` fixture | `pnpm check` passes; the cards show 4 calls, 2 errors with a 1 tool / 1 model / 0 judge split, `2.0` avg calls/decision from the fixture; a snapshot without `metrics` shows the "not captured" note; the index no longer calls `citationsReportSandbox` |
| V9 | the stack still captures and reads a trace | `e2e-test/happy-path.sh` asserts `metrics.window.complete` and `metrics.toolCalls.total >= 1`; `e2e-test/citations.sh` asserts `metrics.citations.gated = 1` and reads `metrics.citations.exactness` instead of `citationExactness` | both pass through Caddy at `localhost:18080` |

Gates: `cd agent && npm run typecheck && npm test`; `cd frontend && pnpm check && pnpm lint && pnpm test:unit -- --run`; the migration is generated with `pnpm db:generate` and applied with `pnpm db:migrate` against the dev DB (V7). `./verify.sh` covers the agent wire and the e2e path through Caddy (V9); it does not render the SvelteKit pages, so V8's rendering needs the frontend gate plus a manual UI check. The frontend migration is never hand-written.

## 7. Deletion test

Remove the `metrics` block and the old implementations return: the detail
page counts calls from assistant parts while the tool table counts results, the
index has no number at all, and a model error is still invisible. Remove
`window` and a 500-entry slice is presented as a session; remove the usage fix
and every conversation reports the agent's ledger, so `traceTotals` double
counts. Remove the judge `all`/`shipped` split and the session repeats RFC 0020
R1: the 47 verdicts of the motivating run collapse to the 22 that shipped, and
the two rejected attempts disappear. Remove the `metrics` column and the list
has to deserialize every report to show a number, or recompute it in the
browser, which is R1 and R7 again.

## 8. Open questions

1. **Window size.** 500 is the current read cap. Is a `?window=all` capture
   (paginated, capped at e.g. 5,000) worth the latency, or is a labelled
   newest-500 window the product answer? The type does not change either way.
2. **What belongs in `errors.total`.** This RFC includes judge infrastructure
   failures. If the product meaning of "errors" is user-visible failures only,
   `errors.total` becomes tool + model and the judge count moves next to it.
   The three classes stay separate regardless.
3. **Which citation number is the headline.** The RFC shows `used` and
   `uniqueUsed`. "Citations used" could mean annotation uses (12 in the V3
   fixture) or distinct evidence points (11). The proposed UI picks `used`;
   the label should say "annotations", not "citations", if that is the choice.
4. **Should the snapshot store the per-run citation report too.** That would
   make the Judge tab audit-stable and remove the live fetch from the detail
   page, at the cost of a second report in every capture. It is a clean
   follow-up to this RFC, not part of it.
5. **Old snapshots.** No backfill is proposed. Is "metrics not captured" on
   pre-0021 rows acceptable, or is a one-off offline recomputation (with the
   old semantics, explicitly labelled) wanted?
