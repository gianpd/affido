---
name: md-to-docx
description: >
  Use this skill when the user wants to convert markdown notes or draft text into a
  professionally styled Word document (.docx) inside this sandbox. Triggers include:
  'convert to docx', 'generate Word document', 'create styled document from notes',
  'write a docx', 'produce a proposal document', 'transform markdown to Word',
  'fai un documento Word dalle note', 'genera un docx', or any request to produce a
  formatted .docx with brand styling (logo, color palette, custom fonts). Also use
  when the user provides raw markdown and says 'usa lo stile del logo', 'usa lo stile
  X', or describes a visual identity to apply. Do NOT use for editing existing DOCX
  files, filling form templates, PDF generation, or Google Docs.
version: 1.0.0
license: MIT
---

# Markdown → Styled DOCX Generator (sandbox edition)

## Overview

Converts markdown notes or draft text into a fully styled, production-grade Word
document (.docx). The skill handles the entire pipeline: style definition →
markdown parsing → element mapping → DOCX generation → structural validation.

**Input:** Markdown file or raw markdown text + a brand style (logo image, color
palette, or user-described visual identity).

**Output:** A `.docx` file under `artifacts/` in the workspace — the only
directory the user can download files from. With professional formatting: styled
headings, tables, bullet lists, callout boxes, dividers, headers/footers, and
page numbers.

**Core value:** Turns rough notes into client-ready proposals, reports, or
documents that look like they were designed by a brand agency — not a generic
word processor.

---

## Runtime environment (read once)

This sandbox is closed on purpose. Know these three facts and never fight them:

1. **The `docx` library is preinstalled.** Every Node script you run can
   `require('docx')` from any working directory through `NODE_PATH`. There is
   no `node_modules` to create and nothing to install.
2. **`npm`, `npx`, and `corepack` do not exist.** A command like
   `npm install anything` fails with `command not found`. This is the platform
   enforcing least privilege, not an environment problem to work around. Do not
   attempt installs, do not suggest them, do not try `require('child_process')`
   tricks to fetch packages — there is no route to the registry that matters.
3. **No Python, no Pillow, no LibreOffice.** Everything runs in Node. Logo
   palette extraction uses `references/logo-palette.js` (pure Node, zlib core
   module); validation is structural, in Node (Phase 4).

---

## Quick Reference

| Scenario | Approach |
|----------|----------|
| User gives notes + logo file | Extract palette with `references/logo-palette.js` → confirm → build docx |
| User gives notes + color hex codes | Use provided palette → build docx |
| User gives notes + "style X" name | Look up X in `references/brand-palettes.md` |
| User gives notes only, no style | Ask: "Do you have a logo or brand colors? Otherwise I will use a clean neutral style." |
| User wants to reuse a previous style | Copy the style constants block from the earlier `generate_<name>.js` |

---

## Output locations (fixed)

- The document always lands at `artifacts/<name>.docx`, relative to the
  workspace root. Create the directory if it does not exist. Never write the
  final document anywhere else: files outside `artifacts/` are not downloadable.
- The generation script is written in the workspace root as
  `generate_<name>.js` and stays there, re-runnable: the user can ask for a
  palette change and you edit the constants block and re-run the same script.
- A logo supplied by the user is read from wherever the user says it is
  (usually under `uploads/`); never copy it, reference the path directly.

---

## Core Workflow

### Phase 1 — Style Definition

The first and most important step. Without a clear style definition, the
document will look generic. Define these 8 tokens:

```
PRIMARY_COLOR    — Main brand color (headings, dividers, accent elements)
SECONDARY_COLOR  — Secondary color (subheadings, links, secondary accents)
DARK_COLOR       — Near-black for body bold text, footer text
LIGHT_BG         — Very light tint for callout boxes
ACCENT_COLOR     — Accent for borders, table header underlines
TABLE_HEADER_BG  — Light tint for table header rows
TABLE_ROW_ALT    — Very light tint for alternating table rows
BORDER_COLOR     — Subtle border color for tables
```

#### Method A: Extract from Logo (preferred when user has a logo)

```bash
node skills/md-to-docx/references/logo-palette.js uploads/logo.png
```

The script is pure Node (the `zlib` core module inflates the PNG), bounded to
4 MiB and 2M pixels, and prints the dominant non-white/non-black colors with
their weight:

```
1. #6B2FA0 — 41.2%
2. #2D6CC0 — 9.8%
```

