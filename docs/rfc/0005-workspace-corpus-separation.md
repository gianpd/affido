# RFC 0005 — Workspace/corpus separation: durable shared knowledge behind domain tools

| Field | Value |
|---|---|
| Status | Draft |
| Author | pi-durable containers maintainers |
| Date | 2026-10-20 |
| Target | `agent/`, `frontend/`, `sandbox-manager/`, object storage, Postgres catalog |
| Related | PRD 0001 (`docs/prd/0001-evidence-flow-v1.md`), RFC 0003, `agent/corpus.ts`, `agent/agent.ts`, README |

## 1. Summary

Today the corpus is a directory inside the sandbox workspace:
`corpus/raw/<docId><ext>` on the per-user workspace volume. The agent reaches it
with `bash` and `read`, the web app uploads through the sandbox, and a preview
reads the file back through the sandbox.

That is simple and works for a handful of documents. It does not work when the
corpus is shared by several agents or users, when it must survive the sandbox
volume, or when a user uploads hundreds of documents. The workspace is scratch
space; the corpus is durable shared knowledge. They have different lifecycles,
different access rules, and different scaling limits.

This RFC separates them:

```
workspace  /workspace        scratch, per sandbox, coding tools, disposable
corpus     object storage    durable, shared, versioned, indexed in Postgres
session    /data/session.sqlite  unchanged
```

The agent never mounts the bucket and never receives bucket credentials. It
reaches the corpus through five domain tools: `corpus_search`, `corpus_read`,
`corpus_annotate`, `corpus_publish`, `corpus_history`. The server owns keys,
versions, hashes, citations, retries and conflict recovery. The model sees
documents, snippets, offsets and citation IDs.

The storage primitive is an implementation detail behind a `CorpusStore` port.
A plain object bucket with immutable, content-addressed objects and a Postgres
catalog is the baseline. Casplane is an optional backend when same-key branches
and merge lineage are required. The tool contract is identical either way.

## 2. Problem

### 2.1 Current trace

```
browser
  -> frontend
  -> POST /u/<user>/ingest?docId=...&filename=...
  -> sandbox IngestRawTool
  -> stageRaw({ workspace, docId, filename, bytes })
  -> /workspace/corpus/raw/<docId><ext>
  -> Postgres: document, ingest_event, corpus, corpus_document

agent prompt
  -> bash ls corpus/raw
  -> read corpus/raw/<docId><ext>

dashboard preview
  -> GET /raw?docId=...&filename=...
  -> sandbox readFile()
```

Facts that matter:

- Uploading requires the sandbox to be up. With the synchronous parser planned
  by PRD 0001 (timeout 660 s), an ingest also keeps the sandbox active and
  defeats the idle pause.
- The browser limit is 10 MiB (`MAX_UPLOAD_BYTES` in `agent/corpus.ts`). The
  parser limit is 50 MB. The workspace volume is finite.
- Retrieval is `ls` plus `read`. At 100 documents the model cannot tell which
  documents matter, and the context fills with file listings and full text.
- There is no versioning, no citation pinned to a version, no sharing between
  sandboxes, and no way to read the corpus from a new sandbox without the old
  volume.
- PRD 0001 explicitly lists "Condivisione di corpora tra utenti" as a non-goal
  for v1. That non-goal ends with this RFC.

### 2.2 Why moving bytes is not enough

Corpus scalability is not only a storage problem. A 10^5-document bucket read
with `list` is O(N) head requests, and a 10^5-document listing is useless to a
model. The scalable component is the catalog and the retrieval policy:
`corpus_search` returns a bounded candidate set, `corpus_read` returns a bounded
window, and the model never enumerates the bucket.

The second scalable component is the write policy. Source documents are
immutable. Derived text is deterministic from source plus parser version.
Agent contributions are append-only records. Only the canonical knowledge page
is mutable, and only one writer or a synthesizer advances it. This is simpler
than allowing N agents to edit one document and hoping the merge is free.

### 2.3 What this RFC does not change

- The session remains SQLite at `/data/session.sqlite`, on the data volume.
- The workspace remains `/workspace`, with `read`, `write`, `edit`, `bash`.
- `GET /health` and `GET /status` never open storage. The corpus catalog is not
  touched by a probe.
- `POST /prompt` remains idempotent by `requestId`.
- The agent remains stateful and durable. The corpus simply becomes more durable
  than the sandbox.

## 3. Goals and non-goals

### 3.1 Goals

