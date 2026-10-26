#!/usr/bin/env bash
# RFC 0006 e2e: strict-citations mode through the whole path (caddy -> manager
# -> sandbox agent), with the scripted faux provider driving
# corpus_grep -> corpus_read -> corpus_annotate -> answer_publish.
#
# Asserts the envelope (evidence/citations), the idempotent replay, the free
# run, re-verification after a container restart (R11), and the trace-only
# report (R10).
set -euo pipefail
source "$(dirname "$0")/lib.sh"

wait_ready

USER_ID="cite-${RUN_ID}"
TOKEN="tok-${USER_ID}"
COOKIE="better-auth.session_token=${TOKEN}"
seed_session "${USER_ID}" "${TOKEN}"
pass "seeded session for ${USER_ID}"

FIXTURE="$(mktemp /tmp/contrasto-XXXX.md)"
cat >"${FIXTURE}" <<'MD'
# Contratto di manutenzione

## Rinnovo
Il contratto si rinnova tacitamente il 1 marzo 2027.
La disdetta deve essere comunicata 90 giorni prima.

## Prezzi
Il canone annuo e di 12.000 EUR.
MD
QUOTE="Il contratto si rinnova tacitamente il 1 marzo 2027."

echo "== upload a fixture document through caddy (POST /ingest) =="
curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: text/markdown' \
	--data-binary @"${FIXTURE}" \
	"${BASE}/u/${USER_ID}/ingest?docId=doc_cite1&filename=contratto.md&title=Contratto%20di%20manutenzione" >/dev/null \
	|| fail "ingest through caddy failed"
pass "fixture staged as doc_cite1"

echo "== strict run: citations required =="
RUN_ID="cite-e2e-${RUN_ID}"
reply="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d "{\"prompt\":\"When does the maintenance contract renew?\",\"requestId\":\"${RUN_ID}\",\"citations\":\"required\"}" \
	"${BASE}/u/${USER_ID}/prompt")" || fail "strict prompt failed: ${reply:-}"

[[ "$(printf '%s' "${reply}" | field "d['status']")" == "done" ]] || fail "strict run not done: ${reply}"
[[ "$(printf '%s' "${reply}" | field "d['evidence']")" == "cited" ]] || fail "evidence is not cited: ${reply}"
[[ "$(printf '%s' "${reply}" | field "d['citationsMode']")" == "required" ]] || fail "citationsMode is not required: ${reply}"
CIT_ID="$(printf '%s' "${reply}" | field "d['citations'][0]['citationId']")"
[[ "${CIT_ID}" == cit_* ]] || fail "citationId is not content-addressed: ${CIT_ID}"
ANSWER="$(printf '%s' "${reply}" | field "d['answer']")"
[[ "${ANSWER}" == *"[${CIT_ID}]"* ]] || fail "answer does not carry the reported token: ${ANSWER}"
[[ "$(printf '%s' "${reply}" | field "d['citations'][0]['docId']")" == "doc_cite1" ]] || fail "citation points at the wrong doc: ${reply}"
[[ "$(printf '%s' "${reply}" | field "d['citations'][0]['title']")" == "Contratto di manutenzione" ]] || fail "sidecar title missing: ${reply}"
[[ "$(printf '%s' "${reply}" | field "d['citations'][0]['line']")" == "4" ]] || fail "citation line is not 4: ${reply}"
[[ "$(printf '%s' "${reply}" | field "d['citations'][0]['quote']")" == "${QUOTE}" ]] || fail "quote mismatch: ${reply}"
[[ "$(printf '%s' "${reply}" | field "d['citations'][0]['status']")" == "attribution_verified" ]] || fail "status not verified: ${reply}"
SUBMISSION_ID="$(printf '%s' "${reply}" | field "d['submissionId']")"
pass "strict reply published through the gate (${CIT_ID})"

echo "== idempotent replay of the same requestId =="
replay="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d "{\"prompt\":\"When does the maintenance contract renew?\",\"requestId\":\"${RUN_ID}\",\"citations\":\"required\"}" \
	"${BASE}/u/${USER_ID}/prompt")" || fail "replay failed"
