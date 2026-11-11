# RFC 0022 — Per-agent disk quota and storage monitoring

| Field | Value |
|---|---|
| Status | Implemented |
| Author | Affido maintainers |
| Date | 2026-11-06 |
| Target | `agent/`, `frontend/` |
| Related | RFC 0002 (per-user volumes), RFC 0005 (workspace/corpus separation), RFC 0009 (artifacts), RFC 0014 (ingest pipeline) |

## 1. Summary

Each agent sandbox gets one logical disk ceiling of **2.5 GiB**, shared by its two
durable volumes (`/workspace` and `/data`). The agent measures its own usage,
refuses writes that would cross the ceiling, and reports `quota / used /
available / alert state` over `GET /storage`. The dashboard shows that report in
one pie-chart container with an alert when the quota is nearly full.

## 2. Problem

`docker volume create pi-ws-<user>` and `pi-data-<user>` have no size option
(`sandbox_manager.py:provision`). Before this RFC the only bounds were per
request: 10 MiB per upload, 1 MiB per JSON body, 1000 entries per tree listing.
Nothing summed the bytes already on disk.

Concrete trace: 300 uploads of 10 MiB are all admitted (each is below the
single-request limit), the volume reaches 3 GiB, and the next `writeFile` in
`IngestPipeline.stage` throws `ENOSPC`. `server.ts` answers a generic `500`
with the raw error string. `/health` still answers `ok`, so the manager's
reconcile tick sees nothing wrong. The user has no indication that space is
running out; `GET /status` reports no bytes and the dashboard's "Documents"
card shows the sum of catalog rows, not free space.

A true kernel-level quota is not portable here: Docker's `size` storage option
needs a specific host filesystem (xfs with project quotas, btrfs or zfs) and
does not apply to named volumes, while the containers run under gVisor. The
enforcement point must therefore be the agent process that owns the writes.

## 3. Decision

### 3.1 One measurement

`agent/storage.ts` defines `AGENT_STORAGE_QUOTA_BYTES = 2_684_354_560`
(2.5 GiB). `StorageQuota` walks the two volume roots with `lstat`, sums the
logical size of regular files, skips symlinks, caps the walk at 100,000
entries, and reads `statfs` for the host free bytes. A measurement is cached
for two seconds and invalidated after every write or delete.

```
usedBytes      = sum(file sizes under /workspace and /data)
availableBytes = max(0, min(quotaBytes - usedBytes, hostFreeBytes))
state          = full (available 0) | critical (>= 95%) | warning (>= 80%) | ok
```

`availableBytes` is capped by the host free space, so the UI never promises
space the host does not have. `:memory:` session databases (tests) and a
session database inside the workspace add no second root.

### 3.2 Admission, not cleanup

`ensureCapacity(requestedBytes)` is called before a write lands. It throws
`StorageQuotaError` (HTTP **507 Insufficient Storage**) carrying the numbers,
so the frontend can show why a write failed. `0` means "no new bytes": directory
creation and shell commands are refused once the quota is full.

The check is wired into every write path:

- `IngestPipeline` (`/ingest`, `/uploads/file`, and their deletes) — RFC 0014's
  single staging entry point.
- `SkillsFileTool`, `CreateUploadDirTool`, `DeleteSkillTool`,
  `DeleteArtifactsTool` — the other plain-filesystem writes.
- `QuotaExecutionEnv` (`agent/quota-env.ts`), a `NodeExecutionEnv` subclass
  installed as the Harness `env` factory. `write`/`edit` go through
  `writeFile`, `bash` through `exec`. A denial is returned as the environment's
  own `FileError` / `ExecutionError`, so it becomes an ordinary tool error in
  the durable trace instead of a server crash.
- `ContainerAgent.prompt` refuses a new run with 507 while full, so the user
  gets a named failure before the model starts a long turn.

Reads, deletes, `/health` and `/status` are unchanged. `/status` still does not
open storage.

### 3.3 Monitoring

`GET /storage` is an `HttpTool` subclass (`StorageTool`) returning the report.
It never activates the Harness: it is plain filesystem work. The frontend
reaches it through the existing sandbox client, so both the Caddy gateway and
the trusted manager `/resolve` mode work without a Caddy or manager change.

The dashboard's `load` fetches the snapshot with `.catch(() => null)`, like the
traces page's citation report: the page stays usable when the sandbox is
stopped. `frontend/src/lib/components/storage-usage.svelte` is one container
with an SVG pie (used / available of the 2.5 GiB quota), the available bytes,
the alert state and a manual Refresh button hitting `/api/storage`.

**No polling.** A repeating probe would call `/resolve` on every tick and keep
an idle sandbox awake, which defeats the L0/L1 idle pause of RFC 0002. The
snapshot is taken on page load and on demand. A deployment that needs a live
host-wide graph should sample volumes in the manager, not wake agents.

### 3.4 Alert

`storageAlert` maps the four server states to UI copy: `warning` and
`critical` tell the user to delete documents, uploads or artifacts; `full`
states that writes are refused with 507. The used wedge switches to the
`--destructive` token at `critical` and `full`.

## 4. Limits and residual risk

- This is an application-level ceiling, not a kernel quota. A single `bash`
  command can overshoot before the next tool call re-measures; no further write
  or command is admitted afterwards. A hostile model that wants to exhaust the
  host disk in one command needs a deployment-level volume quota
  (`--storage-opt size` on a supported filesystem, or a quota-aware volume
  driver).
- Concurrent requests can both pass the same measurement before either
  invalidates it. Writes through prompts are serialized on the Harness chain;
  HTTP staging routes can still overshoot by the size of one upload.
- Rewriting or truncating an existing file is charged as a full new file, so
  the admission check is conservative: it may refuse a rewrite that would have
  fitted after the old bytes were released.
- The scan counts logical file sizes and is capped at 100,000 entries; a
  truncated scan reports `partial: true` and `usedBytes` as a lower bound.
- Deleting files through the dashboard is the recovery path. Volumes are never
  removed by `dev.sh reload` or idle eviction, by design.

## 5. Verification

- `agent/storage.test.ts`: measurement over both roots, cache invalidation,
  thresholds, 507 payload, `:memory:` sessions.
- `agent/quota-env.test.ts`: `write` refused as a tool error, `bash` refused
  while full and admitted after a delete, external writes re-measured.
- `frontend/src/lib/storage.test.ts`: fractions, pie wedges, alert copy,
  host-binding detection.
- Gates: `cd agent && npm run typecheck && npm test`;
  `cd frontend && pnpm check && pnpm lint && pnpm test:unit -- --run`.

## 6. Effect on other documents

RFC 0005 §11 item 7 listed per-user byte quotas as open work for the future
object-storage plane. A sandbox-level quota now exists; catalog/object-storage
quotas remain open and are still a property of that RFC, not of this one.
