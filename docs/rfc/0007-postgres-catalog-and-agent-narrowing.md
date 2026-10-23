# RFC 0007 — Postgres document catalog and agent narrowing

| Field | Value |
|---|---|
| Status | Draft |
| Author | pi-durable containers maintainers |
| Date | 2026-10-22 |
| Target | `agent/`, `frontend/`, `sandbox-manager/`, `docker-compose.yml`, knowledge-extractor deployment |
| Related | RFC 0005, RFC 0006, PRD 0001 §4/§6.2/§6.4, `agent/corpus.ts`, `agent/citation-tools.ts`, `frontend/src/lib/server/db/schema.ts`, knowledge-extractor README (`/convert` contract) |

## 1. Summary

Today the agent meets the corpus through file operations: `bash ls corpus/raw`
followed by bounded reads. At more than a handful of documents the model cannot
tell which documents matter, and every answer pays the cost of enumerating them
all. The metadata to make that choice already exists — knowledge-extractor
returns NER entities, structure and `doc_date` per document — but nothing stores
it where a query can reach it.

This RFC puts the document catalog in the `oltp` Postgres the control plane
already runs, and makes it the agent's first point of contact with the corpus:

```
user query
  -> agent extracts the intent (which parties, dates, amounts, codes matter)
  -> catalog_query: SQL against document  (per-user read-only role, RLS on session_user)
  -> a small set of docIds
  -> narrowed investigation: corpus_grep / corpus_read on those docIds only
  -> citations verified against corpus/docs/<docId>.md, as in RFC 0006
```

Decisions already taken, recorded here:

- **D1 — External parse, not agent parse.** knowledge-extractor converts
  PDF/DOCX/text to markdown at ingest time. The agent never converts; it
  analyzes text that is deterministic, hashed and stored before any run.
  Rationale in §5.2; this is the PRD 0001 §6.2 position, unchanged.
- **D2 — Raw SQL, per-user read-only role, RLS keyed on `session_user`.** The
  agent writes `SELECT` statements against the catalog through one tool. The
  security boundary is Postgres itself: one login role per user
  (`agent_ro_<userId>`, member of the no-login group `agent_ro_group`) with
  `SELECT` on `document` only, and row level security whose policy derives the
  user from `session_user` — the one identity a session cannot change without
  superuser — plus per-role `statement_timeout`, read-only default
  transactions, and a per-role connection limit. No session setting carries
  identity: a custom GUC (`app.user_id`) is writable by any `SELECT
  set_config(...)` and is not a boundary. The tool's own syntax check is UX,
  not the boundary (§5.4).
- **D3 — Bytes stay in the workspace for now.** This RFC lands the catalog and
  the narrowing step of RFC 0005 early; it does not move bytes to object
  storage. When RFC 0005 lands, the same subset flow drives object fetch and
  the tool contract survives (§6).

Upload changes that ride along because the catalog is useless without them:
the browser/sandbox limit rises from 10 MiB to 15 MB and `.pdf` becomes a
first-class upload (§5.3).

## 2. Problem

### 2.1 Current trace

```
browser
  -> POST /u/<user>/ingest?docId=...&filename=...
  -> sandbox IngestRawTool
  -> corpus/raw/<docId><ext>            bytes staged, sourceSha256 computed
  -> Postgres document row              ingestStatus: raw_only
     (no parse, no entities, no docDate; ingestEvent.parser stays empty)

agent prompt
  -> bash ls corpus/raw                 the only "search" that exists
  -> corpus_grep / corpus_read          RFC 0006 tools over all staged files
```

Facts that matter:

- A 15 MB PDF staged today is indexed by `WorkspaceCitationStore` as UTF-8
  text: `readTextFile` decodes whatever it finds, so binary bytes pollute the
  citation corpus with replacement characters (§5.7).
- knowledge-extractor's `/convert` returns `entities`, `structure`, `doc_date`,
  `source_hash`, `ocr`, `ner` — exactly the columns a narrowing query needs —
  but today only `ingestEvent.parser` would keep them, as unqueryable history.
- The frontend accept list excludes `.pdf` entirely; the 10 MiB limit is
  enforced twice (`agent/corpus.ts`, `frontend/src/lib/server/upload-limit.ts`)
  and must change in both.
- The web app generates the `docId`, creates the `document` row keyed by it,
  and the sandbox stages bytes under the same id. There is one id space
  already; this RFC relies on it and freezes it as an invariant (I1).
- `oltp` sits on the shared `agents` network only. Per-user sandbox networks
  carry the agent, manager, Caddy and the web app. A sandbox cannot open a
  Postgres connection today.

### 2.2 Why narrowing must come before reading