| ID | Goal |
|---|---|
| G1 | Corpus bytes live outside the workspace and survive sandbox stop, recreation and host change. |
| G2 | A corpus can be shared by several agents and users, with explicit roles. |
| G3 | Uploads do not require an active sandbox and are not bounded by a 10 MiB browser limit. |
| G4 | The model reaches the corpus through a small, domain-level tool surface, not a storage protocol. |
| G5 | Every published claim is attributable to an exact document version and text span. |
| G6 | The catalog scales to 10^5 documents per tenant without bucket enumeration. |
| G7 | Writes from independent agents never conflict; same-page writes have an explicit, auditable resolution. |
| G8 | The design is testable with a fake `CorpusStore`, no database and no network. |

### 3.2 Non-goals

- A general-purpose file browser over the bucket for the model.
- Vector search, embeddings or RAG. Lexical search in Postgres first; semantic
  retrieval is a separate decision.
- Semantic merge inside the storage layer. The synthesizer decides; the store
  records lineage.
- Cross-corpus transactions.
- Replacing the session database with the corpus.
- Exposing the 17 raw casplane tools to the model by default.
- Making the corpus mountable as a local directory in the sandbox.

## 4. Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| R1 | No corpus bytes under `/workspace` after migration. | `bash find /workspace -name '*.pdf'` returns nothing for corpus uploads. |
| R2 | Upload and parse do not activate the sandbox. | A cold sandbox stays stopped; `POST /corpus/ingest` completes and Postgres reaches `ready`. |
| R3 | The model surface is five tools, under 4 KB of JSON Schema. | `tools/list` for `corpus_*` is under 4 KB; no raw storage tools. |
| R4 | `corpus_search` never lists the bucket. | It queries Postgres; a test with 10^4 rows returns in bounded time and a bounded result. |
| R5 | `corpus_read` is bounded. | Default window is at most 16 KB of text; full documents require an explicit range. |
| R6 | Offsets are code points. | A gold document with astral characters returns exact `start`/`end` and an exact slice. |
| R7 | The server recomputes hashes. | A model-supplied hash is ignored; a stale text version returns `hash_mismatch`. |
| R8 | Same-page writes never silently overwrite. | A stale `baseVersion` returns `stale_base` with the current version; no write. |
| R9 | Independent writes never conflict. | N agents writing N annotation keys all succeed first attempt. |
| R10 | Citations are pinned to a version. | Audit after restart and after more than `KeepVersions` advances still verifies or reports `version_unavailable`. |
| R11 | Access is scoped by corpus and role. | A `reader` cannot annotate or publish; a non-member gets `not_found`, not `forbidden`. |
| R12 | Ingestion is idempotent. | Same `docId` + same `sourceSha256` + same parser version returns the existing record; different hash returns `409`. |
| R13 | Deletion is explicit. | A deleted document is hidden from search, and a hard-delete path exists for user erasure. |
| R14 | Migration is reversible. | Dual-read and dual-write flags; backfill is idempotent; no data loss on rollback. |

## 5. Design

### 5.1 Two planes

| Plane | Location | Lifetime | Access | Tools |
|---|---|---|---|---|
| Workspace | `/workspace` volume | Sandbox | `read`, `write`, `edit`, `bash` | Coding tools |
| Corpus | Object storage | Independent of sandbox | `CorpusStore` + Postgres catalog | `corpus_*` |
| Session | `/data/session.sqlite` | Sandbox | pi-durable Harness | Conversation only |

The workspace is where the agent writes scratch files, runs commands, unpacks
an archive, produces a chart. The corpus is where the user's documents and the
shared knowledge live. The prompt says this explicitly. The model should never
`bash` into the corpus, and the corpus path should not exist in the workspace,
so the rule is enforced by construction rather than by instruction alone.

The corpus is not mounted into the sandbox. There is no FUSE mount, no synced
directory, no NFS. A tool call is the only path. This keeps bucket credentials
out of the sandbox and makes every access attributable.

### 5.2 Data model

Postgres remains the catalog, the ACL and the search index. It does not store
document bytes.

