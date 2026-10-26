# RFC 0014 — One ingestion pipeline, one index registry

| Field | Value |
|---|---|
| Status | Draft |
| Author | Affido maintainers |
| Date | 2026-10-26 |
| Target | `agent/` (new `ingest.ts`, `tools.ts`, `corpus.ts`, `uploads.ts`, `workspace-store.ts`, `citation-tools.ts`), `e2e-test/` |
| Related | RFC 0005 (workspace/corpus separation), RFC 0006 (server-verified citations, §5.2 superseded in part), RFC 0007 (Postgres catalog, `ingestStatus`), PRD 0003 (uploads tree), RFC 0010 (future connectors as ingestion callers) |

## 1. Summary

Two UI points let a user put files into a sandbox workspace — `dashboard/documents`
(single documents) and `dashboard/uploads` (a directory tree) — and the citation
engine learns about those files by walking the workspace at read time and
re-deciding, from filenames, what each file is. That re-decision is a bug class,
not a bug: an audited strict run (run `K54Ud12FZGzjCc5x`, 2026-10-25) burned its
whole 48-call corpus budget on 16 `quote_mismatch` rejections because the store
had indexed a PDF's raw bytes as UTF-8 text (3.35 MB, 1.46M U+FFFD) instead of
the extracted text sitting one directory away, then published a citation to
`/CreationDate (D:20261024184331+00'00')` — PDF structure metadata, admitted as
evidence.

This RFC makes three decisions:

1. **One ingestion class.** Both external entry points (`POST /ingest`,
   `POST /uploads/file`, and any future one, e.g. RFC 0010 connectors) call the
   same `IngestPipeline`. Staging, text admission, metadata, and deletion happen
   exactly once, in one module, in one order.
2. **One index registry, written at ingestion.** Admission to the citation
   index (`indexing: "text" | "derived" | "none"`) is decided once, at ingest
   time, and recorded in the per-document sidecar. The citation store never
   inspects filenames, never walks two trees with two rule sets, and never
   reads a file's bytes unless the registry declares those bytes to be valid
   UTF-8 text.
3. **The strict run is a closed evidence channel.** While the current
   submission runs under `citations: "required"`, the workspace tools
   (`bash`, `read`, `write`, `edit`) are refused: the only readable evidence is
   the citation index, reached through the server-managed `corpus_*` tools. In
   every run, `write`/`edit` cannot touch `corpus/**`, and the index build
   verifies each admitted document's bytes against the hash the registry
   recorded — so evidence cannot be planted or tampered with from a free run
   either.

The three walkers of today — the `corpus/raw/` walk, the `corpus/uploads/` tree
walk, and the derived-text lookup — collapse into one registry read. Listing,
grep, read, annotate, and the Postgres `searchable` flag all become views of the
same sidecar written by the same class. The documents the agent can see are, by
construction, the documents it can cite — and nothing else.

## 2. Problem

### 2.1 Current trace: two pipelines that touch in one place only

```
dashboard/documents                     dashboard/uploads
  -> sandbox.ts ingestSandbox             -> sandbox.ts uploadSandboxFile
  -> POST /ingest?docId&filename          -> POST /uploads/file?path=
  -> IngestTool (tools.ts:515)            -> UploadsFileTool (tools.ts:176)
       stageRaw        corpus.ts            stageUploadFile   uploads.ts
       writeMeta       corpus/raw+meta      (no sidecar)
       stageDerivedText corpus.ts           stageDerivedText  corpus.ts   <- only shared step
       -> { ...staged, searchable: indexedAsText(filename, derived) }
```

The two paths differ in staging layout, docId scheme (control-plane UUID vs
`u-<readable>-<hash12>`), sidecar presence, and deletion (uploads deletes leave
derived text orphaned; the code comments call the orphans "inert" — they are
disk, but they are also registry drift). The only shared step is
`stageDerivedText`.

The index is then rebuilt lazily by `WorkspaceCitationStore.loadDocuments`
(`agent/workspace-store.ts`), which re-derives everything at read time:

- `corpus/raw/`: `readTextFile(item.path)` for **every** staged file — the
  blind read. A PDF's compressed streams decode to U+FFFD garbage; only ASCII
  fragments of the PDF structure survive. A `.docx` is indexed the same way.
