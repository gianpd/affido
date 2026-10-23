# Uploads (workspace files)

## Sub-features

- Create the `uploads/` directory in the sandbox workspace.
- Upload files/directories (path structure preserved, per-file and total limits shown in the UI).
- List workspace files and run artifacts (`artifacts/`) with sizes; download them.

## How to get to it (user POV)

Sidebar → *Uploads* (`/dashboard/uploads`). The page explains `uploads/<your path>`; forms create the directory and upload files.

## Driving it with Playwright

`drive.mjs uploads --state <run>/state.json` renders and screenshots the page (counts of files under `uploads/` and `artifacts/`). Driving an actual directory upload needs `setInputFiles` with the multiple/directory input plus a sandbox round-trip; extend the scenario in `drive.mjs` when that path needs proof (the form is `enctype="multipart/form-data"` at the bottom of the page).

## Gotchas

- Uploads land in the sandbox workspace volume, not the DB: after cleanup/`reset` they are gone even though the page may cache counts until reload.
- The page talks to the sandbox for the file tree; if the sandbox is stopped, expect an empty tree, not an error page — check the doctor before declaring a bug.
