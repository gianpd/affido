# RFC 0009 — Skill marketplace, sandbox skills, and downloadable artifacts (md-to-docx end to end)

| Field | Value |
|---|---|
| Status | Implemented |
| Author | Affido maintainers |
| Date | 2026-10-23 |
| Target | `agent/` (image, tools, registry, model), `frontend/`, `marketplace/` (new), `e2e-test/` |
| Related | PRD 0003 (directory uploads), RFC 0004 (key exfiltration threat), RFC 0005 (workspace/corpus separation), RFC 0006 (strict citations), RFC 0008 (conversations), `agent/uploads.ts`, `agent/model.ts` |

## 1. Summary

A user asks the chat agent: "turn these notes into a branded Word document and
give me the file." Today that request dies four times, at four different
layers:

1. **No knowledge distribution.** The platform has no way to ship a curated,
   tested procedure (a skill) to a user's sandbox. The agent has never heard of
   a markdown → styled docx pipeline.
2. **No runtime capability.** The `md-to-docx` skill generates through the
   `docx` npm package, which is not in the image — and the only in-box
   alternative, `npm install` at runtime, is exactly what the platform must
   not allow.
3. **No invocation convention.** Even with the skill on disk, nothing maps the
   user's "/md-to-docx make a proposal" to "the model reads that skill first".
4. **No return path.** Every response the agent sends is JSON built by
   `json()` in `http.ts`; `GET /file` reads text (`readTextFile`); the chat
   route streams text. A `.docx` (a zip) has no path from the workspace volume
   to the user's browser.

This RFC closes the four gaps with a strict separation of planes:

- **Knowledge ships from a marketplace; the user installs it** (D1/D2). The
  platform curates and tests a skill catalog in the repo
  (`marketplace/skills/<name>/`, manifest + files). A dedicated dashboard page
  lists it; selecting a skill streams its files into the user's sandbox
  workspace at `WORKSPACE/skills/<name>/` through new non-activating agent
  endpoints. Installed skills live on the per-user volume, so they survive
  pause, stop, eviction, and reprovision; only `dev.sh reset` removes them.
- **Capability is baked, minimal, and closed** (D3). The image gains exactly
  one runtime library — `docx`, exact-pinned — reachable from any working
  directory via `NODE_PATH`. The agent cannot extend its own toolbox:
  `npm`/`npx`/`corepack` are deleted from the runtime image, so "hide npm
  install" is enforced by the filesystem, not by prompt text. No Python, no
  Pillow, no LibreOffice.
- **`/skill_name` is a server-built invocation hint** (D4). The prompt tool
  resolves a leading `/name` against the installed skills and appends a note
  to the submitted content telling the model to read that `SKILL.md` — durable
  in the conversation, visible in the trace, never model-invented.
- **Artifacts are a first-class workspace root** (D5/D6). The agent writes
  deliverables under `WORKSPACE/artifacts/`; `GET /artifacts` lists the tree,
  `GET /artifact?path=` streams one file as a download, `DELETE /artifacts`
  removes it — all plain filesystem work that never activates the agent,
  exactly like `/uploads`. The `/prompt` envelope gains a server-built
  `artifacts` field listing what the run created or changed, so the download
  link never depends on the model typing a path.
- **The frontend renders it** (D7): the marketplace page, chat download
  buttons through a streaming proxy, and an artifacts panel — all in both
  sandbox access modes.

No manager, compose, or database change. No new environment variable. Every
addition is per-sandbox and non-activating, so the 10k-user scale story of
RFC 0003 is untouched.

## 2. Problem

### 2.1 Current trace

```
user (chat):    "/md-to-docx convert these notes into a branded proposal"
  -> POST /api/chat -> Caddy /u/<id>/prompt (free mode)
  -> agent: model has read/write/edit/bash, no skill on disk, no marketplace,
     no convention for "/md-to-docx", no docx library
     best case: the model improvises a docx by hand-writing zip XML (fails or
     produces garbage), or answers with instructions for the user
  -> answer: text only; nothing downloadable exists on any path
```

Each gap is independent: closing any subset still leaves the user without a
file, or leaves the platform dependent on runtime package installs.

### 2.2 Why "let the agent npm install" is not the answer

The host skill's own prerequisites say `npm install docx` (plus optionally
Pillow and LibreOffice). Inside a per-user sandbox that means:

- **Least privilege is gone.** The agent's toolbox becomes "the public npm
  registry", decided at runtime by whoever wrote the prompt or the skill text.
  The platform position is the inverse: the agent can only use what the
  platform makes available, decided at image build time under review.
- **Supply chain.** Runtime install executes lifecycle scripts from the public
  registry inside a container that holds the user's whole workspace and
  session. A pinned, reviewed `package-lock.json` built into the image is the
  only shape consistent with how this repo already treats dependencies.
- **Scale.** Every one of N users pays an install (network + disk on the
  workspace volume, npm cache growth, cold-start latency) for the same package.
