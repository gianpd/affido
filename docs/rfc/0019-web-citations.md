# RFC 0019 — Web-derived claims as first-class citations

| Field | Value |
|---|---|
| Status | Proposed |
| Author | Affido maintainers |
| Date | 2026-11-03 |
| Target | `agent/`, `frontend/`, `sandbox-manager/` (env forwarding), `e2e-test/` |
| Related | RFC 0006 (deterministic gate), RFC 0008 (sessions), RFC 0012 (BYOK), RFC 0013 (key-injection sidecar), RFC 0014 (ingestion and registry), RFC 0016 (web-search node), RFC 0017 (coherence judge), RFC 0018 (d1.1 default judge) |

## 1. Summary

The web tools of RFC 0016 can put a page in front of the model, but the
citation system of RFC 0006 has no way to accept that page as evidence. A
strict run can only cite `corpus/` documents. The result is not a clean
refusal: the model either drops the web-derived claim or attaches a corpus
citation to it. The coherence judge of RFC 0017/0018 can catch some of those
misattributions, but it receives only the corpus quote; it never sees the URL,
the page text, or the fact that the claim came from the web.

This RFC adds web pages as a second citation kind:

- a durable, per-run record of the searches and reads, written by the agent,
  never by the web-search node;
- a `web_annotate` tool that turns an exact quote from a page read in this run
  into a `cit_...` id;
- an `answer_publish` gate that accepts both corpus and web evidence;
- an envelope and UI that distinguish `kind: "corpus"` from `kind: "web"` and
  list every page read as a server-built `webSources` entry;
- the same judge port, unchanged: `{claim, quote}`. The URL is attribution
  metadata, not judge input. Web pairs get their own mode until a web fixture
  set has been measured.

The node stays volume-less and volatile. The record lives in the agent's
session database, keyed by `runId`, and survives pause, restart and the node's
one-hour TTL.

## 2. Motivation: the trace that exposed the gap

Run `23Du1SEEshXE6esW` (conversation 1369, `deepseek/deepseek-v4.1-flash`,
strict citations and web allowed) searched four times, read seven pages, made
eleven corpus calls and annotated five corpus quotes. It needed five publish
attempts:

| Entry | Attempt | Result |
|---|---|---|
| 1451 | report with URLs on web claims, no citation tokens | rejected `uncited_line` (1453) |
| 1455 | corpus tokens attached to web claims | rejected `incoherent_citation` at line 6 (1457) |
| 1459 | near-total rewrite, one web line left at line 20 | rejected `incoherent_citation` at line 14 (1461) |
| 1471 | same shape, web line still at line 20 | rejected `incoherent_citation` at line 20 (1473) |
| 1475 | every web claim and URL removed | published (1477) |

The model stated the problem itself at entry 1455: "web-sourced lines (which
need corpus citations or must be attached to a token)". It then attached
`cit_25f775dd2d` and `cit_5897859938` to sentences from Man Group, Understanding
AI and New Market Pitch. Those tokens quote `capex_apex_ai.txt`; they do not
support the claims. The gate accepted the tokens because they were real,
verified annotations of this run.

The judge never saw the misattribution: it walks lines in order and returns at
the first failing line. In attempt 1455 it stopped at line 6, before reaching
the web lines 12-18. The only explicit web line it did judge was line 20 in
attempts 1459 and 1471 ("Le fonti web consultate confermano ... ~98% ..."):
`unsupported` 0.766 against `cit_2be2d3ad71` ("50 B200 GPUs ..."). Correct, but
it took three attempts and the model's eventual fix was to delete the web
evidence. The four judged attempts produced 38 pair verdicts in total.

The published answer is a corpus-only report: 36 lines, five corpus citations,
no URL, no web-derived claim. `evidence` is `cited`, `webMode` is `allowed`,
and the seven pages survive only in the trace entries (`web_read` results)
and, for an hour, in the node's memory. The user asked for web research and
received a report that silently discarded it. That is the failure this RFC
addresses.

## 3. Current behavior and the gap

### 3.1 The web node is volatile by design

`agent/websearch.ts` keeps one `RunState` per registered run: the per-run
token, search/read counters, and `sources: Map<sourceId, {url, title}>`.
`MAX_RUNS` is 64 and `RUN_TTL_MS` is one hour; the node has no writable volume
(RFC 0016 §2). It is an authorisation and resolution table, not a record. After
a node restart or the TTL, an old `sourceId` cannot be resolved; after a pause
of the agent, the node may still be alive, but the agent cannot rely on it.

`POST /search` returns `{sourceId, title, domain, snippet}` and deliberately
withholds the URL. `POST /read` returns `{untrusted, url, title, text, sha256}`
with `text` capped at 6000 characters. The model never passes a URL to a tool.

### 3.2 The gate knows one evidence kind

`answer_publish` calls `evaluatePublish` with `Annotation[]` from
`CitationRunState.annotations`. An `Annotation` has `docId`, `docVersion`,
`start`, `end`, `line`, `quote`, `textSha256`, `runId`, `status: "verified"`.
`lineCarriesToken` accepts any `[cit_...]` bracket group, but every id must
resolve to one of those corpus annotations. There is no web kind, so a URL in
the markdown is just text and a line carrying it is `uncited_line`.

