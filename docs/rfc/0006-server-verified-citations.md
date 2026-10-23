# RFC 0006 — Server-verified citations for `/prompt` answers

| Field | Value |
|---|---|
| Status | Implemented |
| Author | pi-durable containers maintainers |
| Date | 2026-10-21 |
| Target | `agent/`, `frontend/`, sandbox-manager |
| Related | RFC 0005, PRD 0001, `agent/agent.ts`, `agent/corpus.ts`, `agent/tools.ts`, `frontend/src/routes/api/chat/+server.ts`, `frontend/src/routes/dashboard/chat/+page.svelte` |

## 1. Summary

Today a `/prompt` answer is a string. The model may have read `corpus/raw/<docId>.md`
with `bash` and `read`, and the user has no way to know which files the answer came
from, whether the quoted words are in those files, or whether the answer is invented.

This RFC ports the citation mechanism of the free-hall `explore` arm
(`src/freehall/agent/explore.py`, `src/freehall/corpus/tools.py`,
`src/freehall/corpus/store.py`) into the container agent. The mechanism has one
property, and it is mechanical, not judged:

> When the agent answers, the answer reports exactly the citations it used —
> and every citation is a text span the server located and verified in a real
> document.

Three rules produce that property:

1. **Offsets are the server's.** The model greps and reads through bounded tools
   that return line numbers and code-point spans. The model never computes an
   offset and never supplies a hash.
2. **An annotation is a declaration of reliance.** To use evidence, the model calls
   `corpus_annotate` with a quote copied exactly from what it read. The server
   locates the span, verifies the slice, and returns a `citationId`. A rejected
   quote writes nothing. What is annotated is what is declared used.
3. **Publication is behind a deterministic gate.** The evidence-backed answer
   exists only through `answer_publish`: every non-heading line carries at least
   one `[cit_…]` token, the declared ids are exactly the tokens used, and every id
   is a verified annotation of this run. A rejection writes nothing and names the
   reason.

The `/prompt` response grows a `citations` array. The frontend renders the answer
markdown with `[cit_…]` tokens as numbered references, plus a "Files used" panel:
document, version, line, and the exact quote — or an explicit "no document
evidence" badge when the reply carried none. Verification runs server-side, in the
agent container; the model cannot forge, pad, or omit what it reports.

The gate is a user command, not a deployment mode. Strict citations are requested
per question by the end user in the client (`citations: "required"` on `/prompt`,
§5.9): the user reading jurisprudence wants every line provenanced, the same user
fixing a script does not. Submissions without the field keep today's free-form
answer.

## 2. Problem

### 2.1 Current trace

```
browser
  -> frontend  POST /api/chat
  -> sandbox   POST /prompt { prompt, requestId }
  -> agent     bash ls corpus/raw ; read corpus/raw/<docId>.md
  -> answer    free-form string
  <- { answer: "..." }
```

Facts that matter:

- The answer is prose. Nothing ties a claim to a document, a version, or a span.
- `read` gives the model raw bytes; the model can paraphrase, merge, or invent.
  The server cannot distinguish quoted text from generated text.
- The user sees which files exist (`/files`, the dashboard preview), never which
  files the answer *used*.
- `/inspect` records every tool call, but nothing checks that the final answer
  reflects what was read. Audit today means reading the trace by hand.

### 2.2 Why prompt instructions are not enough

A system prompt can ask the model to cite files. That is a request, not a
mechanism: nothing rejects an uncited line, an invented quote, or a reference to
a document the model never opened in this run. The free-hall result is the
reference: with the gate, citation-reporting exactness is enforced to 100% by
construction, and measured mechanically from the trace alone
(`src/freehall/citation_report.py`). This RFC imports the mechanism, not the
prompt.

### 2.3 What this RFC does not change

- `POST /prompt` stays idempotent by `requestId`; the conversation stays durable.
- Workspace tools (`read`, `write`, `edit`, `bash`) stay. The corpus tools are
  added beside them, and the answer gate decides the reply's evidence status.
- RFC 0005's object-storage migration is untouched. This RFC defines the citation
  layer against a `CitationStore` port whose v1 implementation reads the staged
  documents in `corpus/raw/`. When RFC 0005 lands, the store backend changes;
  the tool contract and the gate do not.

## 3. Goals and non-goals

### 3.1 Goals

