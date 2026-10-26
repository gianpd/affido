# Uploads (workspace files)

## Sub-features

- Create the `uploads/` directory in the sandbox workspace.
- Upload files/directories (path structure preserved, per-file and total limits shown in the UI).
- List workspace files and run artifacts (`artifacts/`) with sizes; download them.

## How to get to it (user POV)

Sidebar → *Uploads* (`/dashboard/uploads`). The page explains `uploads/<your path>`; forms create the directory and upload files.

## Driving it with Playwright

`drive.mjs uploads --state <run>/state.json` renders and screenshots the page (counts of files under `uploads/` and `artifacts/`).

`--upload-dir DIR` drives a real directory upload: open `/dashboard/uploads?new=dir`, `setInputFiles(DIR)` on `#dir-upload`, click `Upload directory`, then wait for the tree to show the path. The input gets `webkitdirectory` from a page `$effect`, so pass a *directory* path (a plain file path is rejected by Playwright). The tree path keeps the picked directory's name: to land a file at `persona-finanza/rinnova.pdf`, pass the directory `persona-finanza` containing `rinnova.pdf`.

## Gotchas

- Uploads land in the sandbox workspace volume, not the DB: after cleanup/`reset` they are gone even though the page may cache counts until reload.
- The page talks to the sandbox for the file tree; if the sandbox is stopped, expect an empty tree, not an error page — check the doctor before declaring a bug.