The only web-adjacent exit is `answer_plain`. In a strict run it is allowed
only when the run has no annotations at all; in a free run the current check
(`run.strict && annotations.length > 0`) does not block it. A strict web-only
run can therefore publish prose without evidence; the judge never runs.

### 3.3 The judge sees only corpus quotes

`coherenceOf` takes `markdown` and `quoteOf(citationId)`; `quoteOf` reads
`state.annotations[citationId].quote`. The judge input is exactly
`{claim, quote}` — `claimOf(line)` strips the tokens, the quote is the corpus
span. The URL, `sourceId`, title, page text and `sha256` never enter.

`coherenceOf` returns at the first failing line, so a long report with a
failure early in the document leaves the rest unjudged. The aggregation rule
is per line: at least one `supported` pair and no `contradicted` pair. A line
with a corpus token and a web token can pass on the corpus token alone.

### 3.4 The envelope has no web provenance

`#envelope` in `agent/agent.ts` reads only `CitationRunState`. A published
answer returns `citations` from `state.annotations`; `#citationViews` looks up
`#store.documents()` by `docId`. A free or plain answer returns
`evidence: "plain"` and `citations: []`. There is no field that says "this run
read these pages". The trace has the pages, but `GET /inspect?report=citations`
only collects `citations.strict` runs and reads `runState`; it does not read
web results.

### 3.5 The prompt contradicts itself

`webSection` in `agent/web-tools.ts` says: "cite its URL when you rely on it".
`strictSection` in `agent/citation-tools.ts` says: "every non-heading,
non-blank line carries at least one `[cit_...]` token". In a strict run with
web on, both instructions apply to the same sentence. The model is left to
choose between an unverifiable URL and a corpus token that does not support
the claim. The trace shows it choosing the token.

### 3.6 The trace is not a record

The `pi.tool-result` entries are durable in the session database and contain
the search results and the page texts. They are the model's context, not a
queryable evidence ledger: `#envelope` does not read them, the citation report
does not read them, and `reset()`/compaction can change what the model sees.
Scraping tool-result entries in the publish path would make the gate depend on
the shape of the transcript and on what the model was allowed to see. That is
the wrong substrate for verification.

## 4. Goals and non-goals

Goals:

- A strict run with web enabled can publish a web-derived claim with a
  server-verified citation. The citation is an exact quote from a page read in
  that run, not a URL.
- The record of what the run searched and read is durable, run-scoped, and
  independent of the node's memory and of the model's context.
- The judge receives the same `{claim, quote}` input for corpus and web; the
  report separates the two so their accuracy can be measured independently.
- A free or plain run tells the user which pages were read, marked unverified.
  The model cannot type that list.
- No new egress, no URL argument to a model tool, no change to the web
  node's topology, no new key.

Non-goals:

- Proving that a page still says today what it said at read time. The record
  is a snapshot (`readAt`, `pageSha256`); it is attribution, not live truth.
- Citing search snippets. A result is a pointer; only a read page is evidence.
- Automatic claim extraction, page-level entailment, or a live re-fetch.
- Mechanically proving that a claim came from the web. The gate can verify the
  quote exists; the model's choice of token is still an attestation. The
  correct-path affordance and the judge reduce misattribution; they do not
  eliminate it.
- Changing corpus ingestion, the taint gate, or the sidecar key surface.

## 5. Design

### 5.1 Evidence model

Two evidence kinds share one `cit_` namespace and one gate. The `kind` field
distinguishes them for the envelope, the report and the UI.

```ts
type CitationKind = "corpus" | "web";

// Existing shape; `kind` is added on write and defaults to "corpus" when an
// older stored annotation has no field.
type CorpusAnnotation = {
  kind: "corpus";
  citationId: string;
  runId: string;
  docId: string;
  docVersion: number;
  start: number;
  end: number;
  line: number;
  quote: string;
  textSha256: string;
  status: "verified";
  at: number;
};

type WebAnnotation = {
  kind: "web";
  citationId: string;
  runId: string;
  sourceId: string;
  url: string;
  title: string;
  pageSha256: string;
  readAt: number;
  start: number;
  end: number;
  line: number;
  quote: string;
  status: "verified";
  at: number;
};

type Evidence = CorpusAnnotation | WebAnnotation;
```

`citationIdOf(runId, docId, docVersion, quote)` already produces a
deterministic `cit_<10 hex>` id. Web ids use a sibling function whose hash input
includes `"web"`, the `runId`, the `sourceId`, the `pageSha256` and the quote,
so a web id cannot collide with a corpus id and a page re-read under a new
`sourceId` gets a new id. The prefix stays `cit_`: the gate regex, `claimOf`,
the markdown renderer and the UI's numbered references all keep working.

Why a union and not a second `webCitations` array: one gate, one declared set,
one judge walk, one "Sources used" panel. Two arrays would duplicate every
rule and let one kind drift from the other.

### 5.2 The durable web run record

New doc family, conversation-scoped, keyed by `runId` — the same key as
`CitationRunDocs`:

```ts
type WebSearchRecord = {
  callId: string;
  query: string;
  lang?: string;
  max: number;
  at: number;
  results: { sourceId: string; title: string; domain: string; snippet: string }[];
};

type WebSourceRecord = {
  callId: string;
  url: string;
  title: string;
  /** The page text the model saw, capped at 6000 characters by the node. */
  text: string;
  textSha256: string;
  readAt: number;
};

type WebRunRecord = {
  searches: WebSearchRecord[];
  sources: Record<string, WebSourceRecord>;
};

export const WebRunDocs = defineDocFamily<WebRunRecord, { runId: string }>({
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  kind: "web.run",
  version: 1,
  initial: () => ({ searches: [], sources: {} }),
});
```

Write points, both inside the tool body, before the result is returned:

- `web_search`: after `postNode("/search")` succeeds, append one
  `WebSearchRecord` in an `api.commit`. The record has no result URLs: the
  model never saw them, unread results are not evidence, and the node still
  owns the only `sourceId -> URL` table for them. If the commit fails, the call
  fails and the results are not returned.
- `web_read`: after `postNode("/read")` succeeds, write
  `sources[sourceId] = {callId, url, title, text, textSha256, readAt}` and
  `markWebTaintTx` in the same `api.commit`. If the commit fails, the tool
  returns an error and no result reaches the model.

Both records carry `api.callId`. A retry of `web_read` finds the source
record and returns the stored page without calling the node again. A retry of
`web_search` replaces the record under the same `callId` and returns the fresh
results: the node may spend the search again, but stale source ids are never
replayed. `web_annotate` is idempotent by construction (`citationId` is
deterministic from the run, source and quote), so a retry overwrites the same
annotation.

One crash window remains, and this RFC does not close it: the node marks a
source as read before it answers, and the agent commits after. A crash in
between loses that page; the retry gets the node's `already_read`, not a page.
Nothing wrong can be published from it, and the model can read another page.
Closing the window needs a node-side per-run page cache or an idempotency key
on `/read`; that is a change to RFC 0016's tested contract, noted in §11.

The node is not modified. It remains volume-less and may forget everything on
restart; `web_annotate` never calls it.

Why not store the record in `CitationRunState` (the existing per-run doc)?
Because the page text is the largest field by an order of magnitude and is
only needed by `web_annotate` and the re-verification endpoint. Keeping it in a
separate family keeps every corpus call and every publish commit small. The
citation declarations (`WebAnnotation`) do live in `CitationRunState`, next to
`annotations`, so the gate and the envelope read one doc.

The trace stays as it is. The record is not derived from trace entries and is
not exposed raw to the model.

The flow of one run:

```
web_search   -> node /search -> agent writes web.run.searches
web_read     -> node /read   -> agent writes web.run.sources + web.taint
web_annotate -> reads web.run.sources -> writes citations.run.webAnnotations
answer_publish -> gate over both evidence maps -> judge -> envelope
```

### 5.3 `web_annotate`

A sixth tool in the web extension, registered with the others but refusing
outside a strict run with web authorized:

```
web_annotate { sourceId, quote }
```

There is no URL parameter, for the same reason `web_read` has none: the model
must not turn a page into a fetch target or invent an attribution.

Checks, in order:

1. The current run exists (`not_a_strict_run`, with the no-run detail; the
   corpus tools use the same reason).
2. The run is strict (`not_a_strict_run`: a free run answers from prose, not
   from the gate).
3. The run has `web: true` (`web_not_authorized`).
4. `sourceId` is in `web.run.sources`. If it is in `searches` but not in
   `sources`, refuse with `source_not_read` — the model saw a snippet, not the
   page. If it is in neither, refuse with `unknown_source`.
5. `quote` is non-empty and at most 1000 code points (`quote_mismatch`,
   `quote_too_long`).
6. `quote` is an exact `indexOf` span of the stored text
   (`quote_mismatch`). No re-fetch, no fuzzy match. The model copies from the
   `web_read` output it already received.
7. Build a `WebAnnotation`, add it to
   `CitationRunState.webAnnotations`, and return
   `{citationId, sourceId, start, end, line}`. The tool output does not repeat
   the page text or the URL; the model already has them from `web_read`.

The annotation count is bounded by the model's turn budget; unlike
`corpus_annotate` there is no separate corpus-call counter, and no node call is
spent.

Why exact span: the gate's promise is "the quote exists in the source". A
normalized match would make the stored span and the cited text diverge, and
the judge would receive a quote the page does not contain. The corpus path uses
the same rule (`workspace-store.ts`, `annotate`).

### 5.4 Gate changes

`evaluatePublish` keeps its order and its reasons. Its input becomes the
merged evidence list:

```ts
const evidence = [
  ...Object.values(state.annotations),
  ...Object.values(state.webAnnotations ?? {}),
];
const check = evaluatePublish({ markdown, declared, evidence, runId });
```

- `declared` may mix corpus and web ids.
- `unknown_citation`, `unverified_citation`, `foreign_citation` are unchanged
  and now cover web ids.
- `undeclared_token`, `unused_citation`, `uncited_line` are unchanged.
- A line may carry both kinds. The gate does not police which quote belongs to
  which claim; that is the judge's and the prompt's job.

In a strict run, `answer_publish` is the only exit for a run with any
evidence. `answer_plain` keeps its current rule: `citations_unused` only when
`run.strict` is true and annotations exist; a free run can still discard corpus
annotations, an existing edge this RFC does not change. Web annotations count
as annotations in the strict check.