**Color assignment rules:**
- The most frequent non-white/non-black color → `PRIMARY_COLOR`
- The second most frequent → `SECONDARY_COLOR` or `ACCENT_COLOR`
- If only one brand color exists, derive lighter/darker variants:
  - `LIGHT_BG` = PRIMARY at ~10% opacity on white
  - `TABLE_HEADER_BG` = PRIMARY at ~20% opacity
  - `TABLE_ROW_ALT` = PRIMARY at ~5% opacity
  - `BORDER_COLOR` = PRIMARY at ~30% opacity

If the script reports an unsupported PNG (interlaced, 16-bit, palette without
transparency information), do not improvise a decoder: fall back to Method B.

**CRITICAL: Always show the extracted palette to the user and ask for
confirmation** before proceeding. Say: "I extracted these colors from the logo:
[palette]. Confirm, or tell me which ones to change?"

#### Method B: User-Described Style

When the user says "an elegant style, dark blue and gold" or describes colors
directly, map the description to the 8 tokens:

- "dark blue" → DARK_COLOR = "1A1A3E", PRIMARY = "1E3A5F"
- "gold" → ACCENT_COLOR = "C9A84C"
- "elegant, minimal" → white space, thin borders, serif headings
- "technical, industrial" → monospace code fonts, thick borders, high contrast

When in doubt, ask: "For color X, is #YYYYYY fine or do you prefer another shade?"

#### Method C: Named Preset

See `references/brand-palettes.md` for pre-built palettes. If the user names
one, use it. If they describe something close, adapt it.

#### Method D: No Style Provided

Ask the user. Never generate a document without asking about styling first:
"Do you have a logo or brand colors? If you give me either (logo file or hex
codes), the document will carry your brand. Otherwise I will use a clean
neutral style."

### Phase 2 — Markdown Parsing & Content Mapping

Scan the markdown and identify:

1. **Cover page elements**: first H1, subtitle, date, author, recipient
2. **Section hierarchy**: H1 → major sections, H2 → subsections, H3 → detail
3. **Lists**: ordered and unordered
4. **Tables**: pipe tables
5. **Callouts/quotes**: blockquotes → callout boxes
6. **Bold/italic/code**: inline formatting
7. **Horizontal rules**: `---` → section dividers
8. **Images**: `![alt](path)` → embedded when the file exists under the workspace

#### Mapping Table

| Markdown | docx-js Element |
|----------|----------------|
| `# Title` (first H1) | Cover page title |
| `## Section` | `makeHeading2()` with colored bottom border |
| `### Subsection` | `makeHeading3()` |
| `- bullet` | `makeBullet()` using LevelFormat.BULLET numbering |
| `1. numbered` | `makeNumbered()` using LevelFormat.DECIMAL numbering |
| `> quote` | `makeCallout()` — table cell with left border accent |
| `---` | `makeDivider()` — paragraph with bottom border |
| `**bold**` | `TextRun({ bold: true })` |
| `*italic*` | `TextRun({ italics: true })` |
| `` `code` `` | `TextRun({ font: "Courier New" })` |
| Pipe table | `Table` with header row and alternating rows |
| `![alt](path)` | `ImageRun` (only when the file exists; `type` is required) |

### Phase 3 — DOCX Generation Script

Write a self-contained `generate_<name>.js` in the workspace root, modeled on
`references/generator-template.js` (read it first). The template already
resolves `require('docx')` through `NODE_PATH` and writes into `artifacts/`.

Script skeleton:

```javascript
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        ImageRun, Header, Footer, AlignmentType, HeadingLevel, BorderStyle,
        WidthType, ShadingType, PageNumber, PageBreak, LevelFormat,
        TabStopType, TabStopPosition } = require('docx');
const fs = require('fs');
const path = require('path');

// === STYLE TOKENS (filled from Phase 1) ===
const PRIMARY = "6B2FA0";  const SECONDARY = "2D6CC0";
const DARK    = "1A1A2E";  const LIGHT_BG  = "F5F0FA";
const ACCENT  = "8B5CF6";  const TH_BG     = "E8D5F5";
const TR_ALT  = "F9F5FF";  const BORDER    = "C4A8E8";
const GRAY    = "555555";

// === helpers copied from references/generator-template.js ===
// makeHeading1/2/3, makeBody, makeBullet, makeNumbered, makeCallout,
// makeDivider, table cells, spacer, cover-page rows

// === content built from the markdown (Phase 2 mapping) ===
// ...

Packer.toBuffer(doc).then((buffer) => {
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync(path.join('artifacts', 'proposal.docx'), buffer);
  console.log('DOCX created: artifacts/proposal.docx (' + buffer.length + ' bytes)');
}).catch((err) => { console.error(err); process.exit(1); });
```