[[ "$(printf '%s' "${replay}" | field "d['submissionId']")" == "${SUBMISSION_ID}" ]] \
	|| fail "replay ran a second submission: ${replay}"
[[ "$(printf '%s' "${replay}" | field "d['citations'][0]['citationId']")" == "${CIT_ID}" ]] \
	|| fail "replay citation id changed: ${replay}"
pass "same requestId returns the same admitted submission"

echo "== a request without the field keeps the free-form answer =="
plain="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE}" \
	-H 'content-type: application/json' \
	-d '{"prompt":"list the files","requestId":"cite-plain-'${RUN_ID}'"}' \
	"${BASE}/u/${USER_ID}/prompt")" || fail "free prompt failed"
[[ "$(printf '%s' "${plain}" | field "d['evidence']")" == "plain" ]] || fail "free run is not plain: ${plain}"
[[ "$(printf '%s' "${plain}" | field "d['citations']")" == "[]" ]] || fail "free run reports citations: ${plain}"
pass "no field, no gate: today's free-form answer"

echo "== the report recomputes exactness from the trace (R10) =="
report="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/inspect?report=citations")" || fail "citation report failed"
ROW="$(printf '%s' "${report}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
run = next(r for r in d['runs'] if r['runId'] == '${RUN_ID}')
print(json.dumps({'exact': run['exact'], 'published': run['published'], 'unreported': run['unreportedUsed'], 'padded': run['padded']}))")"
[[ "$(printf '%s' "${ROW}" | field "d['exact']")" == "True" ]] || fail "run not exact: ${ROW}"
[[ "$(printf '%s' "${ROW}" | field "d['unreported']")" == "[]" ]] || fail "unreported_used not empty: ${ROW}"
[[ "$(printf '%s' "${ROW}" | field "d['padded']")" == "[]" ]] || fail "padded not empty: ${ROW}"
EXACTNESS="$(printf '%s' "${report}" | python3 -c "import sys, json; print(float(json.load(sys.stdin)['citationExactness']))")"
[[ "${EXACTNESS}" == "1.0" ]] || fail "exactness is not 1.0: ${report}"
pass "report: exact, no unreported used, no padded"

echo "== citations survive a container restart (R11) =="
CONTAINER="$(sql -c "SELECT container_name FROM sandbox_registry WHERE user_id = '${USER_ID}'")"
[[ -n "${CONTAINER}" ]] || fail "no container for ${USER_ID}"
docker restart "${CONTAINER}" >/dev/null
verified="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE}" \
	"${BASE}/u/${USER_ID}/corpus/citations?runId=${RUN_ID}")" || fail "re-verification after restart failed"
[[ "$(printf '%s' "${verified}" | field "d['citations'][0]['status']")" == "attribution_verified" ]] \
	|| fail "citation did not re-verify after restart: ${verified}"
[[ "$(printf '%s' "${verified}" | field "d['citations'][0]['line']")" == "4" ]] \
	|| fail "re-verified line changed: ${verified}"
pass "citation re-verified against the stored text after restart"

echo "== an uploads-tree PDF is citable through its derived text (corpus bucket) =="
USER2="citepdf-${RUN_ID}"
TOKEN2="tok-${USER2}"
seed_session "${USER2}" "${TOKEN2}"
PDF_FIXTURE="$(mktemp /tmp/contratto-pdf-XXXX.pdf)"
{
	printf '%%PDF-1.4\n'
	printf '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
	printf '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
	printf '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n'
	printf '4 0 obj<</Length 74>>stream\nBT /F1 24 Tf 72 720 Td (Il contratto si rinnova il 1 marzo 2027) Tj ET\nendstream endobj\n'
	printf '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n'
	printf 'trailer<</Root 1 0 R>>'
} >"${PDF_FIXTURE}"
staged_pdf="$(curl -fsS --max-time 120 -X POST -H "Cookie: better-auth.session_token=${TOKEN2}" \
	-H 'content-type: application/pdf' \
	--data-binary @"${PDF_FIXTURE}" \
	"${BASE}/u/${USER2}/uploads/file?path=persona-finanza/contratto.pdf")" \
	|| fail "PDF upload through caddy failed"
[[ "$(printf '%s' "${staged_pdf}" | field "d['searchable']")" == "True" ]] \
	|| fail "the PDF upload must report searchable=True (derived text): ${staged_pdf}"
