# Marketplace

The platform-curated skill catalog (RFC 0009). One directory per skill under
`skills/`; the dashboard renders it, the user installs it into their sandbox,
and the sandbox verifies it against the manifest hashes.

```
marketplace/
  manifest.mjs               regenerates the files[] hashes of every manifest
  README.md                  this file
  skills/
    md-to-docx/
      marketplace.json       name, version, description, requires, files[] (generated)
      SKILL.md               the container-adapted skill the model reads
      references/            extra files the skill tells the model to read
```

## Manifest

```json
{
  "name": "md-to-docx",
  "version": "1.0.0",
  "description": "one-line catalog description (<= 200 chars)",
  "requires": { "nodeLibraries": ["docx"] },
  "files": [ { "path": "SKILL.md", "sha256": "...", "bytes": 1234 } ]
}
```

- `name` matches `/^[a-z0-9][a-z0-9-]{0,63}$/` (the sandbox refuses anything
  else as a `skill` parameter, so it is also the path segment).
- `requires.nodeLibraries` names **image** libraries, not npm ranges. The e2e
  drives the shipped bundle end to end: if a skill needs a library the image
  lacks, `verify.sh` fails and the skill does not ship. There is no runtime
  install path — that is the point (RFC 0009 D3).
- `files` is generated. After editing any bundle file run:

  ```bash
  node marketplace/manifest.mjs          # rewrite the hashes
  node marketplace/manifest.mjs --check  # CI-style staleness gate
  ```

## How the bundle travels

The bundle is static data owned by the web app, read from this directory at
request time (`frontend/src/lib/server/marketplace.ts`); there are no database
rows and no manager involvement. Installing streams each manifest file into the
user's sandbox at `WORKSPACE/skills/<name>/<path>` through the agent's
`POST /skills/file` endpoint, then verifies with `POST /skills/verify`. The
bundle never executes anywhere: the only interpreter is the model deciding to
follow `SKILL.md`.

## Review checklist for a new skill

1. **Name and layout** — pattern-conforming directory, `SKILL.md` with a
   frontmatter `description` (the agent listing reads it; missing means
   invisible), references under `references/`.
2. **No runtime installs** — the skill text must never instruct `npm`, `npx`,
   `pip`, or any package manager. In sandbox images those commands do not
   exist; a skill that requires them is a catalog bug.
3. **Deliverables under `artifacts/`** — anything the user should download is
   written under the workspace `artifacts/` root; the skill text must say so.
4. **Bounded helpers** — any bundled script (like `logo-palette.js`) must be
   pure Node on core modules only, with explicit size/time bounds.
5. **Manifest fresh** — `node marketplace/manifest.mjs --check` passes.
6. **E2E drives the shipped bundle** — `e2e-test/skills.sh` installs exactly
   these bytes; extend it when the bundle grows a second skill.

## Adapting a host skill

Source skills live at `~/.pi/agent/skills/<name>` on the maintainer's machine;
the repo owns its container copy and there is no runtime sync. Adaptation
rules that `md-to-docx` followed (RFC 0009 §5.9):

- Prerequisites become facts about the image (`docx` via `NODE_PATH`, no npm,
  no Python/LibreOffice), never installation instructions.
- Output locations move under the workspace `artifacts/` root.
- Validation becomes structural, in Node, dependency-free.
- Host-only references (`~/.claude/...` paths) are removed.
