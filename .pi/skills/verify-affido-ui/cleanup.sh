#!/usr/bin/env bash
# Teardown for verify-affido-ui runs. Removes the scratch state a run created:
#   - the frontend dev server started by the skill (via /tmp/affido-ui-dev.pid)
#   - per-verify-user sandbox container, pi-ws-*/pi-data-* volumes, pi-net-* network
#   - all DB rows belonging to verify users (auth, documents, traces, registry)
# Evidence under verify-runs/ is NEVER touched.
#
# Usage: cleanup.sh [runDir ...]   (no args: every verify-runs/*/credentials.json)
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SKILL_DIR}/../../.." && pwd)"
cd "${ROOT}"

say() { printf 'cleanup: %s\n' "$1"; }

sql() { docker exec -i oltp psql -U pi -d pi -v ON_ERROR_STOP=1 -tA "$@"; }

# Dev server: kill only what the skill started (pid file + it is a node/vite process).
if [[ -f /tmp/affido-ui-dev.pid ]]; then
	pid="$(cat /tmp/affido-ui-dev.pid)"
	if kill -0 "${pid}" 2>/dev/null && tr '\0' ' ' <"/proc/${pid}/cmdline" 2>/dev/null | grep -q 'node\|vite\|pnpm'; then
		kill "${pid}" && say "stopped dev server pid ${pid}"
	else
		say "dev server pid ${pid} not running (or not ours), skipping"
	fi
	rm -f /tmp/affido-ui-dev.pid
fi

# Collect verify-user emails from run dirs.
declare -a RUNS=()
if (($#)); then RUNS=("$@"); else
	while IFS= read -r f; do RUNS+=("$(dirname "${f}")"); done < <(find verify-runs -name credentials.json -type f 2>/dev/null || true)
fi
((${#RUNS[@]})) || { say "no run dirs with credentials.json; nothing to do"; exit 0; }

# The manager's slug(): sandbox_manager.py. Used when the registry row is gone
# (run never reached the sandbox) but leftover volumes might still exist.
slug() { python3 -c '
import hashlib, re, sys
user_id = sys.argv[1]
digest = hashlib.sha1(user_id.encode()).hexdigest()[:12]
clean = re.sub(r"[^a-zA-Z0-9_.-]", "-", user_id)[:32].strip("-") or "user"
if not clean[0].isalnum(): clean = "u" + clean
print(f"{clean}-{digest}")
' "$1"; }

for run in "${RUNS[@]}"; do
	cred="${run}/credentials.json"
	[[ -f ${cred} ]] || { say "no credentials.json in ${run}, skipping"; continue; }
	email="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["email"])' "${cred}")"
	uid="$(sql -c "SELECT id FROM \"user\" WHERE email = '${email}'")"
	if [[ -z ${uid} ]]; then
		sql >/dev/null -c "DELETE FROM verification WHERE identifier = '${email}'"
		say "no user row for ${email} (cleaned verification rows if any)"
		continue
	fi

	# Sandbox resources: prefer the registry row (authoritative names).
	row="$(sql -c "SELECT container_name || '|' || coalesce(workspace_vol,'') || '|' || coalesce(data_vol,'') FROM sandbox_registry WHERE user_id = '${uid}'")"
	if [[ -n ${row} && ${row} != "||" ]]; then
		IFS='|' read -r container wsvol datvol <<<"${row}"
		# Older registry rows may have empty volume columns: derive from the
		# container name (container = "u" + slug, volumes = pi-ws-<slug>/pi-data-<slug>).
		if [[ -z ${wsvol} ]]; then wsvol="pi-ws-${container#u}"; fi
		if [[ -z ${datvol} ]]; then datvol="pi-data-${container#u}"; fi
	else
		s="$(slug "${uid}")"; container="u${s}"; wsvol="pi-ws-${s}"; datvol="pi-data-${s}"
	fi
	docker rm -f "${container}" >/dev/null 2>&1 && say "removed container ${container}" || say "container ${container} already gone"
	docker volume rm "${wsvol}" "${datvol}" >/dev/null 2>&1 && say "removed volumes ${wsvol} ${datvol}" || say "volumes already gone"
	docker network rm "pi-net-${container#u}" >/dev/null 2>&1 && say "removed network pi-net-${container#u}" || true

	# DB rows, dependency-safe order (corpus_document cascades with corpus).
	sql >/dev/null <<SQL
DELETE FROM corpus_document WHERE "documentId" IN (SELECT id FROM document WHERE "userId" = '${uid}');
DELETE FROM chat_message WHERE "userId" = '${uid}';
DELETE FROM ingest_event WHERE "userId" = '${uid}';
DELETE FROM document WHERE "userId" = '${uid}';
DELETE FROM corpus WHERE "userId" = '${uid}';
DELETE FROM trace_session WHERE "userId" = '${uid}';
DELETE FROM sandbox_registry WHERE user_id = '${uid}';
DELETE FROM session WHERE "userId" = '${uid}';
DELETE FROM account WHERE "userId" = '${uid}';
DELETE FROM verification WHERE identifier = '${email}';
DELETE FROM "user" WHERE id = '${uid}';
SQL
	say "deleted DB rows for ${email}"
done

say "done (evidence in verify-runs/ untouched)"