RFC 0006 already bounds reads (`corpus_grep` limit, `corpus_read` maxChars),
but bounding the window does not bound the choice. With 100 parsed documents
the model still greps all of them per question; with entity-bearing queries
("contracts where Edilstrade is a party after June") a metadata index answers
in one query what grep answers in N scans. PRD 0001 §6.4 anticipated this with
a `corpus_metadata` tool over a pi session-scoped doc; a Postgres table is the
same idea with a real query language, shared by dashboard and agent, and it
survives sandbox destruction by construction.

### 2.3 What this RFC does not change

- The session stays SQLite at `/data/session.sqlite`; the conversation never
  touches Postgres.
- `GET /health` and `GET /status` never open storage — the catalog connection
  is lazy, opened only by a tool call inside a run.
- `POST /prompt` stays idempotent by `requestId`; uploads still do not activate
  the agent.
- Citation verification stays server-side over workspace text (RFC 0006); the
  catalog never stores text and never verifies anything.
- The sandbox-manager remains the only creator of sandboxes; topology changes
  are `create_args`/`ensure_guests` changes.

## 3. Goals and non-goals

### 3.1 Goals

| ID | Goal |
|---|---|
| G1 | Every parsed document is queryable by its extracted metadata (entities, docDate, title, hashes, status) from both dashboard and agent. |
| G2 | The agent's first corpus contact is a metadata query that returns docIds, never text. |
| G3 | A sandbox can only ever read its own user's rows, enforced by the database, not by tool code. |
| G4 | PDF uploads up to 15 MB parse end-to-end; binary raw files never enter the citation index. |
| G5 | The write path keeps PRD 0001 §6.2 guarantees: sandbox verifies `source_hash`, owns bytes and parsed markdown; the control plane owns metadata rows. |
| G6 | The design degrades: with Postgres unreachable the run falls back to full-corpus grep and says so. |
| G7 | When RFC 0005 moves bytes to object storage, the catalog query and the role/RLS design carry over unchanged. |
| G8 | The tenant boundary is asserted, not assumed: policy presence, zero cross-tenant rows, role flags, and password enforcement are build-breaking checks (§5.9, R13). |

### 3.2 Non-goals

- Full-text search over document text, embeddings, or RAG. Metadata containment
  and lexical narrowing only; RFC 0005 §3.2 still owns that decision.
- Exposing `corpus`, `corpus_document`, `ingest_event` or auth tables to the
  agent. v1 grants `SELECT` on `document` alone.
- Text or markdown in Postgres. The `document` row stays metadata-only.
- Write access of any kind from a sandbox to Postgres.
- Moving bytes off the workspace volume (RFC 0005).
- Multi-corpus ACLs and sharing (RFC 0005).

## 4. Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| R1 | `document` gains first-class `entities jsonb`, `structure jsonb` with a GIN index on `entities`. | A containment query on 10^4 rows uses the index (EXPLAIN) and returns bounded results. |
| R2 | One login role per user (`agent_ro_<userId>`, member of the no-login group `agent_ro_group`) has `SELECT` on `document` only. | As any agent role: `UPDATE`/`DELETE`/`INSERT`/DDL fail with `permission denied`; other tables yield no data (their names remain listable via `information_schema` — public metadata, not data). |
| R3 | RLS derives the user from `session_user`; no session setting carries identity. | Sandbox A's query returns zero rows of user B; `SELECT set_config('app.user_id', …)` or any `SET` before the same query changes nothing; a stolen role-A password, used on a direct connection, still reads only user A. |
| R4 | The catalog connection is unreachable from sandboxes unless provisioned. | With `CATALOG_URL` absent, the agent starts, answers, and the tool reports `catalog_unavailable`. |
| R5 | `catalog_query` accepts one read-only statement. | Non-`SELECT`/`WITH` input or any `;` is rejected with `not_a_read_query` before any connection is opened. |
| R6 | Queries are bounded server-side. | Role `statement_timeout` (2 s) aborts a heavy query; the tool truncates at 50 rows / 4 KB per cell and sets `truncated: true`. |
| R7 | Probes never open the catalog. | `GET /health` and `GET /status` on a fresh sandbox open zero Postgres connections (`pg_stat_activity` empty). |
| R8 | Upload limit is 15 MB on both sides; `.pdf` is accepted. | A 15 MB PDF ingests; a 15.1 MB file is refused by the form and by the sandbox with the same message. |
| R9 | Binary raw files never enter the citation index. | After a PDF ingest, `documents()` lists it only once `corpus/docs/<docId>.md` exists; grep over a raw `.pdf` returns no mojibake. |
| R10 | Ingest keeps PRD 0001 §6.2 semantics. | Same `docId`+hash idempotent; different hash `409`; `source_hash` mismatch leaves no file and no row. |
| R11 | Strict-citation runs count catalog calls in the corpus-call budget. | A run that only loops `catalog_query` exhausts `MAX_CORPUS_CALLS` and is rejected. |
| R12 | E2E exercises the full narrowing path through Caddy only. | `e2e-test` uploads a PDF, prompts for an entity-scoped question, and shows a `catalog_query` call preceding grep on the returned docIds. |
| R13 | A guard stage in the stack gate asserts the boundary (§5.9, I3–I6). | Red matrix: with the policy dropped, `FORCE` removed, an `agent_ro_%` role granted `rolsuper`, a trust line replacing scram in `pg_hba`, or a foreign row visible, `./verify.sh` fails; on a healthy stack it passes. |