```
corpus
  id, ownerId, name, description, visibility, createdAt, updatedAt

corpus_member
  corpusId, principalId, role            reader | annotator | editor | owner

document
  id, corpusId, title, filename, kind    source | knowledge
  sourceKey, sourceVersion, sourceSha256
  textKey, textVersion, textSha256
  entitiesKey, entitiesVersion
  bytes, chars, docDate, parserVersion, labelSetSnapshot
  ingestStatus                           uploaded | parsing | ready | failed | deleted
  currentVersion                         version of the canonical page, if any
  createdAt, updatedAt

record                                   append-only agent contribution
  id, corpusId, documentId, authorId, runId
  kind                                   quote | claim | note | summary
  key, version, blobSha, textSha256
  citationId, start, end
  createdAt

citation
  id, runId, corpusId, documentId
  sourceVersion, sourceSha256
  textVersion, textSha256
  start, end, text
  status                                 attribution_verified | hash_mismatch | version_unavailable
```

`record` is the append-only knowledge log. A record is immutable. It can be
superseded by a later record or consumed by a canonical page, but it is never
edited in place. This is what makes multi-agent collaboration cheap: most
writes never touch a shared key.

Citations that must be auditable across sandboxes belong in the catalog, not
only in a session's SQLite file. The per-run session can keep a local mirror
for `/inspect`; the catalog row is the durable source for
`GET /corpus/citations`. PRD 0001 already requires the audit to survive a
sandbox restart; this RFC extends that requirement across sandboxes.

The exact migration from `document`, `ingest_event`, `corpus` and
`corpus_document` is an implementation detail. The fields above are the target
shape, not a migration script.

### 5.3 Object layout

The baseline is immutable, content-addressed objects. The key names the content
hash, so two writers of the same bytes converge on the same object and no
conditional write is needed for source and text.

```
<tenant>/corpus/<corpusId>/<docId>/source/<sourceSha256>.<ext>
<tenant>/corpus/<corpusId>/<docId>/text/<textSha256>.md
<tenant>/corpus/<corpusId>/<docId>/entities/<textSha256>.json
<tenant>/corpus/<corpusId>/<docId>/records/<authorId>/<recordId>.json
<tenant>/corpus/<corpusId>/<docId>/knowledge/<version>.md
```

The mutable pointer is one small object or one Postgres row:

```
<tenant>/corpus/<corpusId>/<docId>/knowledge/head   { version, blobSha, textSha256, updatedAt }
```

Baseline: `knowledge/head` is a Postgres row updated in a transaction with the
`version` precondition. If the backend is casplane, the same pointer is the
plane's head and the write uses `ifVersion`; the server hides the protocol.

Why content addressing:

- Uploads are idempotent by construction.
- The same parsed text is stored once per tenant.
- A cache key is the hash; immutable objects are safe to cache.
- A citation can pin a hash and a version without trusting the model.

Blob limits are real. Casplane defaults to 1 MiB for an inline value and 16 MiB
for a blob; a 50 MB PDF must be uploaded with multipart directly to the bucket,
or chunked. The RFC standardizes on direct multipart upload for source bytes
larger than the plane's blob limit; the catalog records the final object key and
hash. If the chosen backend is casplane, large sources use a side upload path in
the same bucket and the catalog records the object key; the facade hides which
path was used. The agent never downloads the raw PDF: it reads parsed text,
which is chunked and windowed by `corpus_read`.

### 5.4 Catalog and search

The catalog is Postgres. It holds ownership, roles, title, filename, doc date,
hashes, parser version, label snapshot, NER buckets, status and the current
version. Search is Postgres full-text (or trigram for identifiers) over title,
extracted entities and parsed text chunks.

The bucket is never the catalog. `list(detail:"heads")` in casplane performs one
head GET per key; this is acceptable for maintenance, not for an agent. The
agent calls `corpus_search`, which returns a bounded top-k with snippets and
metadata. For 10^5 documents this is an index query, not a listing.

Chunking: parsed text is stored in chunks of at most 1 MiB (the casplane value
limit) with absolute code-point offsets. `corpus_read` maps a needle or a line
range to the relevant chunks and returns only the requested window. The exact
chunking scheme is an implementation detail; the offsets are not.

### 5.5 Write protocol

Three write paths, three different guarantees:

1. **Source ingest.** Immutable. `POST /corpus/ingest` writes the source object,
   computes `sourceSha256`, calls the parser, writes `text/<textSha256>.md`,
   writes entities, updates the catalog. Idempotent by
   `(docId, sourceSha256, parserVersion, labelSetVersion)`. Same `docId` with a
   different hash is `409 document_conflict`, as in PRD 0001.
2. **Agent annotation.** Append-only. `corpus_annotate` writes a record under
   `records/<authorId>/<recordId>.json` and inserts a catalog row. No shared key,
   no conflict. The record pins the `docVersion` and, when present, a citation
   `{start, end, text}` verified by the server against that version.