- **Egress.** Per-user bridge networks NAT out today because the model API
  needs it. A runtime-install-dependent skill pins that door open forever.
  Baked tooling keeps "restrict sandbox egress to the model API" available as a
  future hardening step (§12).
- **Image size.** LibreOffice is ~400 MB of attack surface for an optional
  validation step. The container skill variant validates structurally in Node
  instead (§5.9).

### 2.3 What this RFC does not change

- The corpus model of RFC 0005/0006: `corpus/` stays the only citable root;
  `skills/`, `uploads/`, and `artifacts/` are workspace material and are never
  citable.
- The strict-citations gate of RFC 0006: generation uses `bash`/`write`, which
  stay installed in strict runs; the *answer* of a strict run still exists only
  through `answer_publish`. Artifacts and hints are orthogonal to evidence.
- The conversation model of RFC 0008 and the durability invariants (idle pause,
  idempotent `/prompt`, `workspacePath` confinement, `HttpTool` routing).
- The manager and compose topology. Nothing in `create_args()` moves.

## 3. Goals and non-goals

### 3.1 Goals

- **Marketplace (retrieval, platform side).** The platform curates and tests a
  skill catalog; a dashboard page lists it with installed state; one action
  installs (or removes) a skill into the user's sandbox. Install survives
  sandbox lifecycle (volume-backed).
- **Invocation.** A prompt starting `/skill_name …` makes the model receive a
  server-built hint to read that skill's `SKILL.md` from its workspace; an
  unknown `/name` produces an honest "not installed" note, not silence.
- **Discovery without invocation.** The skills prompt section still lists what
  is installed, so plain-language requests ("make me a Word document") match
  skills too.
- **Least privilege.** `require("docx")` works in any Node script the agent
  runs from the workspace; `npm`/`npx`/`corepack` do not exist in the runtime
  image; nothing installs anything at runtime.
- **Return path.** A user with a valid session can download any file under
  their sandbox's `artifacts/` root; no path outside that root is served; the
  response is always an attachment with a static content type.
- **Run attribution.** The `/prompt` response reports the artifacts the run
  created or changed, with size and (below the cap) sha256.
- **Pause safety.** Skill listing, install, and every artifacts endpoint work
  without opening storage; a probe cannot defeat the idle pause.
- **Idempotency preserved.** Replaying the same `requestId` returns the
  admitted submission; nothing runs twice.
- **Caps everywhere.** One install file ≤ 10 MiB (the uploads bound); one
  download ≤ 25 MiB; tree responses ≤ 1000 entries; the skills section ≤ 20
  skills per root, description ≤ 200 chars.
- The whole feature works with the keyless faux provider, in both frontend
  sandbox access modes.

### 3.2 Non-goals

- **Third-party skill submission.** The catalog is platform-curated; there is
  no publish flow, no review queue, no payments. External skill authors are
  future work (§12).
- **Skill versioning machinery.** Install is idempotent-by-path overwrite
  (the PRD 0003 position); "update available" badges and pinning are future
  work. A catalog entry can declare `minAgentImage` so an old sandbox says
  "update the agent" instead of half-working.
- Making skills citable, or merging them into the corpus.
- Binary format conversion beyond what a marketplace skill performs (no PDF,
  no xlsx in v1; the content-type map is data, so new formats are additive).
- Streaming/range downloads. Artifacts are capped at 25 MiB; a full read is
  bounded and simple.
- Per-workspace disk quota enforcement (open question, §12).
- Editing existing `.docx` files (the skill itself excludes this).
- Chat composer autocomplete for `/` (nice-to-have; noted in §5.8, not
  required for v1).

## 4. Requirements

- **R1 — Catalog.** The marketplace catalog lives in the repo, one directory
  per skill (`SKILL.md`, `references/`, `marketplace.json` with name, version,
  description, file list with sha256, and required runtime libraries). The
  catalog page renders from this bundle; no database rows.
- **R2 — Install.** A signed-in user installs a catalog skill into their own
  sandbox with one action; the files land at `WORKSPACE/skills/<name>/`
  exactly as bundled; reinstall overwrites idempotently; uninstall removes the
  subtree.
- **R3 — Discovery.** The model is told, in a server-built prompt section,
  which skills are installed (name, one-line description, absolute path of
  `SKILL.md`, provenance) and that user-facing files must be written under
  `artifacts/`.
- **R4 — Invocation.** `/skill_name` at the start of a prompt resolves against
  installed skills; the model receives a hint naming the `SKILL.md` to read.
  Unresolved names yield a note listing what is installed.
- **R5 — Closed toolbox.** `require("docx")` succeeds in any Node script the
  agent runs from the workspace, with no network; `npm`, `npx`, and `corepack`
  are absent from the image; a skill manifest's required libraries must exist
  in the image (e2e-enforced).
- **R6 — Return path.** Any file under `artifacts/` is downloadable by its
  owner; nothing else is; the response is always an attachment with a static
  content type.
