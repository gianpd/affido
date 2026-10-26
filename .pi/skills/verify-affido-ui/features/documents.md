# Documents

## Sub-features

- Create a document: title + pasted text, or a file upload (text, Markdown, CSV, JSON, YAML, XML; size limit shown in the form).
- List with search (`Search documents…`) and per-user counts badge in the sidebar.
- Document detail (ingest status: `raw_only` → `parsed`, or `failed` with error), delete with confirmation.
- Ingestion happens inside the sandbox; `ingest_event` rows are the audit trail.

## How to get to it (user POV)

Sidebar → *Documents* (`/dashboard/documents`), or *New document* button (`?new=1`). Fill *Title*, paste into *Paste text* (or choose a file), *Save document* → back to the list.

## Driving it with Playwright

`drive.mjs documents --state <run>/state.json` creates a note titled `Verify note <runId>` through the real form, asserts it appears in the list, clicks it, and asserts + screenshots the detail dialog (the detail is a modal `Dialog.Root`, not a navigation).

Two variants exist:

- `--upload FILE [--doc-title TITLE]` — fills *Title*, sets the file on `page.getByLabel('Upload file')` (input `#doc-file`), saves, and lands on `?doc=<id>` where the detail dialog is already open. The step fails if the dialog text matches `/failed|error/i`, so a failed ingest cannot pass silently. Same form, same ingest path as pasted text.
- `--delete-title TITLE` — finds the row, opens its `Actions` menu, clicks `Delete`, confirms in the `alertdialog`, and asserts the row is gone (`documents-before-delete*`, `documents-delete-confirm*`, `documents-after-delete*`).

## Gotchas

- Ingest status is asynchronous: a fresh document may show `raw_only` until the sandbox parses it. A `failed` status with an error is a real finding; `raw_only` after seconds is not (re-screenshot the detail after a wait).
- Deleting a document removes the `document` row but `ingest_event` rows survive on purpose (audit rows outlive the document).
- The bytes live in the sandbox workspace (`corpus/raw/…`), the DB keeps metadata only — after a sandbox volume wipe (cleanup, `dev.sh reset`) documents must be re-ingested before the agent can cite them.