3. **Canonical publish.** Optimistic concurrency. `corpus_publish` reads the
   current canonical version, validates coverage and citations, and writes
   `knowledge/<version+1>.md` with a `baseVersion` precondition. A stale base
   returns `stale_base` and the current version; nothing is overwritten. The
   caller re-reads and re-publishes, or writes a record and lets a synthesizer
   publish with `mergedFrom`.

If the backend is casplane, path 3 maps to `write(ifVersion)` and, on a lost
race, to `branch` + `merge`. The model still sees one `corpus_publish` call and
one `stale_base` result. The server, not the model, generates `opId`, reads the
head and records `mergedFrom`.

### 5.6 Citations and audit

A citation is a tuple, not a model assertion:

```
{ corpusId, docId, textVersion, textSha256, start, end, text }
```

The server recomputes `textSha256` from the stored text version and verifies the
exact code-point slice. The model supplies `{start, end, text}` and the version
it read; it never supplies a hash. A citation becomes a `citation` row with an
`id` and `status`. The row lives in the corpus catalog so an audit can run from
any sandbox, not only from the one that produced the run.

`corpus_read(version: V)` must remain available for every version referenced by
a citation. The baseline pins cited versions by copying the cited text to
`citations/<citationId>.txt` (or by retaining the blob). Casplane's default
retention (`KeepVersions`, branch retention, blob grace) can collect an old
version; without a pin, audit returns `version_unavailable`. This is a hard
requirement: PRD 0001 says the proof must survive restart, and it must also
survive retention.

### 5.7 Ingest pipeline

```
browser
  -> POST /corpus/uploads            { corpusId, docId, filename, bytes, sha256? }
  <- 201 { uploadUrl, key, expiresAt }        presigned PUT, or a direct stream
  -> PUT <uploadUrl>                          bytes go to object storage
  -> POST /corpus/ingest                      { corpusId, docId, sourceKey, sourceSha256 }
  <- 202 { ingestId, status: "parsing" }
  -> parser (external knowledge-extractor, async worker)
  -> text + entities objects
  -> Postgres: status "ready", textVersion, textSha256
```

The control plane owns this flow. The sandbox is not involved. A cold sandbox
stays cold. The parser is a worker, not a request inside the sandbox, so a
660 s parse cannot pin a user's sandbox. The browser limit becomes a product
quota, not a technical constant.

For small files, a direct multipart POST to `/corpus/ingest` is allowed. For
large files, the presigned path is the only one that avoids buffering the body
in the control plane. Both paths converge on the same object key and catalog
row.

## 6. Tools

Five model-facing tools. Schemas are illustrative; the exact TypeBox/JSON Schema
is part of the implementation. Write tools are idempotent by `requestId` where a
retry can duplicate a write.

### 6.1 `corpus_search`

Find candidate documents without reading them.

Input:

```json
{
  "corpusId": "corpus_7",
  "query": "clausola di recesso",
  "docIds": ["doc_42", "doc_43"],
  "labels": ["recesso", "penale"],
  "docDateFrom": "2025-01-01",
  "status": "ready",
  "limit": 10
}
```

Output:

```json
{
  "corpusId": "corpus_7",
  "results": [
    {
      "docId": "doc_42",
      "title": "Bando servizi 2026",
      "filename": "bando_42.pdf",
      "docDate": "2026-02-10",
      "version": 3,
      "textSha256": "a1b2...",
      "chars": 48210,
      "labels": ["recesso", "penale"],
      "snippet": "…la stazione appaltante può recedere…",
      "score": 0.87
    }
  ],
  "truncated": false
}
```

Rules:

- Bounded `limit` (max 20). No full text. Snippets are at most 400 characters.
- `docIds` is an optional run scope; the server intersects it with the caller's
  ACL. An unknown or unauthorized id is omitted, not leaked.
- If `query` is absent, return recently updated documents, not a bucket listing.
- `status` defaults to `ready`; a `parsing` document can be returned only when
  explicitly requested, so the model does not read a half-ingested document.

### 6.2 `corpus_read`

Read a bounded window of one document version.

Input:

```json
{
  "corpusId": "corpus_7",
  "docId": "doc_42",
  "version": 3,
  "needle": "recesso",
  "lineRange": [120, 180],
  "radius": 40,
  "maxChars": 12000
}
```

Output:

```json
{
  "corpusId": "corpus_7",
  "docId": "doc_42",
  "version": 3,
  "textSha256": "a1b2...",
  "start": 8421,
  "end": 12610,
  "text": "…",
  "lines": [{ "number": 120, "start": 8421, "end": 8460 }],
  "truncated": true,
  "next": { "start": 12610 }
}
```

Rules:

- At least one of `needle`, `lineRange`, `start`/`end` is required. A bare
  `corpus_read` returns a short table of contents or an error; it never dumps
  the whole document.
- Offsets are absolute code points in the UTF-8 markdown, computed by the
  server. The model copies them; it does not calculate them.
- `maxChars` is capped by the server (16 KB default). The result says whether it
  was truncated and how to continue.
- `version` defaults to the current catalog version. An explicit version is how
  a citation audit or a synthesis reads a stale base.
- A missing version returns `version_unavailable`; it does not silently fall
  back to the head.

### 6.3 `corpus_annotate`

Append one immutable contribution. This is the write tool for child agents.

Input:

```json
{
  "corpusId": "corpus_7",
  "docId": "doc_42",
  "docVersion": 3,
  "kind": "quote",
  "text": "La stazione appaltante può recedere dal contratto ai sensi dell'art. 109.",
  "citation": {
    "start": 8421,
    "end": 8502,
    "text": "La stazione appaltante può recedere dal contratto ai sensi dell'art. 109."
  },
  "tags": ["recesso"],
  "runId": "run_9",
  "requestId": "req_123"
}
```

Output:

```json
{
  "recordId": "rec_01J...",
  "corpusId": "corpus_7",
  "docId": "doc_42",
  "docVersion": 3,
  "citationId": "cit_5f...",
  "textSha256": "a1b2...",
  "createdAt": "2026-10-20T10:12:31Z",
  "replayed": false
}
```

Rules:

- The server re-reads `docVersion`, recomputes `textSha256`, checks bounds and
  the exact slice, and stores the citation. A supplied hash is ignored.
- A failed check returns `hash_mismatch`, `out_of_bounds` or `quote_mismatch`
  and writes nothing.
- `recordId` is content-addressed and stable for the same input; the same
  `requestId` returns the existing record with `replayed: true`.
- `kind: "note"` or `"summary"` may omit `citation`; `kind: "quote"` and
  `kind: "claim"` require one.
- No shared key is written. Two agents annotating the same document do not
  conflict.

### 6.4 `corpus_publish`

Publish a canonical page. This is the parent/synthesizer tool.

Input:

```json
{
  "corpusId": "corpus_7",
  "docId": "doc_knowledge_recesso",
  "baseVersion": 4,
  "markdown": "## Recesso\n\nLa stazione appaltante può recedere… [cit_5f…]",
  "citationIds": ["cit_5f..."],
  "runId": "run_9",
  "mergedFrom": ["rec_01J..."],
  "create": false,
  "requestId": "req_124"
}
```

Output, success:

```json
{
  "corpusId": "corpus_7",
  "docId": "doc_knowledge_recesso",
  "version": 5,
  "textSha256": "b7c8...",
  "citationIds": ["cit_5f..."],
  "publishedAt": "2026-10-20T10:14:02Z"
}
```

Output, stale base:

```json
{
  "ok": false,
  "reason": "stale_base",
  "expectedVersion": 4,
  "actualVersion": 5,
  "currentTextSha256": "c9d0...",
  "recover": "corpus_read the current version, merge, and publish with baseVersion 5"
}
```

Rules:

- Every `citationId` must exist, belong to the corpus and be
  `attribution_verified`; every `[cit_…]` token in the markdown must be in
  `citationIds`. A mismatch returns `unknown_citation` or `unverified_citation`
  and writes nothing.
- If `runId` is present, every subquestion in the run must be terminal and the
  coverage set must be complete; otherwise `coverage_incomplete`.
- `baseVersion: 0` creates a new canonical page only when `create: true` and the
  caller has `editor`; otherwise `not_found`.
- On `stale_base` the server does not retry and does not overwrite. The caller
  re-decides. This is the only place where the model sees optimistic
  concurrency, and the result tells it exactly what to do.
- `mergedFrom` is a list of record IDs, not blob hashes. The server resolves
  them and records lineage. If the backend is casplane, it maps to `merge`.

### 6.5 `corpus_history`

Read the lineage of a document, without bytes.

Input:

```json
{ "corpusId": "corpus_7", "docId": "doc_knowledge_recesso", "sinceVersion": 1, "limit": 20 }
```

Output:

```json
{
  "corpusId": "corpus_7",
  "docId": "doc_knowledge_recesso",
  "versions": [
    {
      "version": 4,
      "textSha256": "a1b2...",
      "authorId": "agent_analyst",
      "kind": "publish",
      "citationIds": ["cit_5f..."],
      "mergedFrom": ["rec_01J..."],
      "createdAt": "2026-10-20T10:00:00Z"
    }
  ],
  "next": null
}
```

Rules:

- Metadata only. To read a version, call `corpus_read({ version })`.
- This is the audit path for the dashboard and for a synthesizer that needs to
  know what changed. It is not required in the happy path.
- The model never sees object keys, blob hashes or branch IDs.

### 6.6 Surface size

Target: five tools, under 4 KB of JSON Schema, no `capabilities`, no `head`, no
`write`, no `branch`, no `merge`, no `put_blob`, no `get_blob`, no leases. The
prompt section is short:

```
Workspace is scratch. The corpus is durable shared knowledge.
Use corpus_search to find documents; never list or read corpus files with bash.
Use corpus_read for a window, not the whole document.
Use corpus_annotate for quotes and claims; the server verifies offsets and hashes.
Use corpus_publish only for a published answer; on stale_base, re-read and merge.
```

## 7. Use cases

### 7.1 Analyst: 50 documents, verified answer

Goal: answer "which tenders allow recession and on what notice?" across 50
documents.

```
parent
  corpus_search({ corpusId: "corpus_7", query: "recesso", limit: 12 })
    -> 6 candidate documents with snippets

child (one per subquestion)
  corpus_read({ docId: "doc_42", needle: "recesso", radius: 40 })
    -> { version: 3, start: 8421, end: 8860, text: "..." }
  corpus_annotate({
    docId: "doc_42", docVersion: 3, kind: "quote",
    text: "La stazione appaltante può recedere ...",
    citation: { start: 8421, end: 8502, text: "La stazione appaltante può recedere ..." },
    runId: "run_9"
  })
    -> { citationId: "cit_5f...", textSha256: "a1b2..." }

parent
  corpus_publish({
    docId: "doc_answer_9",
    baseVersion: 0, create: true,
    markdown: "## Recesso\n\n... [cit_5f...]",
    citationIds: ["cit_5f..."],
    runId: "run_9"
  })
    -> { version: 1, textSha256: "..." }
```

Audit after restart: `GET /corpus/citations?runId=run_9` recomputes
`textSha256`, bounds and the exact slice for each citation. It never calls a
model. If the cited version was collected, it returns `version_unavailable`; it
does not claim verification.

### 7.2 Two agents, one canonical page

Agent A and agent B both read canonical version 4.

```
A: corpus_publish({ docId: "doc_knowledge_recesso", baseVersion: 4, ... })
   -> { version: 5 }

B: corpus_publish({ docId: "doc_knowledge_recesso", baseVersion: 4, ... })
   -> { ok: false, reason: "stale_base", actualVersion: 5,
        recover: "corpus_read the current version, merge, and publish with baseVersion 5" }

B: corpus_read({ docId: "doc_knowledge_recesso", version: 5 })
B: corpus_publish({ ..., baseVersion: 5 })
   -> { version: 6 }
```

No edit is lost, and the model never sees `branch` or `merge`. If B cannot merge
an opaque contribution, it calls `corpus_annotate` with its section as a record
and a synthesizer later publishes with `mergedFrom`. The canonical page is
single-writer by contract; the records are multi-writer by construction.

### 7.3 200 uploads, one cold sandbox

```
browser -> POST /corpus/uploads -> presigned PUT -> POST /corpus/ingest
        -> 202 parsing (sandbox stays stopped)
parser  -> text + entities -> status ready
```

A 40 MB PDF uses the presigned multipart path and bypasses the plane's 16 MiB
blob limit. The agent later calls `corpus_search` and `corpus_read`; it never
downloads the PDF. The upload is a control-plane operation, so it does not
defeat the idle pause.

### 7.4 Team corpus, roles

```
corpus_member(corpus_7, alice, owner)
corpus_member(corpus_7, bob, editor)
corpus_member(corpus_7, agent_analyst, annotator)
```

`agent_analyst` can `corpus_search`, `corpus_read` and `corpus_annotate`, but
`corpus_publish` returns `forbidden`. Bob can publish. A non-member gets
`not_found` from `corpus_search`, so corpus existence is not leaked. The
catalog, not the bucket, enforces this. Casplane's namespace token is a second
line of defense, not the only one.

### 7.5 Audit and retention