`CitationRunState` gains:

```ts
webAnnotations: Record<string, WebAnnotation>;
```

It is initialized to `{}`; an older stored run without the field reads as
empty. `publishRejected`, `annotateRejections` and the report's `used` /
`reported` merge the two maps. The `exact` check is set equality over the
merged ids, so a web annotation that is not declared in `answer_publish` is
still `unreportedUsed`.

### 5.5 Judge

The port does not change:

```ts
CitationJudge.judge({ claim, quote }): Promise<JudgeVerdict>
```

`quoteOf` becomes a merged lookup:

```ts
const quoteOf = (id: string) =>
  state.annotations[id]?.quote ?? state.webAnnotations?.[id]?.quote;
```

The judge never receives `url`, `title`, `sourceId`, `pageSha256` or
`readAt`. Those are attribution; the classifier's question is whether the
claim is coherent with the quote. Adding metadata would change the frozen
prompt of RFC 0018 and invalidate its eval.

`JudgePairRecord` gains `source: "corpus" | "web"` (optional when reading
records written before this RFC). The stored `CitationRunState.judge` gains
`webMode` next to `mode`; `CitationRunReport.judge` gains per-source counts;
the trace UI shows a source column.

Modes:

| Env | Values | Default | Scope |
|---|---|---|---|
| `CITATION_JUDGE` | `off` `warn` `enforce` | `enforce` | corpus pairs |
| `CITATION_JUDGE_WEB` | `off` `warn` `enforce` | `warn` | web pairs |

`CITATION_JUDGE=off` disables the layer entirely, including web. When it is
`warn` or `enforce`, each pair is judged under its own mode:

- `off`: the pair is not judged.
- `warn`: the verdict is recorded; the pair never rejects.
- `enforce`: a `contradicted` pair rejects with `incoherent_citation`; if no
  enforcing pair is supported, the line rejects with `incoherent_citation`, or
  `judge_unavailable` when the failure was a judge error or timeout.

A line passes iff no enforcing pair is `contradicted` and, when the line has at
least one enforcing pair, at least one enforcing pair is `supported`. `warn`
and `off` verdicts are recorded but do not decide. A line whose pairs are all
`warn` or `off` therefore passes on the deterministic gate alone, exactly as
RFC 0006. If a line has a corpus pair in `enforce` and a web pair in `warn`,
the corpus pair can reject; the web verdict is data. If both modes are `off`,
no judge call is made.

`coherenceOf` gains a `modeOf(citationId)` resolver and evaluates pairs
accordingly; the "first failing line wins" detail is preserved. This is the
only judge change. `AgentOptions` and `createAgentRegistry` gain
`judgeWebMode`; boot reads `CITATION_JUDGE_WEB` next to `CITATION_JUDGE`. A
judge that is not available (no OpenRouter credential backs the run) is
absent, not erroring: `enforce` never rejects a publish for lack of a key,
the RFC 0018 rule.

Why default `warn` for web: RFC 0018's 74 fixtures are contract clauses, 41
Italian and 33 English, not noisy web pages and not cross-lingual claim/quote
pairs. The trace's web claims are Italian and the quotes are English. d1.1's
perfect score on the frozen set does not transfer automatically. The web mode
flips to `enforce` only after a web fixture set meets both bar criteria from
RFC 0017 §8: false accepts on unrelated/contradicted cut by at least 60% and
false rejects on supported at most 10%.

### 5.6 Envelope, report and UI

`CitationView` becomes a discriminated union:

```ts
type CitationView =
  | {
      kind: "corpus";
      citationId: string;
      docId: string;
      title: string;
      filename: string;
      version: number;
      start: number;
      end: number;
      line: number;
      quote: string;
      textSha256: string;
      status: "attribution_verified" | string;
    }
  | {
      kind: "web";
      citationId: string;
      url: string;
      title: string;
      readAt: number;
      start: number;
      end: number;
      line: number;
      quote: string;
      pageSha256: string;
      status: "page_quote_verified" | string;
    };
```

`PromptResult` gains a second, server-built list:

```ts
type WebSourceView = {
  url: string;
  title: string;
  readAt: number;
  pageSha256: string;
  /** The ids that annotate this page and were declared in the publish;
   * empty when the page was read but not cited. */
  citationIds: readonly string[];
};

readonly webSources: readonly WebSourceView[];
```

`webSources` is built from `web.run.sources` plus `state.webAnnotations`, never
from model text. It is present for free, plain and cited runs, so a free run
still tells the user which pages were read. In a free/plain run it is marked
unverified by the absence of `citations`; the UI labels it explicitly.

`#envelope` rules:

- `state.published !== null` → `evidence: "cited"`, `citations` from both
  maps, `webSources` from the record.
- `state.plain !== null` → `evidence: "plain"`, `citations: []`, `webSources`
  still populated.
- strict run without an exit → `evidence: "none"`, `citations: []`,
  `webSources` still populated; the reason is unchanged.

`GET /corpus/citations?runId=` returns both kinds. For a web annotation it
re-verifies against `web.run.sources`: the quote is an exact span and
`pageSha256` matches the stored text; the status is `page_quote_verified`. A
missing source doc yields `source_unavailable`; it never re-fetches.