## 5. Design

### 5.1 Planes after this RFC

| Plane | Location | Written by | Read by |
|---|---|---|---|
| Raw bytes | workspace `corpus/raw/<docId><ext>` | sandbox `/ingest` | sandbox `/raw`, parser call, audit |
| Parsed text | workspace `corpus/docs/<docId>.md` | sandbox (after `/convert`) | citation store (grep/read/annotate) |
| Catalog | Postgres `document` (+ `ingest_event` history) | web app only | web app, dashboard, agent via per-user `agent_ro_<userId>` roles |
| Session | `/data/session.sqlite` | Harness | Harness |

The split is unchanged from RFC 0006 §5.2 — "the control plane owns the
metadata; the sandbox owns the bytes" — with the catalog promoted from "row the
dashboard lists" to "index the agent queries".

### 5.2 Parse: knowledge-extractor at ingest (D1)

The parser is the existing service at
`/home/jaco/develops/RESEARCH/INFRA/knowledge-extractor/`. Deployment follows
the `pi-durable-agent:latest` pattern: the image is built from that repo,
tagged `knowledge-extractor:latest`, and declared in compose as a control-plane
service (`knowledge-extractor`, `agents` network, token via env). The sandbox
manager attaches it to every per-user network alongside `oltp` (§5.5). The e2e
guard that fails on `agent*` services is untouched: this is one shared service,
not a sandbox.

Why the agent must not parse (D1): the parsed text is the evidence surface.
RFC 0006 verifies quotes against a stable, hashed text; if that text were model
output it would vary with model, prompt and skill version, every re-parse would
invalidate past citations, and the verifier would be checking model text with
model text. Deterministic parse at ingest, hash pinned in the row and in the
workspace, is the only shape that keeps verification meaningful.

Ingest sequence (extends PRD 0001 §6.2, which stays authoritative):

```
browser  -> POST /u/<user>/ingest?docId&filename&title  (label set headers)
caddy    -> sandbox POST /ingest
sandbox  -> stage corpus/raw/<docId>.pdf, compute sourceSha256
sandbox  -> POST http://knowledge-extractor:<port>/convert
           headers: X-Job-Id: <randomUUID>, X-Ner-Profile | X-Ner-Schema
sandbox  -> assert response.source_hash == "sha256:" + sourceSha256   (one ==)
sandbox  -> write corpus/docs/<docId>.md, noteCorpusChange()
sandbox  -> respond 200 { docId, path, bytes, sourceSha256,
                         parsed: { textSha256, chars, docDate,
                                   entities, structure, ner, ocr, durationMs } }
web app  -> UPDATE document SET ingestStatus='parsed', entities=…, structure=…,
             textSha256=…, chars=…, docDate=…  + ingest_event(parser=…)
```

Deltas from the PRD §6.2 acceptance criteria, to be merged into the PRD when
this RFC is implemented:

- The ingest response carries metadata, not `markdown`: the markdown lives in
  the workspace; the row stores hashes and counts. (The PRD's intent — the web
  app records what happened — is unchanged.)
- Parser error mapping (`401→502`, `413→413`, `415→415`, `422→422`,
  `429/502/504→503` with `Retry-After`) and the 660 s timeout budget are the
  PRD contract, adopted as-is. The ingest stays a synchronous sandbox call for
  v1; moving it to an async worker is RFC 0005 phase 2 work.
- The upload limit becomes 15 MB (§5.3); PRD §4's "beyond 10 MB is out of
  scope" line is superseded.

Idempotency and immutability: same `docId` with the same `sourceSha256`
returns the existing record; a different hash is `409`. Consequence, frozen as
invariant **I2**: parsed text under a `docId` never changes. That is what lets
the citation store keep `version: 1` honest — a re-parse with different output
is a new `docId`, not a new version.

### 5.3 Upload path

