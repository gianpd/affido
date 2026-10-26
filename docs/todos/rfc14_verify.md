   Verify that RFC 0014 (docs/rfc/0014-unified-ingestion-and-index-registry.md, status: Implemented)
   is correctly implemented, by driving the real affido UI like a user with the `verify-affido-ui`
   skill. You can read images: every screenshot you take, you must also open with the `read` tool —
   a screenshot you did not read is not evidence. You do NOT modify product code; if something
   fails, report it, do not fix it.

   ## 0. Read first, in this order
   1. .pi/skills/verify-affido-ui/SKILL.md (launch, doctor, drive, evidence standard, cleanup)
   2. .pi/skills/verify-affido-ui/features/chat.md, documents.md, uploads.md, traces.md
   3. docs/rfc/0014-unified-ingestion-and-index-registry.md — §4 (R1–R12), §5.5–§5.7, §7
   4. e2e-test/citations.sh — the minimal-PDF fixture recipes you will reuse

   ## 1. Preconditions
   - Repo root: /home/jaco/develops/RESEARCH/affido
   - Control plane up: ./dev.sh up  (then ./dev.sh status; caddy, oltp, sandbox-manager Up)
   - The manager must run affido-agent:latest (faux provider, deterministic scripted answers).
     If the image predates the RFC (check `docker images affido-agent --format '{{.CreatedAt}}'`
     against the newest commit touching agent/ingest.ts), rebuild and reload:
     docker build -t affido-agent:latest ./agent && ./dev.sh reload
   - Frontend dev server on :5173 per the skill (reuse an existing one; never kill one you
     did not start).
   - Fresh signups get the keyless faux provider by default — do not configure BYOK.

   ## 2. Driver extensions you need first (small, sanctioned by the skill)
   The shipped driver cannot reach two paths; extend drive.mjs minimally and, per the skill's
   own rule, update the matching features/*.md in the same change:
   - chat: add a --strict flag that flips the switch with aria-label "Strict citations mode"
     before clicking Send message.
   - documents: add a variant that uploads a file via the real form
     (page.getByLabel('Upload file').setInputFiles(...)) instead of pasting text.
   Commit nothing; leave the edits in the working tree and mention them in your report.

   ## 3. Fixtures (same bytes the e2e uses)
   Known sentence inside the text-bearing PDF: "Il contratto si rinnova il 1 marzo 2027"
   Minimal one-page PDF (Helvetica text):
     { printf '%%PDF-1.4\n';
       printf '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n';
       printf '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n';
       printf '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n';
       printf '4 0 obj<</Length 74>>stream\nBT /F1 24 Tf 72 720 Td (Il contratto si rinnova il 1 marzo 2027) Tj ET\nendstream endobj\n';
       printf '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n';
       printf 'trailer<</Root 1 0 R>>'; } > /tmp/rinnova.pdf
   Scanned/no-text-layer PDF: printf 'not a real pdf: no text layer' > /tmp/scanned.pdf
   Markdown fixture: a .md file containing the same sentence.

   ## 4. Scenarios — one fresh signup per independent case (A, B, C; D and E reuse A's user)
   Every scenario: run the driver, then READ every NN-step.png AND its NN-step.txt twin, then
   check facts-<scenario>.json (httpErrors, consoleErrors, networkFailures empty; no step error).
   The faux provider is deterministic: assert on the exact shapes below.

   A. RFC 0014 §7(a) + R6/I3 — a PDF ingested through Documents is citable from its DERIVED text
      1. signup user A; drive the documents upload variant with /tmp/rinnova.pdf.
      2. Open the document detail: it must not show a failed ingest.
      3. chat --strict --prompt "When does the uploaded contract renew?"
      4. EXPECT: an assistant bubble "The maintenance contract renews tacitly on 1 March 2027
         [cit_xxxxxxxx]" plus the citation footer naming THIS document, with a quote containing
         "rinnova" and "1 marzo 2027". That quote can only exist if the index read the extracted
         text: on the pre-RFC bug the index read raw PDF bytes and no such quote could verify.
         Evidence "cited", never "none".

   B. RFC 0014 §7(b) — the same fixture through the Uploads tree, same admission, also citable
      1. signup user B; drive uploads so /tmp/rinnova.pdf lands at persona-finanza/rinnova.pdf
         (same known sentence).
      2. chat --strict --prompt "When does the uploaded contract renew?"
      3. EXPECT: same cited shape as A, but the citation's title is the tree path
         (persona-finanza/rinnova.pdf), not a Documents title. Two entry points, one pipeline.

   C. RFC 0014 R7 + §5.6.1 — a scanned PDF is staged but never evidence
      1. signup user C; upload /tmp/scanned.pdf via Documents. It must be listed and its detail
         viewable (staged, downloadable) — the upload itself must not fail.
      2. chat --strict --prompt "When does the maintenance contract renew?"
      3. EXPECT: the answer is "UNANSWERED: the corpus does not contain the renewal date." with
         the no-document-evidence labeling, and NO [cit_...] token and no citation footer.
         Any citation here is a FAIL of R7.

   D. RFC 0014 R11 + §7(d) — a strict run refuses workspace tools and still answers
      1. On user A (has the citable PDF): chat --strict --prompt
         "When does the uploaded contract renew? Check with bash first."
      2. EXPECT: still a cited answer (the blocked bash redirected to corpus_grep/corpus_read).
      3. Open this run's trace (traces scenario, then the trace detail). Find the bash tool
         result entry: it must be an error whose text contains
         "disabled in this strict-citations run" and "corpus_grep". Screenshot it.

   E. RFC 0014 R9 — deletion removes the document from the evidence channel
      1. On user A: delete the rinnova.pdf document through the Documents UI (confirm).
      2. chat --strict --prompt "When does the maintenance contract renew?"
      3. EXPECT: UNANSWERED / no-document-evidence, no citation. A citation to the deleted
         document is a FAIL of R9 (orphaned registry entry).

   Corroborating (not primary) evidence, labeled as such in the report: for user A's sandbox,
   `docker exec <container> ls /workspace/corpus/meta` and cat one sidecar — it must contain
   "indexing" and "textPath"/"textSha256" fields, and corpus/raw, corpus/meta must contain no
   entry for the deleted document after E.

   ## 5. Budget and gotchas
   - First chat per user provisions a sandbox (~3 min). Plan the order so D and E reuse A's
     warm sandbox. Do not send more chat prompts than the scenarios require.
   - If a screenshot contradicts facts.json, believe the screenshot and investigate.
   - Read the trace detail before declaring any chat step failed on an empty bubble.

   ## 6. Verdict
   Write verify-runs/<RUN>/REPORT.md: a table with columns RFC clause | scenario step |
   evidence file (NN-step.png) | expected | observed | PASS/FAIL, plus the driver-extension
   diff summary and the corroborating docker findings. End with one line:
   "RFC 0014 UI verification: PASS" or "...: FAIL — <clauses>".
   Report the run dir path to the user.

   ## 7. Cleanup
   Run .pi/skills/verify-affido-ui/cleanup.sh "$RUN" (also on failure) so scratch users,
   sandboxes and volumes do not pile up. Never delete verify-runs/.
