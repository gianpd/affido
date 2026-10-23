---
name: pdf-text-extraction
description: >
  Use this skill whenever a PDF must be read inside this sandbox: extract text,
  count pages, read metadata, or parse tables and forms out of invoices, fiscal
  certificates (CU, 730, CUK), contracts, statements. Triggers include 'leggi il
  pdf', 'read the pdf', 'extract text from', 'quante pagine ha', 'riassumi il
  documento', 'search in the PDF', and any Node failure like "Cannot find module
  'unpdf'". Do NOT use for producing DOCX files (md-to-docx skill) or for
  scanned image PDFs (this sandbox has no OCR: say so instead).
version: 1.0.0
license: MIT
---

# PDF text extraction with unpdf

`unpdf` is the only PDF reader in this container. It wraps a serverless build of
Mozilla PDF.js (v6.4) and extracts embedded text, positioned text, metadata, and
links. It cannot render pages to images and cannot OCR.

## The runtime contract — read first, this is where attempts die

1. `unpdf` is **preinstalled at `/app/node_modules`**, and `NODE_PATH=/app/node_modules`
   is already set for every bash command. A plain `node script.cjs` resolves
   `require('unpdf')` from **any** directory (`/workspace`, `/tmp`, `/root`).
2. **Never set, reset, or "fix" `NODE_PATH`.** The canonical failure is
   `NODE_PATH=$(npm root -g) node x.js` → `Cannot find module 'unpdf'`: it
   replaces the working value with a directory that does not exist. There is no
   npm, no npx, no corepack, nothing to install — do not try.
3. **CommonJS only.** Use `require('unpdf')` in a `.cjs` (or plain `.js`) file.
   ESM `import 'unpdf'` fails everywhere outside `/app`: ESM resolution ignores
   `NODE_PATH` and dies with `ERR_MODULE_NOT_FOUND`.
4. The toolbox is closed: no `pdftotext`, no Python, no LibreOffice, no canvas
   package. `renderPageAsImage` and `extractImages` (which need
   `@napi-rs/canvas`) are therefore unavailable. Text, positions, metadata,
   links only.

## Ready-to-run extractor

Do not write a script from scratch; run the bundled one:

```bash
# pages + merged text to stdout
node /workspace/skills/pdf-text-extraction/references/extract-pdf.cjs uploads/persona-finanza/doc.pdf

# a page range only, per-page JSON, positioned items, or metadata
node .../extract-pdf.cjs doc.pdf --pages=2-4
node .../extract-pdf.cjs doc.pdf --json
node .../extract-pdf.cjs doc.pdf --items
node .../extract-pdf.cjs doc.pdf --meta
```

It is bounded (64 MiB input, 1000 pages, 120 s timeout, `maxImageSize` capped),
reports a clean error for encrypted or malformed files, and prints an explicit
note when a PDF has no text layer. Save big outputs once and re-read them:

```bash
node .../extract-pdf.cjs doc.pdf > /tmp/doc.txt   # then grep / read /tmp/doc.txt
```

## API you will actually use

| Function | Returns | Use |
|---|---|---|
| `getDocumentProxy(new Uint8Array(fs.readFileSync(p)))` | proxy | open once, reuse for every call below |
| `extractText(pdf, { mergePages: true })` | `{ totalPages, text: string }` | whole-document text; without `mergePages` → `string[]` per page |
| `extractTextItems(pdf)` | `{ items: StructuredTextItem[][] }` | per-page items with `x`, `y`, `width`, `fontSize`, `hasEOL` |
| `getMeta(pdf, { parseDates: true })` | `{ info, metadata }` | title, author, creation date, PDFFormatVersion |
| `extractLinks(pdf)` | `{ links: string[] }` | embedded hyperlinks |

## Method

1. **Locate**: user uploads live under `/workspace/corpus/uploads/<collection>/`;
   single ingested documents under `/workspace/corpus/raw/<docId>.<ext>`. Both
   roots are one corpus: `corpus_grep`/`corpus_read` already see text files and
   PDFs (through text extracted at upload time) — search the corpus first and
   reach for this skill only when you need more than the indexed text (layout,
   positions, page ranges, metadata). List the trees with bash when unsure.
2. **Extract once** with the bundled extractor, write text to `/tmp/<name>.txt`,
   then answer with `grep`/`read` on that file. Never re-parse per question.
   (A PDF whose upload-time extraction failed — a scanned original — has no
   indexed text: this skill is its only path.)
3. **Scanned PDFs**: whitespace-only text means no text layer. Stop and tell
   the user plainly: this sandbox has no OCR. Do not retry with other tools and
   do not suggest installing one.
4. **Fiscal forms print numbers as spaced digits** (`2 0 2 5`,
   `1 6 0 3 2 0 2 5`). Grep with optional spaces between digits:
   `grep -E '2 ?0 ?2 ?5' /tmp/doc.txt`, or strip spaces in a script.
5. **Columns interleave in merged text.** `extractText` reads in content-stream
   order, so a form's columns arrive mixed. When row structure matters, rebuild
   rows from positioned items — sort by `y` (PDF origin is bottom-left, so
   descending `y` = top-down), group items within ~2 units, then sort by `x`:

   ```js
   const rows = [];
   for (const it of [...items[page]].sort((a, b) => b.y - a.y || a.x - b.x)) {
     const row = rows[rows.length - 1];
     if (row && Math.abs(row.y - it.y) <= 2) row.parts.push(it);
     else rows.push({ y: it.y, parts: [it] });
   }
   // rows.map(r => r.parts.map(p => p.str).join(" | "))
   ```

   Some pages legitimately carry zero items (e.g. a protocol receipt page):
   check `items[page].length` before grouping.

6. **Untrusted PDFs**: check `pdf.numPages` before extracting everything, pass
   `maxImageSize` to `getDocumentProxy`, and race long extractions against a
   timeout — with the serverless build, parsing runs on your event loop.
7. **Deliverables** the user should download (extracted text exports, reports)
   are written under `/workspace/artifacts/`, never anywhere else.

## Failure table

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module 'unpdf'` | `NODE_PATH` overridden, or script relies on a global npm root | plain `node script.cjs`; never prefix `NODE_PATH=...` |
| `ERR_MODULE_NOT_FOUND ... imported from` | ESM `import` in a `.mjs` file | rename to `.cjs` and use `require('unpdf')` |
| text output is empty/whitespace | scanned image PDF, no text layer | tell the user; no OCR exists here |
| error mentioning canvas / `@napi-rs/canvas` | `renderPageAsImage` / `extractImages` | not available in this image; use text/items |
| `PasswordException` | encrypted PDF | password-protected files are not supported |
| node printed all output but never exits | an armed `setTimeout` keeps the event loop alive | `timer.unref()` or `clearTimeout` after `Promise.race` |