- `MAX_UPLOAD_BYTES = 15 * 1024 * 1024` in `agent/corpus.ts` and
  `frontend/src/lib/server/upload-limit.ts`, kept equal, comment updated.
  knowledge-extractor's own `MAX_BYTES` is 50 MB, so the browser limit is the
  binding one.
- The frontend accept list adds `.pdf,application/pdf`; the sandbox keeps
  accepting any bytes (magic-byte sniffing is the parser's job, `415`
  otherwise) — the form filters, the pipeline verifies.
- The existing staged-bytes routes (`GET /raw`, `DELETE /ingest`) are
  unchanged; a PDF preview serves bytes, and the dashboard already declares
  the "not textual" case.

### 5.4 The read path: per-user roles, RLS on `session_user`, and the tool (D2)

Schema additions (a new hand-written SQL migration alongside 0001–0003 —
the generator cannot express roles and policies):

```sql
ALTER TABLE document
  ADD COLUMN entities  jsonb,     -- knowledge-extractor buckets, e.g.
                                   -- {"parties": ["Comune di Trento"], "dates": [...]}
  ADD COLUMN structure jsonb;     -- {page_count, has_tables, has_code, has_images}
CREATE INDEX document_entities_gin_idx ON document USING gin (entities);

CREATE ROLE agent_ro_group NOLOGIN;
GRANT CONNECT ON DATABASE pi TO agent_ro_group;
GRANT USAGE ON SCHEMA public TO agent_ro_group;
GRANT SELECT ON document TO agent_ro_group;
-- one login role per user is created by the manager at provision (§5.5):
--   CREATE ROLE "agent_ro_<userId>" LOGIN PASSWORD …
--     IN ROLE agent_ro_group NOSUPERUSER NOCREATEDB NOCREATEROLE
--     NOREPLICATION NOBYPASSRLS;

ALTER TABLE document ENABLE ROW LEVEL SECURITY;
ALTER TABLE document FORCE ROW LEVEL SECURITY;
CREATE POLICY document_own_rows ON document
  FOR SELECT TO agent_ro_group
  USING ("userId" = regexp_replace(session_user::text, '^agent_ro_', ''));

-- per login role, set by the manager at provision (role defaults are not
-- inherited from group roles at login):
--   ALTER ROLE "agent_ro_<uid>" SET statement_timeout = '2s';
--   ALTER ROLE "agent_ro_<uid>" SET default_transaction_read_only = on;
--   ALTER ROLE "agent_ro_<uid>" SET search_path = public;
--   ALTER ROLE "agent_ro_<uid>" CONNECTION LIMIT 4;
```

Properties, in order of importance:

1. **Identity is authentication, not session state.** The userId enters the
   system exactly once, as the login role name. `session_user` is fixed at
   authentication, `SET SESSION AUTHORIZATION` requires superuser, and no
   `SELECT` the model can write changes either. This replaces the first
   draft's `app.user_id` GUC: custom GUCs carry no privilege checks, so
   `SELECT set_config('app.user_id', …)` — a perfectly read-shaped statement —
   would re-key the policy, and the pooled connection would carry the forged
   value into the next query. A GUC is a channel the model can write; a role
   is not.
2. **Least privilege.** The group sees one table. No writes, no DDL, no other
   schemas, no auth tables, no `ingest_event`. A stolen per-user password
   reads exactly that user's rows — on any connection, tool or no tool — and
   each role is capped at `CONNECTION LIMIT 4`, so no single tenant can
   exhaust `max_connections`. `FORCE` keeps the policy honest even if
   ownership changes later; the web app connects as the cluster superuser
   (`pi`) and bypasses RLS, so dashboard behavior is unchanged.
3. **Server-side bounds, honestly stated.** `statement_timeout`, read-only
   transactions and `search_path` are per-role defaults the manager sets;
   they are friction, not walls (a session can `SET statement_timeout = 0`).
   The floor is the privilege system: grants, RLS on `session_user`, and the
   connection limit.
4. **Tool checks are UX.** `catalog_query` rejects input that is not a single
   statement starting with `SELECT` or `WITH`, or that contains `;`, with
   `not_a_read_query` — a fast, clear error. It is not the security boundary;
   the role is. A hostile statement that passes the check still dies at
   `permission denied`, zero rows, or the timeout.

Connection: `pg` (node-postgres), exact-pinned, one `Pool` with `max: 1`,
created lazily on first call from `CATALOG_URL` (the per-user DSN, §5.5).
The pool sets `connectionTimeoutMillis: 2000` and the DSN carries
`connect_timeout=2`, so an unreachable or blackholed catalog fails fast into
`catalog_unavailable` with a hint to fall back to `corpus_grep` over all
documents; the run is not aborted (G6). Idle clients time out; no connection
exists before the first tool call (R7).