- `corpus/uploads/`: the correct rule (text from bytes, PDF from
  `corpus/text/<docId>.txt`, other binaries never) — applied only here.
- `corpus/text/`: consulted only by the uploads branch.

So `searchable` (written at ingest, recorded in Postgres) and the actual index
membership (decided at read time) are two truths that can diverge in both
directions, and did:

| Case | Ingest says | Index does |
|---|---|---|
| PDF with text layer, `/ingest` | `searchable: true`, writes `corpus/text/` | indexes the raw bytes (the audited bug) |
| Scanned PDF, `/ingest` | `searchable: false` | indexes the raw bytes anyway |
| Any non-PDF binary, `/ingest` | `searchable: false` | indexes the raw bytes anyway |

### 2.2 Why read-time re-derivation is the bug class

Admission to the index is a *property of the ingestion event* (what bytes
arrived, what extraction produced), not a property of the file name on disk.
Re-deciding it at read time means every new read path re-implements the rules,
and any drift between the implementations is invisible until a strict run hits
it: the model greps real content it read through `bash`, `corpus_annotate`
rejects it 16 times, and the gate — which cannot be bypassed — is then satisfied
with unrelated-but-verified ids. The failure mode is not a crash; it is answers
that look more grounded than they are.

### 2.3 What this RFC does not change

- The `corpus_*` tool surface, the publish gate, the `/prompt` envelope, the
  frontend rendering (RFC 0006 §§5.3–5.7) — unchanged above the document map.
- The two storage roots and their UX meaning: single documents under
  `corpus/raw/`, the user's tree under `corpus/uploads/` (PRD 0003).
- The uploads tree's second role as *workspace files* the agent reads with
  `bash`/`read` for skills (RFC 0009). Files there that are not indexable stay
  workspace files; they simply never become citation evidence.