```
corpus_history({ docId: "doc_knowledge_recesso", sinceVersion: 1 })
  -> versions 1..6, authors, citation IDs, mergedFrom

corpus_read({ docId: "doc_knowledge_recesso", version: 3 })
  -> exact text and textSha256

GET /corpus/citations?runId=run_9
  -> attribution_verified for each citation, or version_unavailable
```

Cited versions are pinned outside the normal retention window. A version that
was collected is reported as unavailable, never as verified.

## 8. Scalability analysis

| Axis | Workspace volume | Corpus plane |
|---|---|---|
| Capacity | host disk per user | quota, not disk |
| Sharing | none, per sandbox | corpus + roles |
| Versioning | none | immutable versions + audit |
| Search | `ls`/`grep`, O(files), context blow-up | Postgres FTS, bounded top-k |
| Upload | wakes and pins the sandbox | control plane, async |
| Cost | volume per user, backup per volume | GB + requests, lifecycle |
| Failure | disk full, volume lost | bucket durability, new dependency |
| Multi-host | no | yes, stateless plane |

Cost notes:

- Storage is not the dominant cost at this scale. A raw 17-tool surface costs
  about 3k prompt tokens per turn; a five-tool facade targets under 1k. At
  1,000 prompts/day and 20 turns, the tool-schema delta is tens of millions of
  tokens per day. The facade is the cheaper design even before storage.
- A write on casplane is one blob PUT, one head GET, one conditional head PUT,
  one log PUT and one marker PUT. A read is at least one GET. In-region object
  storage is cheap; latency is tens of milliseconds. Cache immutable blobs by
  SHA in the sandbox; never cache the mutable head without a version check.
- `corpus_search` must not use `list(detail:"heads")`. That call performs one
  head GET per key. Postgres is the index.
- Limits are part of the contract: 1 MiB inline value and 16 MiB blob by
  default. Large sources use multipart direct upload; large text is chunked and
  windowed. A PDF is never sent through a model tool.
- Retention is a product decision, not a storage default. Cited versions are
  pinned; uncited intermediate versions can be collected.
- Deduplication works within a tenant because objects are content-addressed.
  Cross-tenant deduplication would require a shared blob namespace, and a
  principal that knows a SHA could read another tenant's bytes. Do not do it.
- Postgres plus object storage is a dual write. Use idempotent content-addressed
  keys, a catalog row written after the object, and a reconciliation job for
  orphaned objects. Casplane does not remove this; it only removes the
  conditional-write problem for the head.

## 9. Migration

Phase 0 — port and fake:

- Add `CorpusStore` as a port with `putSource`, `putText`, `getText`,
  `putRecord`, `getHead`, `compareAndSetHead`, `signUpload`.
- Implement an in-memory fake and a test that runs the five tools without a
  database or network.
- Add `corpus_*` tools to the registry. They activate the agent only when called
  from a conversation; the dashboard endpoints use the catalog directly.

Phase 1 — dual write, dual read:

- `POST /ingest` writes the source to object storage and, behind
  `CORPUS_DUAL_WRITE=1`, keeps the workspace copy.
- `GET /raw` reads from object storage first, then the workspace.
- The agent prompt switches to `corpus_*`; `corpus/raw` remains for legacy
  sessions.
- The frontend uploads to the control plane; the 10 MiB limit becomes a quota.

Phase 2 — async ingest and backfill:

- Move the parser call to a worker. `POST /corpus/ingest` returns `202`.
- Backfill every existing `corpus/raw` file: hash, upload, create the catalog
  row, verify `sourceSha256`. The job is idempotent.
- Mark old documents with `storageKey`; a document without it stays readable
  from the workspace until backfilled.

Phase 3 — remove the workspace copy:

- Delete `corpus/raw` from the workspace after the backfill window.
- Reimplement `/ingest`, `/raw` and `DELETE /ingest` as control-plane routes, or
  remove them in favor of `/corpus/*`.
- `IngestRawTool`, `RawFileTool` and `DeleteRawTool` no longer write the
  workspace.
- The README and PRD 0001 are updated: "bytes never leave the volume" becomes
  "bytes live in the corpus plane; the workspace is scratch".

Rollback: keep dual-write and dual-read until the backfill is verified. A
rollback disables the corpus tools and falls back to the workspace copy; no
object is deleted before the window ends.

## 10. Alternatives