| ID | Goal |
|---|---|
| G1 | Every document-grounded `/prompt` answer carries server-verified citations: exact quote, document, version, span. |
| G2 | The user sees, in the frontend, which files the agent used and the exact supporting quote for each reference. |
| G3 | Citation-reporting exactness holds by construction: reported ids = used ids = verified annotations of the run. |
| G4 | The property is measurable from the trace alone, without a judge. |
| G5 | The mechanism works with the current workspace-staged corpus and survives the RFC 0005 backend swap unchanged at the tool contract. |
| G6 | Operational answers ("list the files", casual chat) remain possible and are explicitly labeled as carrying no document evidence. |

### 3.2 Non-goals

- Verifying the *truth* of a claim. A citation proves attribution, not truth.
- Semantic detection of "this line talks about a document". The gate is lexical
  and structural; the bypass channel is closed by rules (§5.6), not by judgment.
- Vector search, RAG, embeddings (RFC 0005 non-goals, still non-goals).
- Citations for workspace scratch files (`README.md`, `notes.txt`). Only corpus
  documents under `corpus/raw/` are citable evidence.
- Multi-agent synthesis and canonical knowledge pages (RFC 0005 §5.5 path 3).
  Here `answer_publish` gates one reply to one user; it does not write a shared page.

## 4. Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| R1 | The model never supplies offsets or hashes for a citation. | `corpus_annotate` accepts `citation.text` alone; the server locates the span and returns `start`/`end`/`textSha256`. A model-supplied hash is ignored. |
| R2 | A citation exists only after server verification. | annotate with a quote not found in the stated version returns `quote_mismatch`/`not_found` and writes nothing; no `citationId` is minted. |
| R3 | `citationId` is content-addressed and run-scoped. | Same `(runId, docId, docVersion, quote)` returns the same id; an id from another run is rejected at publish with `foreign_citation`. |
| R4 | An evidence-backed reply exists only through the gate. | `answer_publish` rejects `uncited_line` (non-heading line without a `[cit_…]` token), `undeclared_token`, `unused_citation`, `unknown_citation`, `unverified_citation`. Every rejection writes nothing and names the reason. |
| R5 | The declared ids are exactly the tokens used. | `[cit_a; cit_b]` grouped tokens count; publish passes only when `set(citationIds) == tokens(markdown)`. |
| R6 | `/prompt` returns the citations with the answer. | Response carries `citations: [{citationId, docId, title, filename, version, start, end, line, quote, textSha256, status}]`; ids match the tokens in `answer` exactly. |
| R7 | An uncited reply is explicit, not silent. | Response carries `evidence: "cited" \| "plain"`; the frontend renders a visible badge for `plain`. |
| R8 | The bypass channel is closed by rule. | `answer_plain` returns `citations_unused` when the run has verified annotations; a run with annotations can only exit through `answer_publish`. |
| R9 | Reads are bounded. | `corpus_read` returns at most `maxChars` (server-capped); `corpus_grep` returns at most `limit` lines with 1-based line numbers and the match span. |
| R10 | Exactness is measurable from the trace. | A report endpoint recomputes used/reported/exact per submission from stored entries: `unreported_used` and `padded` are both empty for every gated reply. |
| R11 | Citations survive restarts. | After sandbox restart, `GET /corpus/citations?…` re-verifies each citation against the stored text; status is `attribution_verified` or a named failure. |
| R12 | The gate costs are visible. | Publish/annotate rejections per reason are counted per run and shown with the trace. |
| R13 | Strict citations are a per-question user command, not a sandbox mode. | `POST /prompt` carries `citations: "required"` only when the end user selected it in the chat UI; the strict prompt, the gate and the strict exits apply to that submission alone (§5.9). A request without the field answers free-form, as today. |

## 5. Design

### 5.1 The answer contract

`prompt()` currently returns `{ answer, status, … }`. It grows two fields:

```json
{
  "agent": "u-alice",
  "status": "done",
  "answer": "## Renewal date\n\nThe contract renews on 2027-03-01 [cit_9f2a…] [cit_c41d…].\n\nNotice must be sent 90 days earlier [cit_9f2a…].",
  "evidence": "cited",
  "citations": [
    {
      "citationId": "cit_9f2a…",
      "docId": "doc_42",
      "title": "Contratto di manutenzione",
      "filename": "contratto.md",
      "version": 1,
      "start": 8421,
      "end": 8502,
      "line": 120,
      "quote": "Il contratto si rinnova tacitamente il 1° marzo 2027.",
      "textSha256": "a1b2…",
      "status": "attribution_verified"
    }
  ]
}
```

