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