- **R7 — Run attribution.** The `/prompt` response reports the artifacts the
  run created or changed, with size and (below the cap) sha256.
- **R8 — Pause safety.** Install, listing, and download never open storage.
- **R9 — Idempotency preserved.** Same `requestId` → same admitted submission;
  the artifact list is re-derived, never re-run.
- **R10 — Verified bundles.** Given a manifest, the sandbox can re-verify the
  installed files against the bundled sha256 list on demand.

## 5. Design

### 5.1 The four planes after this RFC

```
 knowledge (marketplace)      invocation                 production            return
 ----------------------      ----------                 ----------            ------
repo: marketplace/skills/    "/md-to-docx do X"          bash/write:           GET /artifact?path=...
  -> dashboard /skills page    -> PromptTool resolves     node generate_x.js    GET /artifacts (tree)
  -> POST /skills/file          skills/md-to-docx         -> WORKSPACE/         DELETE /artifacts
     (per file, idempotent)       -> server hint note       artifacts/x.docx   /api/artifact proxy
skills/<name>/SKILL.md          appended to content      /prompt envelope:     (chat UI button)
uploads/<skill>/SKILL.md      skills prompt section      artifacts[] (diff)    dashboard panel
```

Two provenances of skills, both on the per-user volume:

| Root | Provenance | Trust |
|---|---|---|
| `WORKSPACE/skills/<name>/` | marketplace install (R2) | platform: curated, bundled, tested in the repo |
| `WORKSPACE/uploads/<name>/SKILL.md` | user-shared tree (PRD 0003) | user content, same trust as the user's own prompt |

The image ships **no skills** — only runtime capability. Knowledge is
marketplace content; capability is image content; the two never mix. A skill
that needs a library the image lacks is a catalog problem (its manifest
declares the requirement, the e2e fails, it does not ship), never a
runtime-install problem.

### 5.2 D1 — The marketplace catalog

Repo layout:

```
marketplace/
  README.md                     catalog conventions, review checklist
  skills/
    md-to-docx/
      marketplace.json          manifest (below)
      SKILL.md                  container-adapted skill (§5.9)
      references/
        generator-template.js
        brand-palettes.md
```

`marketplace.json`:

```json
{
  "name": "md-to-docx",
  "version": "1.0.0",
  "description": "Convert markdown notes into a branded .docx proposal.",
  "requires": { "nodeLibraries": ["docx"] },
  "files": [
    { "path": "SKILL.md", "sha256": "…" },
    { "path": "references/generator-template.js", "sha256": "…" },
    { "path": "references/brand-palettes.md", "sha256": "…" }
  ]
}
```

- The manifest is generated by a small checked-in script
  (`marketplace/manifest.mjs`) that hashes the bundle; the review gate is the
  normal code review of the directory. `requires.nodeLibraries` names image
  libraries, not npm ranges — the mapping to reality is asserted by the e2e
  (§9), which is what makes the catalog "tested": installing the *shipped*
  bundle and driving it end to end is part of `verify.sh`.
- The frontend reads the bundle at build time (static import of the JSON +
  file manifest; the actual bytes are served by an endpoint that streams the
  bundled files). No DB table, no manager involvement: the catalog is static
  content owned by the web app, the same way the landing page is.

### 5.3 D2 — Install contract (agent side)

New endpoints, all plain `fs`, none activating (R8), mirroring the uploads
contract of PRD 0003:

| Method | Path | Effect |
|---|---|---|
| POST | `/skills/file?skill=<name>&path=<rel>` | raw body → `WORKSPACE/skills/<name>/<rel>`; creates parents; idempotent overwrite |
| GET | `/skills` | installed skills: name, provenance, description (frontmatter), version, verified state if last checked |
| POST | `/skills/verify?skill=<name>` + manifest body | recompute sha256 of the installed files vs the manifest; per-file ok/mismatch/missing |
| DELETE | `/skills?skill=<name>` | remove the skill subtree; missing is not an error |

Rules:

- `skill` matches `/^[a-z0-9][a-z0-9-]{0,63}$/` (slash-safe, collision-free
  with the path segments); `path` is validated by the same tree validator as
  uploads (`safeUploadPath`, reused for both roots; the RFC renames it
  `safeTreePath` — a mechanical rename) and confined by `workspacePath` as the
  second barrier.
- Per-file bound `MAX_UPLOAD_BYTES` (10 MiB, the PRD 0001/0003 value): a skill
  is text and small references; 10 MiB per file is generous.
- Idempotent by path, no rollback, retry rewrites — the PRD 0003 position,
  verbatim. `marketplace.json` is installed like any other file, so `GET
  /skills` can report the version and `verify` has something local to compare
  against; a partial install is visible as a missing-file mismatch.
- The install loop runs in the frontend (control plane), like the directory
  upload loop of PRD 0003: for each manifest file, stream bytes to
  `/skills/file`; then call `/skills/verify` with the manifest; a mismatch
  surfaces in the UI (retry rewrites the same paths).

### 5.4 D3 — Least-privilege runtime: one library, no installer