pass "PDF staged under corpus/uploads with extracted text"

echo "== the dashboard preview reads a PDF's derived text (GET /text) =="
# A third user, so the duplicate ingest cannot pollute USER2's corpus and its
# uploads-tree citation assertions below.
USER3="citetxt-${RUN_ID}"
TOKEN3="tok-${USER3}"
seed_session "${USER3}" "${TOKEN3}"
curl -fsS --max-time 120 -X POST -H "Cookie: better-auth.session_token=${TOKEN3}" \
	-H 'content-type: application/pdf' \
	--data-binary @"${PDF_FIXTURE}" \
	"${BASE}/u/${USER3}/ingest?docId=doc_pdf1&filename=contratto.pdf" >/dev/null \
	|| fail "PDF ingest through caddy failed"
derived="$(curl -fsS --max-time 120 -H "Cookie: better-auth.session_token=${TOKEN3}" \
	"${BASE}/u/${USER3}/text?docId=doc_pdf1")" || fail "GET /text failed"
[[ "$(printf '%s' "${derived}" | field "d['path']")" == "corpus/text/doc_pdf1.txt" ]] \
	|| fail "derived text path mismatch: ${derived}"
printf '%s' "${derived}" | field "d['content']" | grep -q "rinnova" \
	|| fail "derived text must carry the PDF sentence: ${derived}"
missing="$(curl -sS --max-time 120 -o /dev/null -w '%{http_code}' -H "Cookie: better-auth.session_token=${TOKEN3}" \
	"${BASE}/u/${USER3}/text?docId=doc_nosuch")"
[[ "${missing}" == "404" ]] || fail "a docId without derived text must 404, got ${missing}"
pass "GET /text serves extracted PDF text and 404s without one"

pdf_reply="$(curl -fsS --max-time 120 -X POST -H "Cookie: better-auth.session_token=${TOKEN2}" \
	-H 'content-type: application/json' \
	-d "{\"prompt\":\"When does the uploaded contract renew?\",\"requestId\":\"pdf-${RUN_ID}\",\"citations\":\"required\"}" \
	"${BASE}/u/${USER2}/prompt")" || fail "PDF strict prompt failed: ${pdf_reply:-}"
[[ "$(printf '%s' "${pdf_reply}" | field "d['status']")" == "done" ]] || fail "PDF strict run not done: ${pdf_reply}"
[[ "$(printf '%s' "${pdf_reply}" | field "d['evidence']")" == "cited" ]] \
	|| fail "PDF run is not cited (grep did not see the derived text?): ${pdf_reply}"
[[ "$(printf '%s' "${pdf_reply}" | field "d['citations'][0]['docId']")" == u-* ]] \
	|| fail "citation does not point at the uploads-tree docId: ${pdf_reply}"
[[ "$(printf '%s' "${pdf_reply}" | field "d['citations'][0]['title']")" == "persona-finanza/contratto.pdf" ]] \
	|| fail "uploads-tree title is not the tree path: ${pdf_reply}"
[[ "$(printf '%s' "${pdf_reply}" | field "d['citations'][0]['quote']")" == *rinnova* ]] \
	|| fail "quote does not come from the derived text: ${pdf_reply}"
[[ "$(printf '%s' "${pdf_reply}" | field "d['citations'][0]['status']")" == "attribution_verified" ]] \
	|| fail "PDF citation is not verified: ${pdf_reply}"
pass "strict citation published from the uploads-tree PDF's extracted text"
rm -f "${PDF_FIXTURE}"

echo
echo "CITATIONS E2E PASSED"