`evidence: "plain"` means the reply used no document evidence; `citations` is
`[]`. The frontend renders both states differently (§5.7). The two fields are
produced by the server, never typed by the model.

### 5.2 CitationStore: a port, one instance per run

```
agent/citation-store.ts     CitationStore port + VerifyError reasons
agent/workspace-store.ts    v1 implementation over corpus/raw/<docId><ext>
agent/citation-tools.ts     defineTool() wrappers: grep, read, annotate, publish
```

The store owns documents and citations for one run. A run is one strict `/prompt`
submission. `ToolExecutionApi` exposes `conversationId`, `taskId` and `callId` —
not the submission id — so the run key is carried by the submission itself: a
strict submission is placed as an application input entry (`kind: "citations.strict"`,
`data: { requestId }`, §5.9), and `runId` is the `requestId` recorded there. Tools
resolve the current run's entry through the tool API's document access, never
from a model-supplied id. Citations do not cross runs — R3's `foreign_citation`
check is the same per-run scoping as free-hall.

v1 reads the staged bytes directly:

- Documents are the files in `corpus/raw/` (metadata from the Postgres upload
  row: title, original filename). Text is decoded server-side; `version` is `1`;
  `textSha256` is computed server-side from the decoded text.
- The store indexes documents lazily on first access: line table (start offset
  per 1-based line) and, later, lexical chunks. No write ever touches
  `corpus/raw/`.

The port's methods are the free-hall store's, minus what no chat run needs:

| Method | Ported from | Notes |
|---|---|---|
| `grepLines(pattern, docIds?, limit)` | `store.grep_lines` | Regex over the first 1000 chars of each line; bounded pattern checks (`unsafe_pattern` on unbounded repeats); wall-clock budget. |
| `readWindow({docId, version?, needle?, lineRange?, radius, maxChars})` | `store.read_window` | Returns text, absolute code-point `start`/`end`, per-line table, `truncated`, `nextStart`. |
| `annotate({docId, docVersion, kind, citation})` | `store.annotate` | Server-locates `citation.text` when the model omits `start`/`end` (the default path); verifies the exact slice; mints `cit_<sha256(runId|docId|version|quote)[0..10]>`. |
| `audit(runId)` | `store.audit_citations` | Recompute every citation from stored text. No model, no trust. |

When RFC 0005 lands, a `CatalogStore` implements the same port against the
Postgres catalog and object storage; versioning beyond 1 and `stale_base`
publishing arrive with it. Nothing in the tools or the gate changes.

### 5.3 Tools

Where the code runs. The agent container is a Node process (`server.ts` +
Harness); `defineTool()` bodies execute in-process, as durable tasks — the same
execution model as the built-in `read`/`bash` (`tool.execute(args, {…api, env},
context)`). "Server-side" in this RFC means exactly that: TypeScript in the
container process, the only thing the model can talk to. No subprocess, no
shell, no Python: free-hall removed its `bash` arm because a shell allowlist
over a corpus is arbitrary-code-execution surface (`awk system()`, `sed e`,
`find -exec`, `rg --pre`); the same lesson applies here. Corpus bytes are read
through the execution env, read-only; `bash`/`read` on `corpus/raw/**` is
denied (§5.6).

Five `defineTool()` registrations installed in the `ContainerAgent` registry,
beside `CodingTools`. The model-facing surface is deliberately the explore
surface (grep instead of lexical search first: same primitive the free-hall
explore arm measured with):

#### `corpus_grep`

Regex over corpus lines. Returns each hit with `docId`, 1-based `line`, the full
line, and the code-point span of the first match — the server computes every
offset. Args: `pattern`, `docIds?`, `limit` (1–100, default 40). Rejections:
`unsafe_pattern`, `not_found`.

#### `corpus_read`

A bounded window of one document. Args: `docId`, `version?`, `needle?` (exact
text to locate), `lineRange?` (`[first,last]`, 1-based), `radius` (default 400,
max 4000), `maxChars` (default 8000, max 16000). At least one of
`needle`/`lineRange` required; a bare read never dumps a document. Output
includes the per-line offset table so the model can quote exactly.