- `agent/package.json` gains `"docx": "<exact version>"` (the pin is chosen at
  implementation; the policy is the repo's: direct dependencies exact). It is
  a runtime dependency of the image, not of `server.ts` — nothing in the agent
  source imports it. `npm ci --omit=dev --ignore-scripts` installs it into
  `/app/node_modules` as today.
- `Dockerfile` adds `ENV NODE_PATH=/app/node_modules`. Node's CJS resolution
  honors `NODE_PATH` after walking up from the script directory, so
  `node generate_x.js` anywhere in `WORKSPACE` resolves `require("docx")`
  without a local `node_modules` and without egress.
- **The installer is removed from the runtime image**: after `npm ci`, the
  Dockerfile deletes `npm`, `npx`, and `corepack` (`/usr/local/bin/npm`,
  `npx`, `corepack` and their backing `node_modules` under
  `/usr/local/lib/node_modules` except the runtime `docx` tree under
  `/app/node_modules`, which is untouched). Node itself stays — generation
  scripts are the point. This is the enforcement behind "the agent can only
  use what we make available": a prompt-injected `npm install` fails with
  `command not found`, not with a policy sentence the model can argue with.
  (Recovery is always one `dev.sh reload` away: the image is the deploy unit.)
- Not added: python3, Pillow, LibreOffice. The container skill variant (§5.9)
  works without them; validation is structural in Node.

### 5.5 D4 — `/skill_name` invocation: a server-built hint

In `ContainerAgent.prompt`, before building the submission draft:

1. Match `^/([a-z0-9][a-z0-9-]{0,63})(?:\s+|$)` on the trimmed prompt.
2. If it matches, look for `WORKSPACE/skills/<name>/SKILL.md` (one `stat`;
   also accept `uploads/<name>/SKILL.md` so user-shared trees are invocable
   the same way).
3. Build the note and append it to the submitted content:

```
[skill hint] The user invoked the skill "md-to-docx".
Read /workspace/skills/md-to-docx/SKILL.md with the read tool first and
follow it for this task.
```

   For an unresolved name:

```
[skill hint] The user invoked the skill "foo", which is not installed.
Installed skills: md-to-docx (/workspace/skills/md-to-docx/SKILL.md).
Answer in plain text without pretending to use it.
```

4. The `/name` token is stripped from the content when the skill resolves,
   kept verbatim when it does not (the model sees what the user saw).

Properties:

- The hint is part of the stored `pi.user` content (`SubmissionDraft.content`
  is a plain string): durable across pause/restart, visible in `/entry` and
  the trace page, and auditable. No new conversation state, no schema.
- Server-built (R4): the model never fabricates a skill path, and the not-
  installed case cannot be talked around — the note names reality.
- Idempotent by construction: the note is written at admission; replaying the
  same `requestId` returns the admitted submission unchanged.
- Works identically in strict-citations runs: the hint precedes the gated
  answer, and generation still goes through `bash`/`write`.
- The match is a deliberate prefix convention, not a general command parser:
  `/name` elsewhere in the text is untouched.

### 5.6 D5 — The artifacts root and its HTTP contract

`WORKSPACE/artifacts/` is the download surface, symmetric with `uploads/`
(PRD 0003) and deliberately narrow:

| Method | Path | Activates | Effect |
|---|---|---|---|
| GET | `/artifacts?path=` | no | recursive tree of the root or a subtree (`UploadTree` shape, `MAX_TREE_ENTRIES` cap) |
| GET | `/artifact?path=proposal.docx` | no | the file bytes as a download (see below) |
| DELETE | `/artifacts?path=proj` | no | remove a file or subtree; missing path is not an error |

All three are plain `fs` work through `safeTreePath` + `workspacePath`. None
activates the agent, like `/uploads`: a download cannot wake a paused Harness.

`GET /artifact` response rules:

- Confined: relative path, `safeTreePath`, then `workspacePath`; anything else
  is 400. Missing file 404. A directory 400.
- **No symlinks:** every path component is checked with `lstat`; a symlink
  anywhere under `artifacts/` is 404 for the download and skipped by the tree
  walk. Without this, `bash: ln -s /run/secrets/openrouter_api_key
  artifacts/leak` turns the download endpoint into a secrets exfiltration
  path (see §10).
- Capped: `MAX_ARTIFACT_BYTES = 25 MiB` → 413 past it. The file is read into
  one bounded buffer and written with `Content-Length`.
- Typed by a **static extension map** (`docx`, `pdf`, `png`, `jpg`, `gif`,
  `webp`, `csv`, `txt`, `md`, `json`, `zip`); unknown extensions and `svg` are
  `application/octet-stream`. No sniffing, no inline serving:
  `Content-Disposition: attachment; filename="<basename>"` always. The browser
  never renders the body inline, so a mislabeled or hostile content type
  cannot execute in the app's origin. The basename comes from a path the
  validator already restricted (no control characters, no `"`, no `\`), so
  header splitting is not possible.

Server plumbing: `handle()` of an `HttpTool` may return a `RawResponse`
(`{ status, headers, body: Buffer }`, one class in `http.ts`); `server.ts`
writes it verbatim, everything else keeps going through `json()`. This is the
first non-JSON response in the agent, so it is one explicit, tested shape
rather than a general response abstraction.

### 5.7 D6 — The `/prompt` envelope gains `artifacts`

Inside `ContainerAgent.prompt`'s `activate()` block:

1. Before `conversation.submit`: `snapshotArtifacts()` walks `artifacts/`
   (bounded by `MAX_TREE_ENTRIES`) → `Map<path, { size, mtimeMs }>`.
2. After the submission settles: walk again and diff. Created, resized, or
   mtime-changed files are the run's artifacts.
3. The response carries, per file: `path` (relative to `artifacts/`), `bytes`,
   `modifiedAt`, and `sha256` (computed now, only when `bytes ≤
   MAX_ARTIFACT_BYTES`; larger files report `sha256: null`).

```json
"artifacts": [
  { "path": "proposal.docx", "bytes": 48213,
    "sha256": "9f2c…", "modifiedAt": "2026-10-23T09:41:02.483Z" }
]
```

The diff is a pure function over two snapshots (`diffArtifacts(before,
after)`) and unit-tested without a Harness. The envelope fields are
server-built, like `evidence` and `citations`: the model never types a
download path, and a model that forgets to mention the file still gets a
download button in the UI.

Properties:

- **Idempotent replay (R9):** the list is derived from disk at response time;
  what is stored is only the admission-time baseline snapshot (in the run state
  document, alongside the RFC 0006 run fields — never with the submission, and
  never the list itself). Replaying the same `requestId` returns the admitted
  answer with the artifact list re-derived against that baseline; if the user
  deleted the file meanwhile, the list shrinks. Documented, deterministic.
- **Strict runs:** unchanged semantics — evidence governs the text, artifacts
  report production.
- **Cost:** two bounded walks per prompt; zero when `artifacts/` does not
  exist (the common case until a document is requested).

### 5.8 D7 — Frontend

- **Marketplace page** (`/dashboard/skills`): catalog cards from the bundled
  manifests (name, version, description, required libraries); installed state
  and version from the sandbox `GET /skills`; Install streams every manifest
  file through `/skills/file` then `/skills/verify`, showing per-file
  progress and the verification verdict; Uninstall calls `DELETE /skills`.
  Visiting the page can cold-provision the sandbox, exactly like the uploads
  page today (PRD 0003 §7).
- `sandbox.ts` gains `installSandboxSkill`, `listSandboxSkills`,
  `verifySandboxSkill`, `deleteSandboxSkill`, `downloadSandboxArtifact`,
  `listSandboxArtifacts`, `deleteSandboxArtifacts`. The download is the one
  non-JSON sandbox call: it must return `Response` (the existing
  `sandboxFetch` JSON-parses; the new function shares `sandboxUrl` and the
  error mapping but keeps the body as a stream). Both access modes (Caddy
  gateway, trusted manager `/resolve`) work because both are plain HTTP to the
  same agent paths.
- **Download proxy** `GET /api/artifact?path=` (SvelteKit `+server.ts`):
  session-gated like `/api/chat`, validates that `path` is non-empty and
  length-bounded before forwarding (defense in depth; the sandbox
  re-validates), streams the sandbox response body through without buffering,
  and passes through `content-type`/`content-length`/`content-disposition`.
- **Chat:** the assistant message gains a `data-artifacts` part (mirroring
  `data-citations`), persisted in `chat_message.parts` and streamed by the
  chat route; the UI renders one download button per artifact (`path` +
  human size). No migration: `parts` is already a JSON column. Optional v1.1:
  the composer offers `/` completions from `GET /skills`.
- **Artifacts panel** on the uploads dashboard page (tree from
  `GET /artifacts`, download links through the proxy, delete with the same
  confirm dialog the uploads tree uses).

### 5.9 D8 — md-to-docx as the first marketplace skill, and the faux dance

`marketplace/skills/md-to-docx/` is the first catalog entry (source: the host
skill at `~/.pi/agent/skills/md-to-docx`; the repo owns its copy — there is no
runtime sync), adapted to the container:

- Prerequisites section replaced: `docx` is preinstalled (`NODE_PATH`); there
  is no `npm install` (and no npm); no Pillow, no LibreOffice. Logo palette
  extraction, when the user supplies a logo, uses a bounded pure-JS snippet
  (or falls back to asking for hex codes / a named preset, which the skill
  already supports); extraction is a nicety, not a dependency.
- Output location: `artifacts/<name>.docx` (relative to the workspace), per
  the section rules; generation scripts are written in the workspace root
  (`generate_<name>.js`) and are re-runnable.
- Validation phase, in Node, structural only: the produced buffer starts with
  the zip signature and contains the required part names
  (`[Content_Types].xml`, `word/document.xml`) — a signature scan, no
  decompression, no dependencies. Word remains the final arbiter on the
  user's machine; the check exists to catch a broken generation script before
  the run claims success.
- `references/` ships unchanged in structure (the template already uses
  `require("docx")`).

`model.ts`'s `scripted` factory gains one branch so the e2e and the demo need
no key: a user message containing the `[skill hint]` note for `md-to-docx`
emits a `bash` call that runs a one-liner Node script building a small real
`.docx` through the baked package into `artifacts/`; after the bash result it
answers with a short confirmation. This exercises the full chain — install,
hint resolution, image dependency, `NODE_PATH`, the artifacts convention, the
envelope diff — under the deterministic provider. The existing citation dance
and fallbacks are untouched.

## 6. Interaction with existing decisions

- **PRD 0003 (uploads).** The install contract is the uploads contract applied
  to a second root (`skills/`): client-dictated paths, idempotent overwrite,
  no rollback, no DB rows, non-activating endpoints. `safeUploadPath` becomes
  `safeTreePath`, shared; its bounds are unchanged.
- **RFC 0005 (workspace/corpus separation).** `skills/` and `artifacts/` are
  workspace material like `uploads/`: not citable, no corpus rows, no
  control-plane metadata beyond `chat_message.parts`. The citation store never
  scans them.
- **RFC 0006 (strict citations).** The `artifacts` envelope field and the
  skill hint are orthogonal to `evidence`/`citations`; a strict run may
  produce a gated answer and an artifact. The gate does not inspect files.
- **RFC 0008 (conversations).** The hint lives in stored message content; the
  envelope field is per-response. No conversation-scoped state is added.
- **RFC 0004 (keys).** The no-symlink rule of §5.6 closes the direct
  `artifacts -> /run/secrets` exfiltration this endpoint would otherwise add.
  The general "the agent process can read what it is mounted" problem is
  RFC 0004's and is unchanged here.
- **PRD 0001 upload cap.** `MAX_UPLOAD_BYTES` (10 MiB) governs uploads and
  skill files; `MAX_ARTIFACT_BYTES` (25 MiB) governs downloads. Both are
  sandbox-internal constants in code, not environment settings; env would
  require a manager `create_args` change, which this RFC explicitly avoids.

## 7. Skill lifecycle

```
catalog (repo bundle)          user's sandbox (volume)              prompt time
---------------------         ------------------------             -----------
/dashboard/skills       install  WORKSPACE/skills/md-to-docx/   "/md-to-docx …"
  card: v1.0.0, docx   -------->   SKILL.md, references/,    ----> hint note appended
  [Install] [Verify]   <verify--   marketplace.json                 + skills section
  [Uninstall]          <delete--  (survives pause/stop/evict/      -> model reads
                                  reprovision; reset wipes)           SKILL.md
```

- Fresh sandbox for an existing user: the workspace volume already contains
  `skills/`; nothing reinstalls. First-ever provision: the user installs from
  the page (or the chat hint's not-installed note points them there).
- Catalog update: same name, new version → Install overwrites the same paths
  (idempotent-by-path); `GET /skills` then reports the new version. No
  version pinning per user in v1 (§12).
- The marketplace bundle never executes anywhere: it is data read by the
  frontend and written verbatim into the sandbox. The only interpreter is the
  model deciding to follow `SKILL.md`.

## 8. Trust model

| Content | Author | Reviewed how | Executes where |
|---|---|---|---|
| Image + `docx` library | platform | code review, lockfile, `verify.sh` | Node, in every sandbox |
| Marketplace skill files | platform | catalog review + e2e that drives the shipped bundle | the model *reads* them; scripts it writes run with baked libs only |
| `uploads/` trees | user | not reviewed (single-tenant trust) | same as above |
| `/prompt` text | user | not reviewed | same |

The one boundary that matters: nothing reachable from inside the sandbox can
change the first row. Skill files — platform or user — can instruct, but the
toolbox (`docx`, Node, bash, the HTTP tools) is fixed at image build, and the
installer does not exist to extend it.

## 9. Testing

- **Unit (`agent/skills.test.ts`, `agent/artifacts.test.ts`):** skill-name
  validation; install writes and overwrite idempotency; `GET /skills`
  frontmatter parsing (bounded, missing-description disqualified); verify
  against a manifest (ok/mismatch/missing); `safeTreePath` reuse; tree walk
  (cap, truncation, symlink skip); `snapshotArtifacts` + `diffArtifacts`
  (create/change/delete/no-root); content-type map and disposition building;
  `RawResponse` writing; hint builder (resolve/strip, not-installed note,
  non-prefix `/` untouched).
- **Agent test (`agent.test.ts` extension):** fake-lifecycle prompt whose
  script writes a file into sandbox `artifacts/` between snapshot and settle
  reports it in the envelope; replay of the same `requestId` returns the same
  list; `sha256: null` above the cap; a `/name` prompt carries the hint in
  the stored content.
- **E2E (`e2e-test/skills.sh`, `e2e-test/artifacts.sh`, registered in
  `run.sh`):** through Caddy only —
  1. `skills.sh`: install the **shipped catalog bundle** (the real
     `marketplace/skills/md-to-docx` files, hashed by `manifest.mjs`) file by
     file through `/skills/file`; `GET /skills` lists it; `/skills/verify`
     reports all-ok; corrupt one file (reinstall a wrong byte) → verify
     reports mismatch; a traversal `?skill=../x` and `?path=../…` are 400;
     uninstall removes the subtree.
  2. `artifacts.sh`: `POST /prompt` "/md-to-docx make a proposal" drives the
     faux documents dance; the envelope lists `artifacts/…docx` with bytes
     and sha256; the download goes through the Caddy gateway path
     (`/u/<id>/artifact?path=…` — the exact endpoint `/api/artifact` proxies
     after the session check; the SvelteKit app is not part of the e2e stack)
     and its sha256 matches with a zip signature at the head; `GET /artifacts` lists the
     tree; `DELETE` removes it; confinement (`../data/session.sqlite` → 400);
     a symlink planted via the scripted dance is not downloadable (404) and
     not listed; replaying the same `requestId` answers the admitted
     submission (no second run).
  3. The documents dance asserts the hint: an unknown `/nope` prompt receives the
     not-installed note and answers without pretending.
- **Image gate:** `verify.sh` asserts `docker run --rm <image> npm --version`
  fails (installer absent) and `node -e "require('docx')"` succeeds with
  `NODE_PATH` set and the network namespace of the test removed.
- **Gates:** `cd agent && npm run typecheck && npm test`; `cd frontend &&
  pnpm check && pnpm test:unit -- --run`; `./verify.sh` (the RFC crosses the
  agent/Caddy/frontend boundary). Docs: README HTTP API table gains the seven
  rows with their Activates column; PRD 0003's uploads page section mentions
  the artifacts panel; `marketplace/README.md` documents the review checklist.

## 10. Security analysis

| Threat | Path | Mitigation |
|---|---|---|
| Runtime toolbox extension | model or injected instruction runs `npm install` | `npm`/`npx`/`corepack` deleted from the image; the command does not exist; nothing else in the image fetches packages |
| Malicious catalog content | marketplace bundle carries hostile `SKILL.md` | catalog is repo content under review; the e2e drives the shipped bundle; skill files are read as text by the model, never executed by the platform |
| Path traversal in install/download | `?skill=../x`, `?path=../../data/session.sqlite` | name pattern + `safeTreePath` (relative, no `..`, bounded) + `workspacePath` second barrier; 400 |
| Symlink exfiltration | agent runs `ln -s /run/secrets/... artifacts/x` | `lstat` per component: symlink → 404/skip (direct secret reads by the agent process are the RFC 0004 problem, unchanged) |
| Partial/corrupted install | install loop dies mid-way | idempotent-by-path retry rewrites; `/skills/verify` vs manifest makes the state visible instead of guessed |
| Header injection | crafted filename in `Content-Disposition` | filename is the basename of a validated path (no `"`, no control chars, no `\`); no CRLF possible |
| Content-type confusion / stored XSS | hostile file rendered inline in the app origin | always `attachment`, static extension map, no sniffing, `svg` forced to octet-stream |
| Oversized response / memory | huge "docx" from a broken script | `MAX_ARTIFACT_BYTES` 413 at the agent, `Content-Length` always set; proxy streams without buffering |
| Supply chain (image) | `docx` dependency | exact pin, lockfile reviewed, `--ignore-scripts` install, deleted installers leave no second path |
| Probe defeating idle pause | monitoring hits skill/artifact endpoints | install, verify, listing, download never activate the agent (R8) |
| Workspace filling up | agent writes unbounded files | per-file/per-tree caps bound the *serving* path; total volume usage stays unbounded (§12), same as today for `uploads/` |
| Prompt injection via skill files | uploaded or installed `SKILL.md` instructions | installed skills are platform-reviewed; uploaded skills are user-trusted in a single-tenant sandbox (same trust as the prompt); the hint and the artifacts rules are server text, not skill text |

The chat proxy and the install loop add no new authority: both authenticate
the session and forward bounded requests to the user's own sandbox.

## 11. Scale analysis

- **No control-plane component grows.** No manager change, no compose change,
  no migration, no new env — provisioning cost, cold start, and the eviction
  loops are exactly those of RFC 0003 today.
- **Catalog distribution is static content.** The bundle ships with the web
  app; N users installing cost N × (a few small file writes into their own
  sandbox), the same shape as the PRD 0003 upload loop. No central service,
  no store to saturate.
- **Per-prompt overhead:** one bounded skills scan (≤ 2 `readdir` + ≤ 40
  short reads), one `stat` when a `/name` prefix is present, and two bounded
  artifact walks (0 when the root is absent). Local filesystem; microseconds.
- **Memory:** one ≤ 25 MiB transient buffer per in-flight download, per
  sandbox; the proxy never buffers.
- **Image:** `+docx` (~3 MB), `−npm −npx −corepack` (a net reduction); every
  sandbox shares the same immutable layers.
- **10k users:** each sandbox is independent; downloads are per-sandbox
  streams through Caddy, which already proxies every other response.

## 12. Rollout

One implementation slice, no migration:

1. `agent/`: `skills.ts` + `artifacts.ts` (+ tests), hint builder in
   `agent.ts`, `RawResponse` in `http.ts`, seven `HttpTool`s (skills ×4,
   artifacts ×3), envelope diff, skills section in `createAgentRegistry`,
   `docx` pin + `Dockerfile` (`NODE_PATH`, installer removal), faux documents
   dance in `model.ts`.
2. `marketplace/`: bundle `md-to-docx` (adapted SKILL.md, references,
   manifest) + `manifest.mjs` + `README.md`.
3. `frontend/`: catalog page, install/verify/uninstall calls, sandbox
   download/tree/delete calls, `/api/artifact` proxy, chat `data-artifacts`
   part + buttons, artifacts panel on the uploads page.
4. `e2e-test/skills.sh`, `e2e-test/artifacts.sh` + `run.sh`.
5. README (API table, prose), `marketplace/README.md`.

`./dev.sh reload` ships it: the image rebuild is the deploy. Old sandboxes
keep answering (they 404 the new paths; the frontend treats a missing
`artifacts` field and a failing `GET /skills` as "no skills"), and the next
reprovision picks up the image.

## 13. Alternatives rejected

- **Image-baked skills (`/app/skills`).** Rejected: knowledge updates would
  need an image rebuild + `reload` for every skill change, and the platform
  could not differ per user. The marketplace decouples knowledge (data, per
  user, volume) from capability (image, global, reviewed). The image ships
  libraries only.
- **A manifest-commit install phase (atomic install, rollback).** Rejected
  for v1: idempotent-by-path + on-demand `verify` gives the same observable
  guarantees (a partial install is *visible*) without a second state machine
  in the agent. Mirrors the PRD 0003 decision on uploads.
- **Skills installed by the manager into the volume.** Rejected: the manager
  drives containers, not workspace contents; the sandbox owns its filesystem
  contract. Keeping it that way preserves the RFC 0003 boundary.
- **Runtime `npm install docx`.** Rejected: least privilege, supply chain,
  egress, per-user cost (§2.2). The image is the deployment unit this stack
  already has.
- **A general `skills` HTTP API / third-party registry.** Rejected for v1:
  the repo bundle covers platform curation with zero new services; external
  authors need a trust model this RFC deliberately defers.
- **Hint as a prompt section reacting to the input.** Rejected: the section
  API renders per generation, but the hint belongs to one submission and must
  be durable and auditable — stored content is both.
- **Serving any workspace file from `GET /file` with binary support.** A
  dedicated artifacts root is narrower: one place to cap, list, and clean;
  `session.sqlite` and `corpus/meta` stay structurally unreachable from the
  download path instead of protected by policy.
- **Model-typed download paths in the answer text, parsed by the frontend.**
  Fragile and spoofable; the server-built envelope is the RFC 0006 pattern
  applied to production instead of evidence.
- **Direct Caddy links (`/u/<id>/artifact?...`) from the chat UI.** Works only
  in gateway mode; the web app must work in trusted-manager mode too, and the
  proxy keeps one uniform, authenticated path.
- **Baking Python + Pillow + LibreOffice for full skill parity.** ~400 MB and
  two runtimes for optional niceties; the container variant drops them without
  losing the core value (§5.9).

## 14. Open questions

1. **Skill versioning and updates.** Overwrite-on-install is enough for v1;
   "update available" (compare installed `marketplace.json` version to the
   catalog) is a small follow-up on the same data. Pinned/rollback versions
   need a real decision.
2. **Catalog telemetry.** Which skills are installed/used is visible in each
   sandbox (`GET /skills`, traces) but not aggregated anywhere. If product
   needs it, an event table in the OLTP is the natural home — a DB decision,
   deliberately not smuggled into this RFC.
3. **Third-party skills.** External authors need signing or a review queue;
   the manifest already carries hashes, so the format does not need to change
   first.
4. **Per-workspace artifact/volume quota.** Serving is capped, storage is
   not. Candidate: a workspace disk-usage check at snapshot time (warn in the
   envelope), real enforcement at the volume level. Needs a policy decision;
   not blocking v1.
5. **Multi-file deliverables** (a docx plus images): zip-on-download, or list
   the directory as N artifacts. v1 lists N files; grouping can be a pure
   frontend convention.
6. **Streaming/range downloads** if real documents exceed 25 MiB regularly
   (embedded images). Raise the cap first; ranges only with evidence.
7. **The egress lockdown this enables:** once nothing installs at runtime,
   per-user networks can drop NAT except the model API (and the manager). A
   manager change worth its own small RFC.