Run it with `node generate_<name>.js` from the workspace root.

#### Critical docx-js rules

- Set page size explicitly (A4: 11906×16838 DXA)
- Never use `\n` — always separate Paragraphs
- Never use unicode bullets — use the LevelFormat.BULLET numbering config
- PageBreak must be inside a Paragraph
- ImageRun requires `type` (`"png"`, `"jpg"`, …)
- Table widths: always DXA, never PERCENTAGE; set both `columnWidths` and cell width
- Use `ShadingType.CLEAR` for cell backgrounds, never SOLID
- Override heading styles by exact ids: "Heading1", "Heading2", "Heading3"
- Apostrophes and accents: type the character directly in the JS string

### Phase 4 — Validation (structural, in Node)

After generating, validate the file before claiming success — this catches a
broken script without any external tool:

```bash
node -e '
const fs = require("fs");
const buffer = fs.readFileSync("artifacts/proposal.docx");
const zip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
const parts = ["[Content_Types].xml", "word/document.xml"].every((name) =>
  buffer.includes(Buffer.from(name, "latin1")));
if (!zip || !parts) { console.error("INVALID: missing zip signature or required parts"); process.exit(1); }
console.log("VALID docx:", buffer.length, "bytes");
'
```

This is a signature scan: the zip local-file header and the two required part
names, no decompression. Word on the user's machine remains the final arbiter;
the check exists to catch a generation failure before the run claims success.

If validation fails: read the error, fix the script, re-run, re-validate.

---

## Decision Logic

- **IF** user provides a logo file → Method A, confirm palette, build
- **IF** user provides hex codes → Method B directly
- **IF** user says "style X" → Method C (presets)
- **IF** neither → ask (Method D); never skip the styling question for proposals
- **IF** user provides a markdown file → read it; scan structure
- **IF** user pastes raw text → treat as markdown
- **IF** mixed Italian/English content → preserve language, same typography
- **IF** proposal/business document → cover page + footer with page numbers
- **IF** simple notes → minimal headers, no cover page
- **IF** the script fails → read the error, fix the JS, re-run; never fall back
  to hand-writing zip/XML or to "instructions for the user"

---

## Completion

After a VALID document, tell the user:

1. **The path** — `artifacts/<name>.docx` — it is downloadable from the chat
2. **The script** — `generate_<name>.js` — still in the workspace for re-runs
3. **One-line summary** — size and what style was applied

### Quality criteria (the document must pass)

- [ ] Opens in Word (structural validation passed)
- [ ] Logo renders in header and cover page (when provided)
- [ ] Headings use brand colors, not default blue
- [ ] Lists use numbering config, not unicode characters
- [ ] Tables have header rows with brand-colored background
- [ ] Page numbers in footer; cover page breaks before body
- [ ] No content dropped from the source markdown

---

## Error Handling

| Error | Likely cause | Resolution |
|-------|-------------|------------|
| `Cannot find module 'docx'` | stale sandbox image (NODE_PATH missing) | say so and stop: the platform must `reload`; no workaround exists |
| `ENOENT` on the logo | wrong path | check the path under `uploads/`; if missing, skip images |
| DOCX fails validation | malformed generation | fix table widths (DXA), ShadingType.CLEAR, no unicode bullets |
| Missing content | element not mapped | check the mapping table, extend the script |
| `logo-palette.js: unsupported` | interlaced/16-bit PNG | fall back to hex codes or a preset |
| Colors look wrong | extraction picked noise | ask the user for hex codes |

## Edge Cases

1. **Logo transparency**: `logo-palette.js` ignores pixels with alpha < 50%.
2. **White/black-dominant logo**: the script filters near-white and near-black;
   if nothing remains, fall back to Method B.
3. **Nested lists**: two levels via the numbering config (level 0 bullet,
   level 1 hollow bullet).
4. **Inline HTML in markdown**: strip it; docx-js does not parse HTML.
5. **Emoji**: may not render in all Word versions; replace or warn.
6. **Very long documents**: generation stays fast (it is one buffer write);
   ask before splitting.
7. **Italian apostrophes** (l'azienda): type the character directly.

## Reference Files

- `references/generator-template.js` — complete generation template with all
  helpers; read it before writing `generate_<name>.js`
- `references/brand-palettes.md` — pre-built palettes by name
- `references/logo-palette.js` — bounded, pure-Node PNG palette extractor