#### `corpus_annotate`

Declare reliance on a quote. Args: `docId`, `docVersion`, `kind` (`"quote"`
required for evidence), `citation: { text }` — copied exactly from what was
read. The model omits `start`/`end`: the server locates the quote and returns
the span and `citationId`. Output: `{citationId, docId, docVersion, start, end,
textSha256}`. Rejections (`quote_mismatch`, `not_found`, `version_unavailable`)
write nothing. A rejected quote is not evidence; the model reads again and
copies exactly.

#### `answer_publish`

The only way out for an evidence-backed reply. Args: `markdown`, `citationIds`.
The gate (§5.4) runs server-side; on success the reply is fixed for the run and
the harness ends the turn. On failure the model gets the reason and retries.

#### `answer_plain`

Exit for replies with no document evidence (§5.6). Args: `markdown`. Rejected
with `citations_unused` if the run has any verified annotation.

The system prompt is the explore prompt, adapted: answer only from the corpus
through the corpus tools for document questions; never answer from memory or
from a document id; a name is not a fact; if the corpus lacks the evidence,
reply `UNANSWERED: <what is missing>` via `answer_publish` with no citations or
`answer_plain`; a citation proves attribution, not truth.

### 5.4 The deterministic gate

`answer_publish` runs the free-hall checks in order, all server-side. A
rejection writes nothing (there is nothing to write: the reply simply does not
exist yet) and returns the reason:

```
1. for each declared citationId:
     unknown citation          -> unknown_citation
     status != verified        -> unverified_citation
     citation.runId != runId   -> foreign_citation
2. tokens  = every cit_… inside a bracket group of markdown
     (grouped "[cit_a; cit_b]" counts: scan bracket contents, not just "[cit_x]")
   tokens - declared           -> undeclared_token
   declared - tokens           -> unused_citation
3. for each line, stripped, non-empty, not starting with '#':
     no token on the line      -> uncited_line (line preview, 200 chars)
4. accept: fix the reply, return citations, end the turn
```

Steps 1–3 are exactly `InMemoryCorpusStore.publish` in free-hall; the code-point
token scan is exactly `citation_tokens()`. Heading lines and blank lines are
exempt so structure stays citable-line-only. The gate is idempotent per run: a
retry after rejection revalidates from scratch.

### 5.5 Where the gate lives

"Server-side" here means the agent container's Node process, which is the
server from the model's point of view: the model's only outputs are tool calls,
and every tool body is ours. The gate sits in the `answer_publish` tool body
and in the harness turn handler:

- The tools node inspects the tool-call result; a successful `answer_publish`
  sets the run's published state and the conversation ends (same shape as
  free-hall's `_after_tools`: publish ends the graph).
- `prompt()` builds the response envelope from the published state: answer,
  `evidence: "cited"`, citations — or, for `answer_plain`, `evidence: "plain"`,
  `citations: []`. If the turn ends with neither (turn budget, error), the
  envelope reports `evidence: "none"` and the failure reason. The model never
  writes these fields.