`citationExactness` now covers both kinds. The report also exposes per-kind
counts (`used`, `reported`, judge verdicts) so a corpus regression is not hidden
by web citations, and the traces page keeps the two rows separate.

Frontend changes:

- `frontend/src/lib/types.ts`: `Citation` becomes the union above; add
  `WebSourceView` and the `data-web-sources` part.
- `frontend/src/lib/components/citations.svelte`: the panel becomes "Sources
  used" with two groups. Corpus keeps the document grouping, version badge and
  `/dashboard/documents?doc=...#L...` link. Web shows the title, a
  `page_quote_verified` badge and a `read at` timestamp; the URL is an external
  link with `rel="noopener noreferrer"`.
- `frontend/src/lib/components/citation-tooltip.svelte`: web branch shows URL,
  `readAt` and the quote; no version.
- `frontend/src/lib/components/markdown.svelte`: no change; numbered refs use
  `citationId` only.
- `frontend/src/routes/api/chat/+server.ts`: map the union, stream and store a
  `data-web-sources` part next to `data-citations` and `data-artifacts`.
- `frontend/src/routes/dashboard/chat/+page.svelte`: render the web-source
  panel from the part; a page read but unused is shown with "not cited".
- `frontend/src/routes/dashboard/traces/[id]/+page.svelte` and
  `judge-verdicts.svelte`: show the source kind per verdict; the citation
  report gains the web counts.
- The panel follows RFC 0011 tokens; no new hex colours or radii.

### 5.7 Prompt contract

`webSection` is rendered when the run has web. It gains:

- A search result is a pointer, not evidence. Only a page read with `web_read`
  can be cited.
- In a strict run: `web_annotate {sourceId, quote}` with an exact quote from
  the `web_read` text; the returned `[cit_...]` is the citation. A URL in prose
  is for the reader, not a citation.
- One claim per line, one source per claim. A synthesis over two pages is
  split into two lines, each with its own token.
- Never attach a corpus token to a web claim, or a web token to a corpus
  claim. The gate cannot tell; the judge can only see the quote, not the
  claim's origin.
- In a free run: `web_annotate` is unavailable; the server lists the pages read
  as unverified web sources. If the user wants verified web citations, enable
  Strict citations for the message.

`strictSection` gains: web quotes are evidence too; a web claim needs its own
web citation; a corpus token is not a substitute. The old sentence "cite its
URL" is removed or qualified as display-only.

The strict section is rendered only in a strict run, as today. The web section
checks `run.strict` through `readCurrentRun`, so the same text is not shown in
a free run.

### 5.8 Free and plain runs

Free runs do not get `web_annotate`. They keep today's answer path:
`evidence: "plain"`, `citations: []`, plus `webSources` (unverified). A strict
run that reads pages but exits through `answer_plain` is allowed only when it
has no annotations, as today; `webSources` still lists the pages.

This keeps the product contract simple: "Strict citations" is the evidence
mode for both corpus and web; "Web" is the capability. A user who wants a
verified web claim enables both.

### 5.9 New refusal reasons

Add to `VerifyReason`:

- `unknown_source` — a `sourceId` never issued to this run.
- `source_not_read` — the id came from a search result, but the page was not
  read; snippets are not evidence.
- `web_not_authorized` — the run did not have web enabled. The web tools already
  return this code as JSON; the citation tool needs it as a gate reason so the
  rejection lands in the same counters.