- Span-level attribution semantics. The gate verifies that a quote is an exact
  span of an admitted document; it does not judge whether the quote is about
  the sentence it is pinned to (RFC 0006 §1). This RFC removes the *accidental*
  version of that gap (citing raw bytes that were never the document's text),
  not the semantic one.
- Whole-session confinement of the workspace. `bash`/`read` stay available in
  free runs — the sandbox is a workspace (RFC 0004/0009); only the strict run
  is a closed channel (§5.7), and only `corpus/**` is write-protected in every
  run (§5.7).

## 3. Goals and non-goals

### 3.1 Goals

- Both UI entry points, and every future one, ingest through one class.
- Admission decided once, at ingest, recorded in the registry both readers
  (store, listings) and the control plane consume.
- The store performs no blind `readFile`; it reads only declared, validated
  text paths.
- Coherence invariants that are checkable in unit tests and e2e.
- A strict run is a closed evidence channel: workspace tools refused, corpus
  tools only; and no tool, in any run, can plant or mutate evidence under
  `corpus/**` undetected.

### 3.2 Non-goals

- OCR for scanned PDFs, or new binary parsers (`.docx`, `.ods`). The admission
  table is designed so a future extractor is a new `indexing` producer, not a
  read-path change.
- Sentence-level attribution checking (separate problem, tracked against the
  audited decorative-citation finding).
- OS-level immutability of `corpus/` (read-only bind mounts). §5.7's rule set
  closes the tool-layer channels; a shell in a free run can still touch the
  directory, and the hash check is what turns that from a fabrication channel
  into a self-defeating mutation. Mount-level enforcement is heavier than the
  problem and breaks the pipeline's own writes.

## 4. Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| R1 | Every external ingestion entry point calls `IngestPipeline`; no other module stages or admits documents. | `stageRaw`, `stageUploadFile`, `stageDerivedText`, `writeMeta` have no callers outside `agent/ingest.ts`. `IngestTool` and `UploadsFileTool` are HTTP adapters: parse, call, `agent.noteCorpusChange()`, return the pipeline's `Staged` object verbatim. |
| R2 | Admission is decided once, at ingest, into `indexing: "text" \| "derived" \| "none"` + `textPath`, recorded in the sidecar. | The sidecar carries both fields; the store and both listings read them and never re-derive from filenames. |
| R3 | The store reads only declared text. | `loadDocuments` performs exactly one walk (`corpus/meta/`) and `readTextFile` only on each sidecar's `textPath`. A grep over the agent sources finds no `readTextFile` on `RAW_DIR` or `UPLOADS_DIR` paths in the store. |
| R4 | Text admission requires strict UTF-8. | At ingest, a `text`-extension file is admitted as `text` only when `Buffer.compare(Buffer.from(decoded, "utf8"), bytes) === 0`; otherwise `indexing: "none"`, `searchable: false`, staged bytes untouched. |
| R5 | Both roots use the same registry and keying. | Sidecars exist for `raw` (control-plane docId) and `uploads` (`uploadsDocIdOf(path)`) documents alike; a docId collision keeps today's raw-wins rule, now visible as a sidecar overwrite. |
| R6 | `searchable` at ingest == index membership forever after. | Both derive from the same sidecar field written by the same decision; e2e asserts the flag returned by `/ingest` and `/uploads/file` predicts citability of a sentence from the same fixture through both paths. |
| R7 | A PDF with no extractable text is staged, listed, and never indexed — no fallback to bytes. | `stageDerivedText → null` (scanned/encrypted/malformed/timeout) yields `indexing: "none"`; `corpus_grep`/`corpus_read`/`corpus_annotate` on that docId return `not_found`; no raw-byte decode exists on any path. |
| R8 | Non-indexed documents are not evidence, by contract and by tool behavior. | `corpus_*` on a non-indexed docId fails `not_found` before writing anything; the strict prompt section states that documents `corpus_grep` cannot see are not evidence and must not back a claim. |
| R9 | Deletion removes bytes, derived text, and sidecar together. | `removeUploadPath` and the raw delete route go through the pipeline; no orphaned `corpus/text/` or `corpus/meta/` entries remain after any delete (unit-tested). |
| R10 | Existing volumes migrate once, explicitly. | A bootstrap pass registers pre-RFC files (raw without sidecar fields, uploads tree without sidecars) by applying the same admission rules and writing sidecars; after it, read-time never decides anything again. The pass is idempotent and logged. |
| R11 | A strict run is a closed evidence channel. | While the current run is strict, a `beforeTool` hook refuses `bash`, `read`, `write`, `edit` with a named block naming the corpus tools; the only remaining paths to a gated reply are `corpus_grep`/`corpus_read`/`corpus_annotate` and the two exits. Free runs are untouched (§5.7.1). |
| R12 | Evidence cannot be planted or tampered with from any run. | `write`/`edit` are refused for `corpus/**` paths in every run (structured path argument, so the check is exact); the index build drops any admitted document whose staged bytes no longer hash to the sidecar's `sourceSha256` (§5.7.2). A fabricated citation therefore cannot exist: planted files have no sidecar (I1), and tampered documents fall out of the index. |

## 5. Design

### 5.1 The single ingest class

New module `agent/ingest.ts`. One class, one staging entry point, one deletion
entry point, discriminated by target — never by caller:

```ts
export type IngestTarget =
	| { readonly kind: "document"; readonly docId: string; readonly filename: string; readonly title: string }
	| { readonly kind: "tree-path"; readonly path: string };

export class IngestPipeline {
	/** Stage bytes and decide admission, in this order, for every caller. */
	async stage(input: { workspace: string; bytes: Uint8Array; target: IngestTarget }): Promise<Staged>;
	/** Remove staged bytes, derived text, and sidecar together. */
	async remove(input: { workspace: string; target: IngestTarget }): Promise<void>;
}

export type Staged = {
	readonly docId: string;        // control-plane id, or uploadsDocIdOf(path)
	readonly path: string;         // corpus/raw/<docId>.<ext> | corpus/uploads/<path>
	readonly bytes: number;
	readonly sourceSha256: string;
	readonly searchable: boolean;  // indexing !== "none"
	readonly indexing: "text" | "derived" | "none";
};
```

`stage` runs four steps in a fixed order, and this order *is* the pipeline:

1. **Stage the bytes verbatim** at the target's location (`stageRaw` /
   `stageUploadFile` as today — they move into this module).