echo "== RFC 0014 a: a strict prompt against a /ingest-staged PDF cites its derived text =="
USER4="citeraw-${RUN_ID}"
TOKEN4="tok-${USER4}"
seed_session "${USER4}" "${TOKEN4}"
COOKIE4="better-auth.session_token=${TOKEN4}"
PDF_RAW_FIXTURE="$(mktemp /tmp/contratto-raw-XXXX.pdf)"
{
	printf '%%PDF-1.4\n'
	printf '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
	printf '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
	printf '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n'
	printf '4 0 obj<</Length 74>>stream\nBT /F1 24 Tf 72 720 Td (Il contratto si rinnova il 1 marzo 2027) Tj ET\nendstream endobj\n'
	printf '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n'
	printf 'trailer<</Root 1 0 R>>'
} >"${PDF_RAW_FIXTURE}"
staged_raw_pdf="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE4}" \
	-H 'content-type: application/pdf' \
	--data-binary @"${PDF_RAW_FIXTURE}" \
	"${BASE}/u/${USER4}/ingest?docId=doc_pdfraw&filename=contratto.pdf")" \
	|| fail "raw PDF ingest through caddy failed"
[[ "$(printf '%s' "${staged_raw_pdf}" | field "d['searchable']")" == "True" ]] \
	|| fail "the raw PDF ingest must report searchable=True: ${staged_raw_pdf}"
[[ "$(printf '%s' "${staged_raw_pdf}" | field "d['indexing']")" == "derived" ]] \
	|| fail "the raw PDF ingest must report indexing=derived: ${staged_raw_pdf}"
pass "raw PDF staged through /ingest with derived admission"

raw_pdf_reply="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE4}" \
	-H 'content-type: application/json' \
	-d "{\"prompt\":\"When does the uploaded contract renew?\",\"requestId\":\"rawpdf-${RUN_ID}\",\"citations\":\"required\"}" \
	"${BASE}/u/${USER4}/prompt")" || fail "raw PDF strict prompt failed: ${raw_pdf_reply:-}"
[[ "$(printf '%s' "${raw_pdf_reply}" | field "d['status']")" == "done" ]] || fail "raw PDF strict run not done: ${raw_pdf_reply}"
[[ "$(printf '%s' "${raw_pdf_reply}" | field "d['evidence']")" == "cited" ]] \
	|| fail "raw PDF run is not cited (the index read the raw bytes?): ${raw_pdf_reply}"
[[ "$(printf '%s' "${raw_pdf_reply}" | field "d['citations'][0]['docId']")" == "doc_pdfraw" ]] \
	|| fail "citation does not point at the raw docId: ${raw_pdf_reply}"
[[ "$(printf '%s' "${raw_pdf_reply}" | field "d['citations'][0]['quote']")" == *rinnova* ]] \
	|| fail "quote does not come from the derived text: ${raw_pdf_reply}"
pass "strict citation published from a /ingest-staged PDF's derived text"

echo "== RFC 0014 b: the same fixture through both entry points, one admission =="
staged_tree_pdf="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE4}" \
	-H 'content-type: application/pdf' \
	--data-binary @"${PDF_RAW_FIXTURE}" \
	"${BASE}/u/${USER4}/uploads/file?path=persona-finanza/contratto.pdf")" \
	|| fail "uploads PDF staging through caddy failed"
[[ "$(printf '%s' "${staged_tree_pdf}" | field "d['indexing']")" == "$(printf '%s' "${staged_raw_pdf}" | field "d['indexing']")" ]] \
	|| fail "the same PDF through both entry points must report the same indexing: ${staged_raw_pdf} vs ${staged_tree_pdf}"
[[ "$(printf '%s' "${staged_tree_pdf}" | field "d['docId']")" == u-* ]] \
	|| fail "uploads staging must report the tree docId: ${staged_tree_pdf}"
tree_pdf_reply="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE4}" \
	-H 'content-type: application/json' \
	-d "{\"prompt\":\"When does the uploaded contract renew?\",\"requestId\":\"treepdf-${RUN_ID}\",\"citations\":\"required\"}" \
	"${BASE}/u/${USER4}/prompt")" || fail "uploads PDF strict prompt failed: ${tree_pdf_reply:-}"
[[ "$(printf '%s' "${tree_pdf_reply}" | field "d['evidence']")" == "cited" ]] \
	|| fail "uploads PDF run is not cited: ${tree_pdf_reply}"
[[ "$(printf '%s' "${tree_pdf_reply}" | field "d['citations'][0]['quote']")" == *rinnova* ]] \
	|| fail "uploads PDF quote does not come from the derived text: ${tree_pdf_reply}"
pass "the same sentence is citable from both entry points"