Existing reasons reused: `not_a_run` (the web tools' JSON code), `not_a_strict_run`,
`quote_mismatch`, `quote_too_long`, `unknown_citation`, `unverified_citation`,
`foreign_citation`, `undeclared_token`, `unused_citation`, `uncited_line`,
`citations_unused`, `incoherent_citation`, `judge_unavailable`,
`turn_budget_exhausted`.

Every refusal writes a named error, lands in the trace, and increments the
same rejection counters as the corpus path.

## 6. Invariants and threat model

These are the rules the implementation must not break.

1. **The node stays volatile.** No volume, no persistence, no new egress. The
   `web.run` record is written by the agent; a node restart loses the source
   table and nothing else. `web_annotate` never calls the node.
2. **The model never names a URL in a tool argument.** `web_search` returns
   opaque ids; `web_read` and `web_annotate` take `sourceId`. The search record
   does not store result URLs. Read records store the URL, but it is never
   accepted as a tool argument.
3. **Page text is untrusted data.** It is stored, not executed and not injected
   into a prompt section. The only model exposure is the `web_read` tool result
   already marked `untrusted: true`. The report and UI escape it as text.
4. **No re-fetch.** The quote is verified against the snapshot read in this
   run (`readAt`, `pageSha256`). The citation does not claim the page still
   says it.
5. **The taint gate is unchanged.** A web read still writes `web.taint`; it
   still blocks `/ingest`, `/uploads/*`, `/skills/file` and `corpus/**`. Web
   evidence does not reopen those paths. `web_annotate` is not a persistence
   path: it only marks a span of an already-read page.
6. **Evidence is run-scoped.** Every citation id carries `runId`;
   `foreign_citation` rejects an id from another run. The doc family is
   conversation-scoped and keyed by `runId`; a new session does not copy it and
   `reset()` does not delete it.
7. **Idempotency.** The record is committed before the tool returns and carries
   `api.callId`. A replay of the same `requestId` finds the doc; a retry of
   `web_read` returns the stored page, while a retry of `web_search` replaces
   its record and gets fresh ids (the node may spend the search again). A
   crash between the node call and the commit means the model never received
   the result, so there is nothing to replay; the retry starts from the node
   again, and the node answers its named refusal (`budget_exhausted` for a
   search, `already_read` for a read). The lost page cannot be cited; §5.2
   records the window and §11 keeps it open.
8. **No secrets.** `web.run` stores URLs, titles, text and hashes. It never
   stores the manager's control token or the node's per-run token. Those stay
   in `CurrentRunDoc`/memory as today; the record is not a credential store.
9. **No new key.** The judge uses the run's existing OpenRouter credential
   (RFC 0012/0013). No sidecar route, no catalog entry, no key surface.
10. **Corpus separation.** A web page never enters `corpus/`; a web citation
    never claims a `docId`. The `kind` field is explicit in the envelope, the
    report and the UI.
11. **The UI shows server-recorded URLs.** The "Sources used" panel renders
    only `webSources`/`citations` from the envelope, never a URL parsed out of
    the model's markdown. Prose links remain model text and are not presented
    as citations.
12. **Retention is explicit.** The page text already exists in the trace; the
    new doc is on the same per-user volume and is needed for replay and audit.
    It does not widen the trust boundary. If a retention policy is added later,
    it must cover the trace and `web.run` together.

## 7. Storage, performance and retention

Worst case per run:

| Item | Bound | Size |
|---|---|---|
| `searches` | 4 searches × 8 results × ~550 chars | ~18 KB |
| `sources` | 8 reads × 6000 chars | ~48 KB |
| `webAnnotations` | one per annotate call | ~1 KB each |
| trace (existing) | search results + read results | ~40 KB |

The new doc roughly doubles the web part of a run. It is written once per tool
call, not rewritten on every commit; the citation run doc stays small because
it holds annotations, not page text. The judge does not load the page text:
`quoteOf` reads the annotation's quote (max 1000 code points, under the 1400
quote cap, so the quote is never truncated; the claim keeps the existing
600-character cap). `web_annotate` scans at most 6000 characters; line numbers
are computed on demand.

Retention follows `CitationRunDocs`: docs accumulate per conversation, and the
run remains readable after pause/restart. `bench/README.md` and the report do
not need new artifacts; the citation report gains fields only.

## 8. Flags, rollout and compatibility

| Env (agent) | Env (manager forwards) | Values | Default |
|---|---|---|---|
| `CITATION_JUDGE_WEB` | `AGENT_CITATION_JUDGE_WEB` | `off` `warn` `enforce` | `warn` |

The manager forwards the new variable into `docker create` exactly like
`AGENT_CITATION_JUDGE`; `.env.example` documents it in the same style. The gate
and `web_annotate` have no flag: they are part of the web capability. A run
with web off still sees the tool schema, but every call returns
`web_not_authorized`; the web section says web is off.

Rollout:

1. Land `web.run`, `web_annotate`, the gate merge, the envelope and the UI
   with `CITATION_JUDGE_WEB=warn`.
2. Add a web fixture split to `agent/scripts/judge-eval-fixtures.json` (or a
   sibling file read by the same script): Italian claims against English
   quotes, long pages, numbers/dates/negations, verbatim repeats, multi-source
   lines, truncated pages. Run
   `node agent/scripts/eval-citation-judge.mjs` and
   `node agent/scripts/eval-zero-shot-judges.mjs`; record the run date and the
   served snapshot.
3. Flip the default to `enforce` only when both bar criteria hold on the web
   split. Update RFC 0018's status note and the README.
4. Update RFC 0016 §5 (web tools) and RFC 0006 §5.4 (evidence kinds) with the
   new contract; do not leave contradicting prose.

Compatibility:

- A stored `CitationRunState` without `webAnnotations` reads as `{}`; a
  `WebRunRecord` absent for old runs reads as empty. Old `CitationView`
  consumers see `kind: "corpus"` on corpus citations; the frontend tolerates a
  missing `webSources` part.
- No Drizzle migration: these are versioned SQLite documents, and the new
  fields are additive. If the doc shape changes later, bump the family version
  and keep a reader for version 1.
- No new HTTP route: `web_annotate` is a model tool; `/corpus/citations`
  returns both kinds; `/inspect?report=citations` includes web counts.

## 9. Testing

Unit and integration:

- `agent/web-run.test.ts` (new): search/read records written before the result
  is returned; `api.callId` makes a `web_read` retry return the stored page
  without a second node call; a `web_search` retry replaces its record; no
  result URLs in `searches`; text capped at 6000; a failed node call writes
  nothing; a commit failure turns the tool into an error.
- `agent/web-tools.test.ts` (extend): `web_annotate` happy path; `unknown_source`
  for an id of another run; `source_not_read` for a search result never read;
  `quote_mismatch` for a paraphrase; `quote_too_long` at 1001 code points;
  `not_a_strict_run` in a free run; `web_not_authorized` with web off; annotate
  after a node restart/TTL (the record is the only source); no `url` parameter
  in the schema.