| Alternative | Why not |
|---|---|
| Keep the corpus in the workspace | Simple for one sandbox, but no sharing, no versioning, bounded by the volume, upload pins the sandbox, retrieval does not scale. |
| Raw casplane MCP in the agent | 17 tools, about 3k prompt tokens, `opId`/`ifVersion`/`branch`/`merge` leak into the model. Measured failure modes in casplane's own examples. |
| Direct S3 SDK inside the sandbox | Puts bucket credentials in a container where `bash` can read them; no ACL, no version semantics, every agent reimplements the protocol. |
| Bucket + Postgres + content-addressed objects (baseline) | Chosen. Simplest design that meets sharing, durability and scale. |
| Casplane behind the facade | Viable backend when same-key branches and merge lineage are required. The facade hides the protocol and the storage choice. |
| Corpus entirely in Postgres | Rejected for large bytes and PDFs; Postgres is the catalog, not the blob store. |
| Vector database / RAG now | Out of scope. Lexical search plus map-reduce covers the evidence flow; semantic retrieval is a later decision. |

## 11. Risks and open questions

1. **Backend choice.** Baseline object storage plus a Postgres head row, or
   casplane. Decide with a one-week spike: 100 documents, 3 agents, one
   disjoint-key run and one same-key run. Measure p95 read/write, tool calls and
   tokens per run, conflicts, synthesis cost and audit after 40 versions.
2. **Hard delete.** Casplane `delete` writes a tombstone and keeps history. User
   erasure needs a hard-delete path or a lifecycle policy. Resolve before
   production uploads.
3. **Retention pinning.** Cited versions must survive `KeepVersions` and blob
   GC. The baseline copies cited text to a pinned object; casplane needs a
   dedicated key or a higher retention for cited versions.
4. **Token provisioning.** Casplane uses a static bearer token file with
   per-namespace permissions. Per-user token creation and rotation are control
   plane work. The bucket credentials never reach the sandbox.
5. **Dual-write consistency.** Object write and catalog write can diverge. Use
   idempotent keys, write object first, then catalog, and reconcile orphans.
6. **Parser versioning.** A parser upgrade can change text for the same source.
   Pin `parserVersion` in the catalog and keep old text versions for citations.
7. **Quotas.** Per-user bytes, documents, parses per day and storage growth.
   Without quotas, "unlimited uploads" becomes an abuse and cost problem.
8. **Search quality.** Postgres FTS may be insufficient for multilingual or
   OCR-heavy corpora. Measure recall before adding embeddings.
9. **Synthesis cost.** A canonical page with many branches requires an LLM
   synthesizer. Prefer append-only records and periodic synthesis over frequent
   same-page writes.

## 12. Acceptance criteria

| ID | Test |
|---|---|
| AC1 | After migration, no corpus bytes exist under `/workspace`; `bash` cannot read a corpus document. |
| AC2 | `GET /health` and `GET /status` do not touch the corpus catalog or object storage. |
| AC3 | A cold sandbox stays stopped while `POST /corpus/uploads` and `/corpus/ingest` complete. |
| AC4 | `corpus_search` with 10^4 documents returns a bounded result without a bucket listing; p95 is measured and recorded. |
| AC5 | `corpus_read` returns exact code-point offsets for ASCII, accented and astral text; the gold slice matches. |
| AC6 | `corpus_annotate` rejects a wrong slice, an out-of-bounds span and a stale hash; no record is written. |
| AC7 | N agents writing N annotation keys all succeed first attempt; no conflict. |
| AC8 | Two `corpus_publish` calls with the same `baseVersion`: one succeeds, one returns `stale_base` with the actual version; no lost update. |
| AC9 | `corpus_publish` rejects an unknown citation and a markdown token not in `citationIds`. |
| AC10 | Audit after restart and after more than `KeepVersions` advances returns `attribution_verified` or `version_unavailable`; it never falsely verifies. |
| AC11 | A `reader` gets `forbidden` on annotate/publish; a non-member gets `not_found` on search. |
| AC12 | Same `docId` + same hash is idempotent; different hash returns `409`. |
| AC13 | The five corpus tool schemas total under 4 KB; the raw storage tools are absent from the default model surface. |
| AC14 | Backfill is idempotent; every migrated document has a matching `sourceSha256` and `textSha256`. |

## 13. Decision requested

Approve the separation of workspace and corpus, and the five-tool facade, as the
target design. Approve the baseline backend (object storage plus a Postgres
catalog and immutable content-addressed objects). Defer the casplane-versus-
bucket decision to the spike, behind the `CorpusStore` port. The tool contract
does not change with the backend.