2. **Admit** (§5.3): decide `indexing` and `textPath`, deriving PDF text into
   `corpus/text/<docId>.txt` when extraction succeeds; validate strict UTF-8
   for text extensions.
3. **Register**: write the sidecar (§5.2) — both roots, same shape.
4. **Report**: return `Staged`. The control plane records exactly this object;
   the HTTP tools return it verbatim.

The two HTTP tools become adapters with no logic of their own:

```ts
export class IngestTool extends HttpTool {
	async handle({ req, url, agent }: ToolRequest) {
		const bytes = await readRawBody(req, MAX_UPLOAD_BYTES);
		const staged = await pipeline.stage({
			workspace: this.#workspace, bytes,
			target: { kind: "document", docId: safeDocId(url.searchParams.get("docId") ?? ""),
			          filename: url.searchParams.get("filename") ?? "", title: url.searchParams.get("title") ?? "" },
		});
		agent.noteCorpusChange();
		return staged;
	}
}
// UploadsFileTool: identical shape, target { kind: "tree-path", path }
```

R1's acceptance is structural: `stageRaw`/`stageUploadFile`/`stageDerivedText`/
`writeMeta` are module-private to `ingest.ts`. A future ingestion caller
(RFC 0010 connector, a re-parse endpoint) imports `IngestPipeline` or it does
not exist. The e2e asserts behavior equality rather than code shape: the same
fixture through both UI points yields the same `indexing` and the same
citability (§7).

### 5.2 The sidecar registry

`corpus/meta/<docId>.json` becomes the registry — the single source of truth a
document exists at all. Today only `raw` documents have one, carrying
`{title, filename, at}`; the shape extends and the coverage becomes total:

```json
{
  "docId": "4015c037-70f4-432a-9e39-9e1a0e9a8dce",
  "root": "raw",
  "title": "sito-pronto-per-doma.pdf",
  "filename": "sito-pronto-per-doma.pdf",
  "stagedPath": "corpus/raw/4015c037-….pdf",
  "sourceSha256": "…",
  "bytes": 2831442,
  "indexing": "derived",
  "textPath": "corpus/text/4015c037-….txt",
  "at": 1792937043811
}
```

`textPath` is `null` when `indexing` is `"none"`. Keying: `raw` keeps the
control-plane docId; `uploads` uses `uploadsDocIdOf(path)` — deterministic, so
the tree path and the registry agree without coordination. Listings
(`/corpus`, `/uploads`) and the citation store read this file; the frontend
keeps consuming the `Staged` object through the control plane, which records it
in Postgres (RFC 0007's `documents` row and its `ingestStatus` continue to
describe the parse plane; `searchable`/`indexing` describe the citation plane —
one decision, two recorded views).

### 5.3 Admission rules, decided once

Deterministic, in this order, evaluated only by `IngestPipeline.stage`:

| File (by original filename) | Admission step | Result |
|---|---|---|
| `.pdf` | unpdf extraction, bounded as today (1000 pages, 16 MB images, 30 s) | non-empty text → `derived`, `textPath = corpus/text/<docId>.txt`; else → `none` |
| text extension (`md`, `txt`, …) | decode UTF-8, re-encode, byte-compare | equal → `text`, `textPath = stagedPath`; not equal → `none` |
| anything else | — | `none` |

The UTF-8 roundtrip check exists because Node's `readFile(…, "utf8")` never
fails: invalid sequences silently become U+FFFD, which is exactly the
garbage-index failure in miniature. The check runs once, on the ingest request's
bytes, before any index is built; a file that fails it stays staged (it may
still be a perfectly good workspace file for a skill) but is never citation
evidence. Cost: one extra encode of the bytes at upload time; the read path
never pays it again.

### 5.4 The store reads the registry: three walkers become one

`loadDocuments` today walks `corpus/raw/`, then walks `corpus/uploads/`, then
resolves derived text per branch — two rule sets re-deriving what ingestion
already knew. After this RFC it performs exactly one walk and one kind of read:

```ts
const loadDocuments = async (env, context) => {
	const metas = await env.listDir(META_DIR, context);       // the one walk
	const documents: CorpusDocument[] = [];
	for (const name of metas.value ?? []) {
		if (name.kind !== "file") continue;
		const sidecar = await readSidecar(env, name, context); // {…} | null
		if (sidecar === null || sidecar.indexing === "none" || sidecar.textPath === null) continue;
		const read = await env.readTextFile(sidecar.textPath, context);  // the only read
		if (!read.ok) continue;                                  // raced with a delete
		documents.push({
			docId: sidecar.docId, filename: sidecar.filename, title: sidecar.title,
			version: 1, text: read.value, textSha256: sha256OfText(read.value),
		});
	}
	return documents;
};
```

No filename inspection, no `RAW_DIR`/`UPLOADS_DIR` reads, no branch on root.
The lazy index and `invalidate()` stay as they are; `grepLines`, `readWindow`,
`annotate`, `verify` are unchanged above the document map. The title/filename
fallback heuristics of `listRawDocuments`/`readMeta` disappear: the registry is
total, so there is nothing to fall back to.

### 5.5 Two external entry points, one pipeline, proven every run

The coherence the user-facing system needs is: *the documents the agent can see
are the documents it can cite.* Formally, for every staged document `D`:

- **I1 (one registry)** — `D` is listed ⟺ `D` has a sidecar; `D` is greppable,
  readable, annotatable ⟺ `sidecar.indexing ≠ "none"`; the text every
  verification runs against is exactly the file at `sidecar.textPath`.
- **I2 (no blind reads)** — no byte sequence enters the index without having
  been validated (strict UTF-8) or derived (PDF extraction) at ingest.
- **I3 (one decision)** — `searchable` at ingest equals index membership
  forever after; both are the same sidecar field.
- **I4 (no orphans)** — deletes remove bytes, derived text, and sidecar
  together.
- **I5 (no side doors)** — every staging caller is `IngestPipeline` (R1).
- **I6 (evidence immutability)** — no model-issued tool call can plant or
  mutate evidence: `write`/`edit` refuse `corpus/**` in every run, and a
  document whose bytes no longer hash to its registry entry falls out of the
  index (§5.7.2).