- `agent/citation-agent.test.ts` (extend): strict+web publish with a web
  citation; a web-only publish; a mixed corpus+web line; `answer_plain`
  rejected with `citations_unused`; the 1455 regression (a web claim carrying a
  corpus token) is recorded in `warn` and rejected in `enforce`, while the
  prompt-correct path publishes with `web_annotate`.
- `agent/citation-judge.test.ts` (extend): `source` on records; per-source
  modes; the aggregation table in §5.5; a web pair in `warn` never rejects; a
  web pair in `enforce` rejects; `CITATION_JUDGE=off` makes no calls.
- `agent/citation-report.ts` tests: `used`/`reported` merged; `exact` over both
  kinds; per-source verdict counts; old records without `source` still report.
- `agent/tool-schemas.test.ts`: `web_annotate` schema and no URL argument.
- `agent/web-tools.test.ts`: the web section text differs for strict and free,
  and no longer says "cite its URL" as the citation rule.
- `sandbox-manager/test_sandbox_manager.py`: `AGENT_CITATION_JUDGE_WEB`
  forwarding.
- Frontend: `pnpm check`, `pnpm lint`, `pnpm test:unit -- --run`; the source
  panel and the `data-web-sources` part are covered by the existing component
  tests if present.

End-to-end (`e2e-test/websearch.sh`, run by `verify.sh`):

- The scripted faux path in `agent/model.ts` gains a strict+web sequence:
  search, read a fixture page, annotate an exact quote and publish. The
  envelope has `evidence: "cited"`, a citation with `kind: "web"`, `url`,
  `status: "page_quote_verified"`, and a `webSources` entry with the id.
- `web_search` output has no `url` field; `web_annotate` of a search result
  that was never read returns `source_not_read`.
- Restart the web-search node (or let the run table expire) between `web_read`
  and `web_annotate`; annotate and publish still work from the durable record.
- The answer contains a `[cit_...]` token; the panel shows the quoted text,
  the URL and "read at".
- `/ingest` after the read still returns `web_tainted`; `web_annotate` does not
  reopen it.
- No URL is sent to the node as a tool argument; no egress is added.

The full `./verify.sh` is required because the change crosses agent, manager
env forwarding, frontend and Caddy/e2e. The Playwright suite is run only if the
UI change is part of the delivery; the `verify-affido-ui` skill is the
preferred proof for the panel.

## 10. Alternatives considered

**Forbid strict+web.** Small and safe: reject the combination at `/prompt`
with `strict_web_conflict`, or hide one toggle when the other is on. It removes
the misattribution window but leaves the user unable to get a verified web
claim; the default product use case stays broken. It is a reasonable stopgap
only if this RFC is not implemented soon.

**Ingest the page into `corpus/` after reading it.** `web.taint` blocks
`/ingest` for the conversation, and the corpus is a user-owned registry with
document ids and versions. Using it as a scratch pad for web pages pollutes it
and breaks the "documents enter only through ingestion" rule. Rejected.

**Cite the URL as a token.** A URL has no exact quote; the judge would receive
an empty quote, and the gate's promise ("the quote exists in the source")
would become "the host exists". Rejected.

**Auto-cite the whole page on `web_read`.** The page is 6000 characters, the
quote cap is 1000, and a whole page does not support a specific claim. The
annotation is the unit of reliance. Rejected.

**Store only the hash and re-fetch at publish.** This adds egress, makes the
publish non-deterministic (the page may change), and breaks pause/restart
without the node. Rejected.

**Persist in the node.** The node has no volume by design and must stay
replaceable. It is an authorization table, not an evidence store. Rejected.

**A separate `webCitations` array.** Two panels, two declared sets, two judge
walks; the two kinds drift. A `kind` union keeps one gate and one report.
Rejected.

**Full-page entailment.** Out of scope. One quote per annotation; the judge
checks that the claim is coherent with the quote, not that the page entails
the claim.

## 11. Open questions

- **Multi-source lines.** The gate is line-based. A sentence synthesizing
  three pages can carry one web token and pass. This RFC makes "one claim per
  line, one source per claim" a prompt rule and adds a report metric
  (`multiSourceLines`) but not a hard gate. A hard rule would reject legitimate
  "the corpus says X, the web says Y" lines. Revisit with real traces.
- **Cross-lingual judge.** The web claims in the motivating run are Italian,
  the quotes English. The fixture split must measure this explicitly; d1.1's
  contract-clause numbers do not cover it. If the bar is missed, the web mode
  stays `warn` or the judge changes; the port is the seam.
- **Retention and privacy.** The page text is already in the trace. A future
  retention policy must cover both the trace and `web.run`; a shorter TTL for
  web text would break replay/audit. Decide before production scale, not in
  this RFC.
- **Free-run web citations.** This RFC keeps `web_annotate` strict-only. If
  users want verified web citations without the strict toggle, the change is
  to allow the tool in free runs and tighten `answer_plain`; that is a product
  decision, not a storage one.
- **Unread search URLs.** The search record omits them. If audit needs them,
  store them server-side with the same no-model-exposure rule; do not return
  them to the model.
- **The node read/commit window.** A crash between the node's successful
  `/read` and the agent's commit loses that page (the retry gets
  `already_read`). Closing it requires a per-run page cache in the node or an
  idempotency key, which changes RFC 0016's `/read` contract and its tests.
  The loss is safe (no citation, no misattribution), so it is deferred.