### 5.5 Topology and secrets (manager changes)

Three `sandbox_manager.py` changes, all RFC 0003-shaped (guests, reconcile,
create-time env):

- `ensure_guests` additionally connects `OLTP_CONTAINER` (default `oltp`) and
  `KEX_CONTAINER` (default `knowledge-extractor`) to each per-user network.
  Without this, the per-user catalog DSN and the parser URL are unreachable
  from the sandbox. Today `ensure_guests` runs only in `provision()`: when compose
  recreates the manager it loses every per-user attachment and an existing
  sandbox stays unreachable until reprovisioned (the function's own
  docstring). Two new guests make that gap load-bearing, so the reconcile
  loop must also call `ensure_guests` for every registered user — one
  `docker network inspect` per user per tick, `docker network connect` only
  for what is missing.
- `create_args` passes, when configured:
  `-e CATALOG_URL=postgresql://agent_ro_<userId>:<password>@oltp:5432/pi?connect_timeout=2`
  `-e KEX_URL=http://knowledge-extractor:<port>` and the parser token.
  The manager owns the roles: `provision()` creates the role idempotently
  through its existing superuser `DATABASE_URL` (a `pg_roles` lookup, then
  `CREATE ROLE "agent_ro_<uid>" LOGIN PASSWORD … IN ROLE agent_ro_group
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, or
  `ALTER ROLE` to converge password, `statement_timeout = '2s'`,
  `default_transaction_read_only = on`, `search_path = public`,
  `CONNECTION LIMIT 4`). The password is
  `base64url(HMAC-SHA256(CATALOG_RO_SECRET, userId))`, unpadded: no password
  store to keep consistent, characters that never need DSN escaping, and
  rotating the secret plus `dev.sh reload` rotates every credential at once.
  Role settings are set per login role on purpose — Postgres does not inherit
  role defaults from group roles at login. The role name is always quoted
  (the uid charset makes quoting sufficient and preserves case), and the uid
  must match `^[A-Za-z0-9_-]{1,48}$` — 48, not 64: Postgres caps role names
  at 63 bytes and `agent_ro_` takes 9. Provisioning fails loudly otherwise
  (same stance as `safeDocId`).

Secrets: `CATALOG_RO_SECRET` (the HMAC key; handling frozen as I3, §5.9) and
`KEX_TOKEN` are manager env (compose defaults exist for local dev, like
`dev-manager-token`; documented in `.env.example`). Sandboxes receive only their derived per-user DSN and the
parser token, as env at `docker create`, so a change requires `dev.sh reload`
— the same rule as a provider switch. The `.env` stays untracked.

### 5.6 The `catalog_query` tool

One `defineTool` in `agent/` beside the RFC 0006 citation tools:

```json
// input
{ "sql": "SELECT id, title, filename, \"docDate\", \"textSha256\", chars\nFROM document\nWHERE ingestStatus = 'parsed'\n  AND entities @> '{\"parties\": [\"Comune di Trento\"]}'\nLIMIT 20" }

// output (JSON text, stable shape)
{ "columns": ["id", "title", "filename", "docDate", "textSha256", "chars"],
  "rows": [ ["doc_42", "Bando servizi 2026", "bando_42.pdf", "2026-02-10", "a1b2…", 48210] ],
  "rowCount": 1, "truncated": false, "elapsedMs": 12 }
```

Rules:

- Input is one read-only statement (`SELECT`/`WITH`), at most 4000 characters,
  no `;`. Output is capped: 50 rows, 4096 characters per cell, `truncated`
  flags both. Errors return `{ error, detail }` with the Postgres SQLSTATE:
  `42501` permission, `57014` timeout, `42P01` unknown table (schema drift),
  `catalog_unavailable` connection.
- The tool result carries a standing instruction: these rows name documents;
  to read them, call `corpus_grep`/`corpus_read` with the returned ids as
  `docIds`. The catalog has no text.
- In strict-citations runs the call is counted against `MAX_CORPUS_CALLS`
  (48) like every other corpus tool (R11); the free-hall surface is the same
  tool without the gate.
- The prompt section is short:

```
document is the catalog of this user's parsed documents: id, title, filename,
mimeType, size, chars, docDate, entities (jsonb: parties, dates, amounts,
codes, locations, …), structure (jsonb), sourceSha256, textSha256,
ingestStatus. It holds metadata only — never text.
Start every investigation with catalog_query: select the ids that match the
intent (entities @> '{"parties": ["…"]}', docDate ranges, title ILIKE), then
grep and read only those docIds. If the catalog is unavailable, fall back to
corpus_grep over all documents and say so.
```

A curated skill (shipped in the image, loaded by the agent) teaches the full
bucket vocabulary, the containment-vs-unnest patterns
(`jsonb_array_elements_text(entities->'parties') ILIKE '%trento%'` for partial
names), and the id/filename conventions. The schema knowledge lives in the
skill; the tool stays minimal.

### 5.7 Citation consistency

`WorkspaceCitationStore` changes so the narrowed set and the verified text
agree:

- Index a document from `corpus/docs/<docId>.md` when it exists; otherwise from
  `corpus/raw/<docId><ext>` only when the extension is textual (the same list
  the frontend accept list had before `.pdf` was added). Binary raw files —
  `.pdf`, `.docx`, `.bin` — are never decoded (R9). Same `docId` prefers the
  parsed markdown; the raw file stays for `/raw` and audit.
- The `docId` returned by `catalog_query` is the `docId` the citation tools
  accept: one id space from upload row to citation (I1).
- `textSha256` in the row and the workspace markdown are written by the same
  ingest sequence; the citation store keeps computing its own hash from the
  file it indexes, so a drifted row cannot fabricate a verification.

### 5.8 What the model never sees

Bucket credentials (there are none yet), per-user catalog passwords, other
users' rows, document text through the catalog, `ingest_event`, auth tables,
and any write path. The failure modes are named errors, not silent
fallthrough: unset scope, permission denied, timeout, unavailable.

### 5.9 Boundary guards: invariants I3–I6

D2 was reviewed against a live attack matrix before this section was
written: GUC forgery, `SET SESSION AUTHORIZATION`, `SET ROLE`, direct
`COPY … TO STDOUT`, aggregate and join leak attempts, a prefix-collision
uid, and wrong-password logins. Every vector reachable by the model, the
tool, or a stolen per-user password returned zero foreign rows — while the
same GUC forgery against a GUC-keyed policy returned all of the other
tenant's rows. Two conclusions are frozen here: the boundary is the login,
so it can and must be asserted continuously (I4); and the realistic breach
class is drift and misconfiguration, not a broken primitive (I5, I6). The
secret that mints every login is the one asset that breaks all tenants at
once (I3).

- **I3 — `CATALOG_RO_SECRET` is a crown jewel, not a service token.** The
  secret is equivalent to every tenant's read credential: whoever holds it
  can derive `agent_ro_<userId>` passwords for all users. Therefore no
  compose default on any path outside `dev.sh` (same stance as
  `dev-manager-token`); sandboxes never receive the secret, only their own
  derived DSN fixed at `docker create`; rotation is write-new-secret +
  `dev.sh reload`, which re-provisions every role password and recreates
  sandboxes; and one leaked DSN compromises exactly one tenant — HMAC-SHA256
  is one-way, so a single `(userId, tag)` pair reveals neither the key nor
  any other tenant's tag.
- **I4 — The boundary is asserted, not assumed.** A guard stage in the stack
  gate (`./verify.sh`, beside the R12 e2e section) fails the build when any
  of: the `document_own_rows` policy is missing or `FORCE ROW LEVEL
  SECURITY` is off on `document`; a cross-tenant `SELECT` as a second
  user's role returns a row; any `agent_ro_%` role has `rolsuper`,
  `rolbypassrls`, or `rolcreaterole` set; or a wrong password is accepted
  from a per-user network. The last check exists because the stock postgres
  image trusts loopback by default — during review a wrong-password login
  passed until `pg_hba` required scram. Silent misconfiguration, not
  cryptography, is the threat this stage kills.
- **I5 — Migrations touching `document` or its grants are
  security-sensitive.** A migration that recreates the table, adds a
  function over it, or widens `agent_ro_group` grants must, in the same
  change, extend the guard stage to re-assert the policy and the
  zero-foreign-rows property. Hand-written migrations are already the rule
  (§5.4); I5 makes their acceptance the guard, not the reviewer's eye.
- **I6 — The Postgres pin is a boundary decision.** The privilege system is
  the tenant boundary, so the image tag is managed like the manager's
  Docker CLI pin: a bump is a security review (release notes for
  privilege-system, RLS, or auth changes) plus a guard-stage rerun, not a
  chore.

Binding: I3, I5, and I6 apply from Phase B, when `CATALOG_RO_SECRET` and
the DDL first enter the system; the I4 guard stage lands in Phase C, the
same phase as the first sandbox-held credential, so no CI run ever
exercises an unasserted boundary. The guards add no component and change
no runtime behavior: they are checks on what §5.4 already builds. And D3
already bounds the worst case — the catalog holds metadata only, so even a
fully broken boundary leaks titles, dates and entities, never document
text.

## 6. Interaction with RFC 0005, RFC 0006, PRD 0001

- **RFC 0005**: this RFC is an early landing of its catalog plane (§5.2, G6:
  "the catalog scales without enumeration"). Bytes, versioning, records,
  sharing and the object store are untouched. When RFC 0005 lands: the
  `document` table gains storage keys and versions; `catalog_query` keeps
  working unchanged; `corpus_search` (0005 §6.1) either wraps this surface or
  is dropped in favor of it — decision deferred to RFC 0005 implementation,
  and 0005 §6.1 gets a note to that effect. The role/RLS design carries over.
- **RFC 0006**: no change to the citation contract. The alignment table in
  0006 §6 gains: "`corpus_metadata` idea of PRD 0001 §6.4 → realized as
  `catalog_query` over Postgres (RFC 0007); metadata-only, docIds out". The
  strict-run budget now counts `catalog_query`.
- **PRD 0001**: §4 upload limit 10 MB → 15 MB; §6.2 response carries
  `parsed{…}` metadata instead of `markdown`; §6.4 `corpus_metadata` is
  replaced by `catalog_query`. These edits land with the implementation, in
  the same change, not after.

## 7. Migration

Phase A — upload and guard (independent, ships first):

- 15 MB on both sides; `.pdf` accepted; binary exclusion in the citation
  store; tests for R8/R9. No parser, no catalog yet: PDFs stage as `raw_only`.

Phase B — parse:

- compose `knowledge-extractor` service; manager `KEX_*` env, guest attach;
  sandbox `/ingest` calls `/convert`, verifies `source_hash`, writes
  `corpus/docs`, returns `parsed{…}`; web app persists metadata; migration 0003
  adds `entities`/`structure`/GIN (the `agent_ro_group` + policy DDL ships
  here too, so the boundary exists before Phase C needs it); backfill job re-ingests `raw_only`
  documents with a filename on record; manager `CATALOG_RO_SECRET` env and
  per-user role provisioning — I3, I5, and I6 bind from this phase (§5.9).

Phase C — read:

- manager passes `CATALOG_URL` (needs `dev.sh reload`: sandbox env is fixed at
  create); `pg` dependency; `catalog_query` tool, prompt section, skill;
  strict-run budget integration; e2e per R12; guard stage in `./verify.sh`
  (R13/I4) and tests T13–T14 land in the same phase as the first
  sandbox-held credential.

Rollback: each phase is independent. Removing Phase C returns the agent to
grep-all; removing Phase B returns staging-only uploads; Phase A's limit raise
is harmless without the others.

## 8. Testing

| ID | Test |
|---|---|
| T1 | An agent role sees exactly its user's rows; a second user's sandbox gets zero rows for the same query. |
| T2 | Identity games are inert: `SELECT set_config('app.user_id','B',false)`, `SET app.user_id`, and `SET SESSION AUTHORIZATION` all fail or change nothing — zero rows of B either way. |
| T3 | `UPDATE`/`DELETE`/`INSERT`/`CREATE TABLE` as an agent role fail with `permission denied`; `SELECT` of data from any other table fails. |
| T4 | A query slower than 2 s aborts with SQLSTATE `57014`; the tool reports `query_timeout`. |
| T5 | Tool rejects `;`, `DELETE …`, empty input as `not_a_read_query` without opening a connection. |
| T6 | 60-row result truncates at 50 with `truncated: true`; a 10 KB cell truncates at 4096. |
| T7 | Fresh sandbox: `GET /health`, `GET /status`, then `pg_stat_activity` shows no `agent_ro_%` connections. |
| T8 | Unit: binary exclusion — a staged `.pdf` is absent from `documents()` until `corpus/docs/<docId>.md` appears. |
| T9 | Unit: ingest response mapping, `source_hash` mismatch leaves no file, idempotent replay, `409` on different hash. |
| T10 | Strict run: `catalog_query` calls counted; exhausting the budget rejects with `turn_budget_exhausted`. |
| T11 | Degraded: `CATALOG_URL` unset or oltp stopped → `catalog_unavailable`, the run still answers via full-corpus grep. |
| T12 | E2E through Caddy (`localhost:18080/u/<user>/…`): upload 15 MB PDF → parsed row with entities → prompt "in which documents is X a party" → trace shows `catalog_query` → grep only on returned docIds → citations verify. |
| T13 | Guard red matrix (R13): each injected failure — policy dropped, `FORCE` removed, `rolsuper` on an agent role, a trust `pg_hba` line, one visible foreign row — fails `./verify.sh`; the healthy stack passes. |
| T14 | Secret rotation (I3): change `CATALOG_RO_SECRET`, `dev.sh reload`; old derived DSNs are rejected with an auth failure, new DSNs still read only their own tenant. |

## 9. Alternatives considered

| Alternative | Why not |
|---|---|
| Agent parses PDFs itself with curated skills | Breaks D1's rationale: unstable evidence text, model-verified-by-model circularity, tokens burned on OCR, ingest pinned to conversation lifetime. |
| Structured filter tool (`search_documents(filters)`) instead of SQL | A fixed vocabulary must predict every query shape over evolving JSONB buckets; SQL is the native language of the index and the skill can teach it. Rejected for flexibility, with the role as the safety answer. |
| HTTP metadata-search endpoint on the control plane, sandbox calls it | Keeps Postgres off user networks, but adds a hop, a second query language to maintain, and a middleman that must re-implement RLS. Postgres auth + RLS is the purpose-built primitive. |
| Catalog in the sandbox (SQLite in workspace or `pi.corpus` doc per PRD §6.3) | Dies with the volume, not shared with the dashboard, no concurrent writer story, re-implements what `oltp` already provides. |
| One database per user | Isolation by construction, but N databases × migrations × backups; RLS on a shared table gives the same boundary at a fraction of the operational cost. Postgres RLS is the standard answer here. |
| Session GUC carrying the user (`app.user_id` via DSN) | First draft of this RFC. Custom GUCs have no privilege checks: `SELECT set_config(...)` re-keys the policy, the pooled connection carries the forged value into the next query, and a shared password plus a forgeable GUC breaks on direct connections too. Identity must be authentication, not session state. |
| Raise the limit to the parser's 50 MB now | No product need yet; 15 MB is the decided quota, and the smaller the limit the smaller the synchronous-parse tail. |

## 10. Risks and open questions

1. **Text-to-SQL quality.** The model may write wrong-but-legal SQL and narrow
   to the wrong subset. Mitigation: the skill's patterns, `LIMIT` discipline,
   and the fallback grep; the answer's correctness is still gated by
   citations, and a wrong subset surfaces as `no_evidence`, not as a false
   verified claim.
2. **`pg` in the sandbox image.** New exact-pinned dependency; `npm ci
   --ignore-scripts` per the dependency rules. One pooled connection inside a
   512 MB sandbox is a few MB — measured, not assumed.
3. **Shared parser instance.** One knowledge-extractor serves all users on
   their private networks; its semaphore (`429 busy`) maps to `503` retryable.
   Capacity sizing is deployment work, not a design change.
4. **Sync parse tail.** A 15 MB, ~90-page PDF can take minutes of OCR; the
   sandbox stays up for the ingest call (PRD already budgets 660 s). Async
   ingest is RFC 0005 phase 2; noted, not solved here.
5. **`entities` bucket drift.** Renamed or added buckets change what queries
   can find; the skill documents the buckets of the pinned labelset snapshot
   stored per document. A bucket rename is a catalog migration decision.
6. **GIN index bloat** on very large entity payloads. `cap`/`threshold` on the
   parser side already bound bucket sizes; monitor at 10^4 documents (R1).
7. **Backfill coverage.** Documents without a filename on record cannot be
   re-ingested (schema comment already says so); the dashboard must surface
   them as re-upload candidates, not silently skip them.
8. **15 MB quota enforcement point.** The form and the sandbox agree today;
   a third enforcer (control-plane quota per user) is deliberately out of
   scope until there is evidence of abuse.
9. **N login roles.** One role per user lives in the cluster (`pg_authid`),
   created and converged by the manager at provision. They are cheap rows;
   eviction may set them `NOLOGIN` (dropping is optional).

## 11. Decision requested

Approve:

1. knowledge-extractor as the external parser at ingest, bytes and parsed
   markdown in the workspace, metadata in `oltp` (D1, §5.2).
2. Raw SQL narrowing via `catalog_query`, backed by one login role per user
   (`agent_ro_<userId>`, member of `agent_ro_group`) with `SELECT` on
   `document` only, RLS keyed on `session_user`, per-role timeout, read-only
   transactions and connection limit (D2, §5.4).
3. The 15 MB / `.pdf` upload change and the citation-store binary guard
   (§5.3, §5.7).
4. The phase order A → B → C (§7), with PRD 0001 §4/§6.2/§6.4 edits landing in
   the same changes.
5. The boundary guards I3–I6 (§5.9) — crown-jewel handling of
   `CATALOG_RO_SECRET`, the `./verify.sh` guard stage (R13), migration
   sensitivity for `document`, Postgres pin discipline — landing with
   Phases B/C as specified, not as follow-ups.