I1–I6 are checked structurally (unit tests, R1's import rule) and behaviorally
(e2e): the same PDF fixture and the same `.md` fixture are pushed through
`dashboard/documents` and `dashboard/uploads`, and the e2e asserts both paths
report the same `indexing`, and that one and the same sentence — "Il contratto
si rinnova il 1 marzo 2027" — is citable through `corpus_annotate` from both,
with the ids differing only in `docId`. Two entry points, one pipeline, is not
a convention to remember; it is a property the suite fails on when violated.

### 5.6 Failure semantics

#### 5.6.1 A PDF contains no extractable text

A scanned, encrypted, malformed, or oversized PDF takes this path:

1. `stageDerivedText` returns `null` (its bounds: 30 s, 1000 pages, 16 MB
   images — unchanged).
2. The sidecar is written with `indexing: "none"`, `textPath: null`; `stage`
   returns `searchable: false`. The upload itself never fails because
   extraction did (unchanged rule).
3. The document is staged and listed — the user sees it in the UI, can download
   the raw bytes, and the control plane records it (Postgres `ingestStatus`
   keeps its own `raw_only` meaning for the parse plane, RFC 0007).
4. The citation engine never sees it: `corpus_grep` with that `docId` returns
   `not_found`; `corpus_read` returns `not_found`; `corpus_annotate` returns
   `not_found` and writes nothing. There is no fallback to raw bytes on any
   path — that fallback is the bug this RFC deletes.
5. In a strict run, content from that PDF is not evidence. The model's honest
   exits are the ones RFC 0006 §5.3 already defines: publish
   `UNANSWERED: <what is missing>` with no citations, or `answer_plain` when no
   document evidence was used at all. If the user wants the content citable,
   they supply a text-bearing version (an OCR'd copy) as a new document;
   re-ingestion under the same docId is a control-plane decision that already
   exists and is out of scope here.

#### 5.6.2 The agent uses a document outside the citation index

Two channels exist, with different guarantees:

**Channel A — corpus tools.** Every `corpus_*` call names a `docId`. If the id
is not in the registry, or is registered with `indexing: "none"`, the store
throws `not_found` before any annotation is written. The call still spends
corpus budget (the budget counts corpus-tool calls, not successes — the
friction is visible in the citations report, RFC 0006 R12). So through the
tools, an unindexed document is unreachable, not merely unciteable.

**Channel B — `bash` and `read`.** The sandbox is a workspace: in a free run
the agent can `cat corpus/raw/x.pdf`, `cat corpus/text/x.txt`, or open any
tree file, and that is by design (uploads are workspace files for skills,
RFC 0009). §5.7.1 closes the channel where it matters: during a strict run the
workspace tools are refused outright, so the model cannot even *read*
non-indexed content. What remains true in every run is the deeper guarantee:
such knowledge cannot become *verified evidence*, because `corpus_annotate`
mints ids only for registry-admitted documents, so no `[cit_…]` token can ever
refer to content the index does not contain. The gate then forces the choice:

- the claim carries a verified citation → the cited span is real text of an
  admitted document (span-level attribution, RFC 0006's declared property), or
- the claim carries no citation → the line is rejected (`uncited_line`) unless
  the whole reply exits `answer_plain`/`UNANSWERED`.

The residual gap is declared, not accidental: the model can state an unciteable
fact *inside* a line that carries an unrelated token — the decorative-citation
pathology observed in the audited run 1. The gate verifies span-level
attribution, not sentence-level relevance; closing that is a separate problem
(this RFC's §2.3). Two mitigations land with this RFC because they are cheap:
the strict prompt section gains the sentence *"Documents that `corpus_grep`
cannot see are not evidence; never back a claim with them"*, and §5.7.1's tool
gate removes the audited failure mode entirely — the 16 `quote_mismatch`
rejections of run `K54Ud12FZGzjCc5x` were the model reading real text through
`bash` that the index could not verify; under the gate those reads never
happen, and under §5.4's registry the same text *is* the index, so the reads
happen through `corpus_read` and verify.

### 5.7 The strict tool gate and corpus integrity

The evidence channel has two layers to close. The first is the one the audit
showed (§5.6.2, channel B): during a strict run the model can read the
workspace with `bash`/`read`, learn facts the index cannot verify, and smuggle
them into a gated reply. The second is worse and silent: the workspace tools
can *write*. `NodeExecutionEnv` confines them to the workspace, and `corpus/`
is inside it — `write` accepts `corpus/uploads/facts.md` today, and `edit`
accepts `corpus/raw/<docId>.md`. The trace:

```
free run     write corpus/uploads/facts.md   "Il contratto si rinnova il 2030"
(next store build: the file has no sidecar — but a tampered raw file of an
 admitted document, or an overwritten corpus/text/<docId>.txt, does carry one)
strict run  corpus_grep finds it -> corpus_annotate mints a VERIFIED id
            answer_publish passes the gate: the citation is exact, real,
            and fabricated by the model itself
```

Two rules and one check close both layers. All of them live in the citation
extension and the store — no framework, image, or compose change.

#### 5.7.1 The strict gate: while the current run is strict, corpus tools only

The framework's tool hooks support a veto: `ToolHooks.beforeTool`, "the first
`block` wins" (`pi-durable` `harness/types.d.ts`). The hook reads the same run
pointer the strict section reads, so the gate is per-submission exactly like
the gate it protects (RFC 0006 R13): free prompts before and after keep the
full toolbox.

```ts
const strictToolGate = () =>
	hook(ToolTask, {
		async beforeTool(call, api, context) {
			if (call.name !== "bash" && call.name !== "read" && call.name !== "write" && call.name !== "edit")
				return undefined;
			const run = await readCurrentRun(api, api.conversationId, context);
			if (run === null || !run.strict) return undefined;
			return {
				block:
					"bash, read, write and edit are disabled in this strict-citations run: use " +
					"corpus_grep and corpus_read; only the citation index is evidence",
			};
		},
	});
```

Why each tool is refused rather than filtered:

- **`bash`** — any command reads and writes bytes (`cat`, `node -e`, shell
  redirection). A command-string filter is heuristics (symlinks, base64,
  `-e` payloads bypass it); there is no robust partial allow.
- **`read`** — reading *anything*, not just `corpus/`, produces knowledge the
  index cannot verify (workspace notes, artifacts). In a strict run the only
  evidence channel is the index by definition, so the tool has no legitimate
  use. A `corpus/**`-only filter would be robust (the argument is a confined
  path) but pointless: everything else it could read is non-evidence by the
  same rule.
- **`write`/`edit`** — no legitimate use either: the strict section answers
  from the corpus, and artifacts produced by scripts cannot run without
  `bash` anyway. Declared consequence: **a strict run is an evidence Q&A turn**;
  artifact generation (md-to-docx, RFC 0009) stays a free-run capability. A
  dedicated non-bypassing `artifact_write` tool is an open question (§9), not
  part of this RFC.

Blocked calls return a named error to the model, which redirects to the corpus
tools; they spend no corpus budget (`spendCall` lives in the corpus tools
only). The block reason is counted like every other rejection, so the friction
is measurable (RFC 0006 R12).

#### 5.7.2 Corpus integrity in every run: path refusal and the hash check

The strict gate is not enough, because fabrication does not need to happen in
the strict run. Two always-on rules close it:

1. **`write`/`edit` refuse `corpus/**` in every run.** Their argument is a
   single structured path, already normalized and confined by the execution
   env, so a prefix check is exact — the same robustness that makes a path
   filter impossible for `bash` makes it trivial here. The same `beforeTool`
   hook implements it: when the tool is `write` or `edit` and the resolved
   argument path is under `corpus/`, block unconditionally.
2. **The index build verifies bytes against the registry.** `bash` in a free
   run can still write into `corpus/` through the shell — no tool hook sees a
   shell's redirections. So admission is not just declared once; it is
   *checked on every index build*: a document enters the index only when
   `sha256(read of stagedPath) === sidecar.sourceSha256`. A mutated raw file or
   a swapped derived text changes the hash, the document falls out of the
   index, and any stored citation to it re-verifies as `quote_mismatch`
   (RFC 0006 R11's honest failure). What remains possible — planting a new
   sidecar-less file — is inert by I1: no sidecar, no index entry.

The residual, stated plainly: a free-run shell can corrupt an admitted
document's bytes; the system's answer is not to prevent the write but to refuse
the consequence — the document stops being evidence until it is re-ingested
through the pipeline. Detection over prevention, because prevention at the
shell level requires an immutability mechanism (read-only mounts) that also
blocks the pipeline's own writes.

### 5.8 Interaction with RFC 0005, 0006, 0007

| This RFC | The other |
|---|---|
| Registry read path (§5.4) | Supersedes RFC 0006 §5.2's "v1 reads the staged bytes directly" paragraph; §5.2's port, methods and bounds are unchanged. A pointer is added to 0006 in the same change. |
| `searchable`/`indexing` (§5.2) | RFC 0007's `documents.ingestStatus` keeps describing the parse plane; the citation plane's flag is now single-sourced. The catalog row records what the pipeline returned, not a re-derivation. |
| `IngestPipeline` (§5.1) | RFC 0005's future `CatalogStore` implements the same `CitationStore` port over Postgres + object storage; its admission must consume the same registry semantics, or the port's I1 breaks — noted here as a constraint on 0005. |
| Strict tool gate (§5.7) | RFC 0006's toolset narrows for the strict submission only; the gate, the envelope and the bounce hook are unchanged. RFC 0009's skills keep working in free runs; strict runs lose script-driven artifacts (§5.7.1, open question §9). |
| Uploads tree as workspace files | PRD 0003 unchanged: the tree stays the user's directory; only its indexable files join the citation corpus. |

## 6. Migration

One bootstrap pass, run once per sandbox at first store load after the upgrade:

1. Walk `corpus/raw/` and `corpus/uploads/` (the last directory walk the read
   path will ever do).
2. For every file without a complete sidecar, run the same admission rules
   (§5.3) and write the sidecar. Uploads tree files get sidecars keyed by
   `uploadsDocIdOf(path)`; orphaned `corpus/text/` files with no staged source
   are deleted.
3. Log what was registered. Idempotent by construction: a second run finds
   complete sidecars and does nothing.

Declared consequence, accepted: stored annotations made against raw PDF bytes
before the migration re-verify as `quote_mismatch` afterwards (the audited
`cit_f54f1c0778`, quoting `/CreationDate`, is the one such case in existing
sessions). That is the honest state — those citations were made against bytes
that were never the documents' text. No other back-compatibility shims.

## 7. Testing

- **Unit, pipeline** (`agent/ingest.test.ts`): admission matrix — text file
  (valid UTF-8) → `text`; text file with invalid UTF-8 bytes → `none` +
  `searchable: false`; PDF with text layer → `derived`; scanned/garbage PDF →
  `none`; `.docx` → `none`; both targets produce the same `Staged` semantics
  for the same bytes. Delete removes bytes + derived + sidecar (R9).
- **Unit, store**: the registry is the only walk — a staged `.pdf` in
  `corpus/raw/` whose sidecar says `derived` is indexed from
  `corpus/text/…txt` (the regression the current suite misses: the uploads
  mirror test exists, `citation-store.test.ts:73`, the raw one does not); a
  sidecar-less file is invisible; `corpus_annotate` of a derived-text sentence
  succeeds (the exact operation that failed 23 times in the audited sessions).
- **Unit, bootstrap**: a pre-RFC layout (raw + sidecar-less uploads + orphaned
  derived text) migrates to total registry coverage; second run is a no-op.
- **Unit, gate** (`agent/citation-agent.test.ts`): a strict run refuses
  `bash`/`read`/`write`/`edit` with the named block and succeeds through
  `corpus_grep`/`corpus_read`; a free run executes them (R11). `write`/`edit`
  with a `corpus/**` path are refused in a free run too; `workspace/notes.md`
  still writes (R12). A tampered staged file (bytes edited behind the
  pipeline's back) drops out of the next index build; the stored citation
  re-verifies `quote_mismatch` (R12, RFC 0006 R11).
- **E2E** (`e2e-test/citations.sh`): (a) strict prompt against a `/ingest`-staged
  PDF — `evidence: cited`, quote contains `rinnova`, `docId` is the raw id
  (this fails on current `main`); (b) the same fixture through both UI entry
  points yields the same `indexing`, and the same sentence is citable from
  both; (c) a scanned-PDF fixture (no text layer) through `/ingest` reports
  `searchable: false` and a strict prompt over it returns `not_found`-only
  corpus answers, ending in `UNANSWERED` or `plain`, never a citation; (d) the
  scripted strict run attempts one `bash` call first and asserts the named
  block, then proceeds through the corpus tools (R11).

## 8. Rollout

Agent-only change: new `ingest.ts`, adapters in `tools.ts`, registry read in
`workspace-store.ts`, the tool gate in `citation-tools.ts`, bootstrap pass,
tests. No compose, manager, or frontend contract changes (`Staged` grows the
`indexing` field additively; the frontend already surfaces `searchable`). Gates: `cd agent && npm run typecheck && npm
test`, then `e2e-test/citations.sh` against `./dev.sh up` (§7 a is the
regression that guards the audited bug), full `./verify.sh` at merge.

## 9. Open questions

1. **Future extractors.** When `.docx`/`.ods` parsers arrive (RFC 0005's parse
   plane), do they become `derived` producers in this pipeline, or does the
   parse plane stay separate with its own `ingestStatus`? Proposal: extractors
   that produce *citation-grade text* join `stage`'s admission; parsers that
   produce *structured knowledge* stay on RFC 0007's plane.
2. **Sidecar versioning.** The registry shape needs a `version` field the day
   it gains a consumer that migrates (the bootstrap pass reads leniently
   today). Cheap to add now; deferred until a second shape exists.
3. **Re-ingestion semantics.** Uploading different bytes under the same docId
   is currently a silent overwrite on the sandbox side. The registry makes the
   overwrite visible; whether to refuse it (content-addressed docIds) is a
   control-plane decision to take with RFC 0007's catalog.
4. **A dedicated artifact tool for strict runs.** §5.7.1 makes a strict run an
   evidence Q&A turn: script-driven artifacts (md-to-docx) cannot run without
   `bash`. If users need both in one turn, the candidate is a narrow
   `artifact_write` tool that writes only under `artifacts/`, takes markdown,
   never returns workspace content — evidence channel stays closed. Deferred
   until a real workflow asks for it.