- **Judge metadata.** Should the judge see the page title/domain? Not in this
  RFC: it changes the frozen input and requires a new eval.

## 12. Decision

Proposed. The implementation order is §5.2 (record), §5.3 (`web_annotate`),
§5.4 (gate), §5.6 (envelope and UI), §5.5 (judge modes and eval), then the e2e.
The feature ships with `CITATION_JUDGE_WEB=warn`; `enforce` is a separate
decision backed by the web eval.

The success criterion is concrete: a strict+web run like `23Du1SEEshXE6esW`
can answer the Man Group/Understanding AI claims with `web_annotate` tokens
whose quotes are exact spans of the pages it read, the judge records
`source: "web"` verdicts on those pairs, and a free/plain run still shows the
pages read as unverified `webSources`. The 1455 pattern — a web claim carrying
a corpus token — remains possible only as a model mistake; the prompt forbids
it, the judge can reject it, and the report shows which pages were actually
read. The system no longer forces the model to choose between deleting the web
evidence and misattributing it.

## 13. Relation to existing RFCs

| RFC | Relation |
|---|---|
| RFC 0006 (server-verified citations) | The gate's order and reasons are unchanged. It learns a second evidence kind and a merged declared set; `uncited_line`, `unknown_citation`, `foreign_citation` keep their meaning. |
| RFC 0008 (sessions) | `web.run` is conversation-scoped and keyed by `runId`, like `citations.run`. Switching or resuming a session keeps the record readable; `newSession` does not copy it. |
| RFC 0011 (brand design system) | The "Sources used" panel and the web tooltip use the existing tokens; no new palette or radius. |
| RFC 0012 (BYOK) / RFC 0013 (sidecar) | No new key and no new sidecar route. The judge keeps using the run's OpenRouter credential; the manager control token stays where it is. |
| RFC 0014 (ingestion and registry) | Web evidence is not a corpus document. `web.taint` still blocks `/ingest`, `/uploads/*`, `/skills/file` and `corpus/**`; `web_annotate` is not a persistence path. |
| RFC 0016 (web-search node) | The node stays volume-less and volatile; `sourceId` stays opaque; no URL argument; no egress change. The new `web_annotate` tool and the agent-side record are the only additions. |
| RFC 0017 (coherence judge) | The port and the aggregation are reused. Records gain `source`; `coherenceOf` gains a per-pair mode resolver. |
| RFC 0018 (d1.1 default) | d1.1 remains the judge for corpus pairs. Web pairs default to `warn` until the web fixture split meets the same bar; no new key or endpoint. |

## 14. Surfaces touched

| Surface | Change |
|---|---|
| `agent/web-tools.ts` | `web_search`/`web_read` write `web.run`; new `web_annotate`; web section text |
| `agent/web-run.ts` (new) | `WebRunDocs`, record types, read/write helpers |
| `agent/citation-run.ts` | `webAnnotations` in `CitationRunState` |
| `agent/workspace-store.ts` | `kind: "corpus"` on new annotations; unchanged exact-span rule |
| `agent/citation-store.ts` | `Evidence` union, `webCitationIdOf`, new refusal reasons |
| `agent/citation-tools.ts` | merged gate, `answer_plain` count, judge mode resolver |
| `agent/citation-judge.ts` | `source` on records, per-source modes in `coherenceOf` |
| `agent/citation-report.ts` | merged `used`/`reported`, per-source judge counts |
| `agent/server.ts` | parse `CITATION_JUDGE_WEB`, pass `judgeWebMode` |
| `agent/agent.ts` | `#envelope` web citations and `webSources`, `#citationViews` union |
| `agent/trace.ts`, `agent/types.ts` | report and envelope types; web record read for `/corpus/citations` |
| `agent/tools.ts` | no new route; `/corpus/citations` returns both kinds |
| `agent/Dockerfile` | copy `web-run.ts` into the image |
| `agent/package.json` | add `web-run.test.ts` to the `test` script |
| `agent/model.ts` | scripted faux path for the strict+web e2e sequence |
| `sandbox-manager/sandbox_manager.py` | forward `AGENT_CITATION_JUDGE_WEB` |
| `frontend/src/lib/types.ts` | `Citation` union, `WebSourceView`, `data-web-sources` |
| `frontend/src/lib/components/citations.svelte` | "Sources used" with document and web groups |
| `frontend/src/lib/components/citation-tooltip.svelte` | web branch |
| `frontend/src/routes/api/chat/+server.ts` | map and stream `webSources` |
| `frontend/src/routes/dashboard/chat/+page.svelte` | render the web-source panel |
| `frontend/src/routes/dashboard/traces/*`, `judge-verdicts.svelte` | source column, web counts |
| `e2e-test/websearch.sh` | strict+web publish, node-restart annotate, taint, no URL |
| `docs/rfc/0006-server-verified-citations.md`, `docs/rfc/0016-web-search-node.html`, `docs/rfc/0017-citation-coherence-judge.md`, `docs/rfc/0018-d1-openrouter-judge.md` | updated contract and flags |
| `README.md`, `.env.example` | updated behavior and `CITATION_JUDGE_WEB` |

No change: the web node's network topology, the manager's sandbox create
args beyond the env forwarding, the sidecar, the provider catalog, the key
surface, the Caddy routes.