Turn budget: pi-durable has no per-submission step limit, so the budget is run
state, not a runtime setting — the run counts its tool rounds (the `afterTools`
hook) and refuses further corpus calls past 24 (free-hall's value). On
exhaustion the run ends unpublished and the measurement counts it
(`replied_without_citations` when annotations exist).

### 5.6 The bypass channel, closed by rule

A chat agent, unlike the explore arm, must be able to say "here are your files"
without citations. But an `answer_plain` exit that always works would let a lazy
model dodge the gate on document questions. Two deterministic rules close most
of the gap:

1. **`citations_unused`:** if the run has at least one verified annotation,
   `answer_plain` is rejected. Consulted evidence forces the gated exit: what
   you annotated is what you declare you used, in the reply itself.
2. **File tools are denied by construction; bash is not.** `read`/`write`/`edit`
   on `corpus/raw/**` is denied by the env factory: `ContainerAgent` already
   builds the env per tool call, and a wrapper `ExecutionEnv` whose path
   resolution rejects corpus paths makes the rule structural. `bash` cannot be
   path-filtered — a shell rooted in the workspace can always
   `cat corpus/raw/<docId>.md` — and free-hall removed its bash arm for exactly
   this reason. v1 states the hole instead of claiming it closed: a bash read
   does not break citation integrity (`corpus_annotate` still verifies the quote
   against the stored text); it bypasses the read bounds (context cost) and the
   single-path claim above. Closing it constructively means moving the corpus
   out of the workspace (RFC 0005's plane split) or dropping `bash` inside
   strict runs — a deliberate follow-up, not a prompt rule.

What remains open is a model that reads documents, annotates nothing, and
answers plain. The frontend label makes that legible to the user, the report
makes it legible in the dashboard (R10, R12), and the system prompt states the
contract. That is the honest boundary of a judge-free mechanism.

### 5.7 Frontend

`/api/chat` already stores the assistant message; it grows the envelope:

- The stored `parts` gain a `data-citations` part: the citations array and the
  `evidence` flag (UI message parts support data parts; they persist with the
  message row).
- `Markdown.svelte` renders `[cit_…]` tokens as superscript references keyed by
  citation index; the mapping comes from the `data-citations` part, so a token
  without a citation is impossible to render (and impossible to produce, R5).
  Hovering (or keyboard-focusing) a reference opens a hover card with the
  document title, the verified quote, `filename` and `line`; the card is placed
  above the reference, flips below when there is no room, and clamps to the
  viewport (`citation-tooltip.ts`, plain rect math). The references live inside
  rendered markdown, so the card rides delegated `mouseover`/`focusin` on the
  answer container and is suppressed on touch-only pointers — tapping a
  reference opens the panel instead. Activating a reference opens the
  **Files used** panel and scrolls its quote row into view.
- Under the answer, a **Files used** panel: one row per distinct `docId` —
  title, original filename, version badge, and the quotes with `line` reference.
  The panel is a `Collapsible`: open by default, the user collapses it to a
  header line (`Files used · N documents`), and activating a reference re-opens
  it. Its state is per message, held in the chat page, so a reload restores the
  default. Clicking a quote opens the document preview scrolled to the line. The
  preview path is `GET /raw?docId=…&filename=…` (what `documents.ts` calls
  today); the `#L120` anchor is new work in that preview.
- The composer carries the **Strict citations** toggle (§5.9): it adds
  `citations: "required"` to the next submission only, and the choice is stored
  with the user message.
- An `evidence: "plain"` reply renders a muted badge: "No document evidence —
  agent reply without citations". Honesty over decoration.

### 5.8 Measurement from the trace alone

Port `citation_report.py` as `agent/citation-report.ts`, computed from stored
entries (no LLM, no judge), exposed at `GET /inspect?report=citations` and shown
on the traces dashboard page per submission:

```
published              did the run exit through the gate
used                   citationIds of successful annotates
reported               citationIds of the accepted publish
exact                  set(reported) == set(used)
unreported_used        annotated, never cited   (must be empty after the gate)
padded                 cited, never annotated   (impossible after the gate)
replied_without_citations  annotations exist, turn ended unpublished
annotate_rejected / publish_rejected / rejection_reasons   gate friction, by reason
```

Headline metric, same as free-hall: `citation_exactness` over gated replies.
Friction is the cost of the 100%, not a violation of it; it is reported per
reason so prompt regressions are visible in the dashboard after every session.

### 5.9 Strict citations as a client command

The gate is a property of a question, not of a sandbox. The same user asks
"fix this script" (no citations wanted) and "when does doc_42 renew" (every
line provenanced — jurisprudence reading, contract review, audit). A per-sandbox
`PROMPT_CITATIONS` env flag cannot express that: sandbox env is fixed at
`docker create`, so the choice would be frozen per deployment and per user.

The command is one field on the request the client already sends:

```
POST /prompt { prompt, requestId, citations: "required" }
```

- The field is set by the end user's toggle in the chat composer. The frontend
  persists it with the user message; Caddy and the sandbox-manager relay it
  unchanged. It never comes from the model.
- The agent places a strict submission as an application input entry
  (`kind: "citations.strict"`, `data: { requestId }`). The entry is durable, it
  keys the run (§5.2), and the idempotent replay of the same `requestId` returns
  the same admitted submission with the same mode — a mode is never re-decided
  on retry.
- The strict prompt contract (§5.3) is prepended to the input by the agent, not
  typed by the user; the corpus tools are installed in the registry for every
  run, but the strict exits — `answer_publish` termination, `answer_plain`
  rejection (§5.6 rule 1), the turn budget — apply only to a
  `citations.strict` run. In a normal run the tools stay callable and
  `corpus_annotate` still verifies, but the free-form answer remains the exit:
  citations surface as data, not as a gate.
- The envelope reports what ran: `evidence: "cited" | "plain"` for the two
  exits, `evidence: "none"` with the reason when a strict run ends unpublished
  (§5.5). The UI shows that state instead of a bare string.

Deployment default: `CITATIONS_DEFAULT=required` may set the mode for requests
that omit the field (a demo user, a jurisprudence workspace); the user's
explicit choice on the request always wins.

## 6. Interaction with RFC 0005

| This RFC | RFC 0005 |
|---|---|
| `CitationStore` port, v1 over `corpus/raw/` | `CorpusStore` becomes a backend of the same port. Alignment required: RFC 0005 §6.3 has `corpus_annotate` receive `citation: {start, end, text}` copied by the model from `corpus_read` — R1's locate-by-text contract supersedes it, and 0005 §6.3 is rewritten in the same change |
| `corpus_annotate`, `answer_publish` gate | `corpus_publish` canonical pages; the gate code is shared, the write target differs |
| run-scoped citations in the session | catalog `citation` rows for cross-sandbox audit (R11 gains the durable home) |
| `corpus_grep` primitive | `corpus_search` lexical search may join beside it; both return server offsets |

Sequencing: this RFC is implementable today, before RFC 0005's object storage.
The migration is a store swap behind the port; the model surface, the gate, the
envelope and the frontend do not change.

## 7. Testing

- **Unit, gate:** table-driven rejections — `uncited_line` (incl. heading
  exemption), `undeclared_token` (incl. `[cit_a; cit_b]`), `unused_citation`,
  `unknown_citation`, `unverified_citation`, `foreign_citation` (cross-run id).
  Every rejection writes nothing; the store is empty after each.
- **Unit, annotate:** exact quote passes and mints a stable id; one-character
  drift returns `quote_mismatch`; whitespace-normalized quote is rejected;
  repeated quote returns the same id; astral-plane characters round-trip
  (code points, not UTF-16 units).
- **Unit, store:** `grepLines` line numbers and spans against a gold document;
  `readWindow` respects `maxChars`, reports `truncated`/`nextStart`; pattern
  guards reject `(a|b)+`-style bombs.
- **Integration, fake model:** a scripted harness (as `agent.test.ts` does
  today) drives annotate→publish happy path, the rejection-retry loop, the
  `citations_unused` rule, and turn-budget exhaustion; the envelope is asserted
  field by field.
- **E2E:** upload a fixture document, ask a grounded question through the chat
  UI, assert the answer shows tokens, the Files used panel lists the fixture
  with the right line, and a `plain` answer shows the badge.
- **Unit, hover card placement** (`citation-tooltip.test.ts`, vitest): above the
  reference, flip below near the top edge, clamp to both viewport sides.
- **Browser, citation UI:** hover a reference and assert the card carries the
  document title, the verified quote and the line; collapse the panel, then
  activate a reference and assert the panel re-opens with the quote visible.
- **Report:** runs with known traces produce known `exact` / friction counts.

## 8. Rollout

1. `citation-store.ts` + gate + tools. The strict contract is reachable only
   through the `citations: "required"` request field (§5.9): no field, today's
   behavior — existing sessions unaffected.
2. Envelope fields, frontend rendering, and the composer toggle; the demo user
   gets the mode by default via `CITATIONS_DEFAULT=required`.
3. `answer_plain` enforcement (§5.6 rule 1) and the corpus-path denial for the
   file tools (§5.6 rule 2).
4. Report endpoint + dashboard column; then GA.

## 9. Open questions

- **Max quote length.** free-hall caps annotated slices; propose 1000 chars.
  Decide from demo-session friction (R12 makes the cost visible).
- **Multi-turn accumulation.** Should citations from earlier submissions stay
  citable in later turns (stable docIds make it cheap), or does each reply
  re-annotate? Propose: per-run only, matching free-hall; revisit with RFC 0005.
- **`corpus_search`.** Lexical search over titles/snippets may be needed before
  RFC 0005 if `grep` friction is high at 10^2+ documents. It joins the surface;
  it does not change the gate.