echo "== RFC 0014 c: a scanned PDF is staged, listed, and never evidence =="
# A user whose corpus is ONLY the scanned PDF: nothing is greppable, so the
# scripted strict run must exit through UNANSWERED/answer_plain, never a citation.
USER5="citescan-${RUN_ID}"
TOKEN5="tok-${USER5}"
seed_session "${USER5}" "${TOKEN5}"
COOKIE5="better-auth.session_token=${TOKEN5}"
SCAN_FIXTURE="$(mktemp /tmp/contratto-scan-XXXX.pdf)"
printf 'not a real pdf: no text layer' >"${SCAN_FIXTURE}"
staged_scan="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE5}" \
	-H 'content-type: application/pdf' \
	--data-binary @"${SCAN_FIXTURE}" \
	"${BASE}/u/${USER5}/ingest?docId=doc_scan&filename=scansione.pdf")" \
	|| fail "scanned PDF ingest failed"
[[ "$(printf '%s' "${staged_scan}" | field "d['searchable']")" == "False" ]] \
	|| fail "the scanned PDF must report searchable=False: ${staged_scan}"
[[ "$(printf '%s' "${staged_scan}" | field "d['indexing']")" == "none" ]] \
	|| fail "the scanned PDF must report indexing=none: ${staged_scan}"
tree_listed="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE5}" "${BASE}/u/${USER5}/raw?docId=doc_scan&filename=scansione.pdf")" \
	|| fail "the scanned PDF must stay readable as staged bytes"
scan_reply="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE5}" \
	-H 'content-type: application/json' \
	-d "{\"prompt\":\"When does the maintenance contract renew?\",\"requestId\":\"scan-${RUN_ID}\",\"citations\":\"required\"}" \
	"${BASE}/u/${USER5}/prompt")" || fail "scanned PDF strict prompt failed: ${scan_reply:-}"
[[ "$(printf '%s' "${scan_reply}" | field "d['citations']")" == "[]" ]] \
	|| fail "a scanned PDF must never produce a citation: ${scan_reply}"
[[ "$(printf '%s' "${scan_reply}" | field "d['evidence']")" != "cited" ]] \
	|| fail "a strict run over an unindexable corpus must not publish evidence: ${scan_reply}"
pass "a scanned PDF never becomes evidence; the strict run exits without citations"

echo "== RFC 0014 d: a strict run refuses the workspace tools with a named block =="
gate_reply="$(curl -fsS --max-time 120 -X POST -H "Cookie: ${COOKIE4}" \
	-H 'content-type: application/json' \
	-d "{\"prompt\":\"When does the maintenance contract renew? Check with bash first.\",\"requestId\":\"gate-${RUN_ID}\",\"citations\":\"required\"}" \
	"${BASE}/u/${USER4}/prompt")" || fail "strict gate prompt failed: ${gate_reply:-}"
[[ "$(printf '%s' "${gate_reply}" | field "d['status']")" == "done" ]] || fail "strict gate run not done: ${gate_reply}"
[[ "$(printf '%s' "${gate_reply}" | field "d['evidence']")" == "cited" ]] \
	|| fail "the blocked bash must redirect to the corpus tools: ${gate_reply}"
blocked_entry="$(printf '%s' "$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE4}" \
	"${BASE}/u/${USER4}/inspect?limit=60")" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for e in d['entries']['items']:
    if e.get('role') == 'toolResult' and e.get('toolName') == 'bash' and e.get('isError'):
        print(e['id']); break
else:
    print('')")"
[[ -n "${blocked_entry}" ]] || fail "the refused bash call is not in the trace: ${gate_reply}"
blocked_detail="$(curl -fsS --max-time 120 -H "Cookie: ${COOKIE4}" "${BASE}/u/${USER4}/entry?id=${blocked_entry}")"
printf '%s' "${blocked_detail}" | grep -q "disabled in this strict-citations run" \
	|| fail "the bash block must name the corpus tools: ${blocked_detail}"
printf '%s' "${blocked_detail}" | grep -q "corpus_grep" \
	|| fail "the bash block must point at corpus_grep: ${blocked_detail}"
pass "the strict run blocked bash with the named block and published through the corpus tools"

echo
echo "RFC 0014 CITATIONS E2E PASSED"
