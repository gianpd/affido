#!/usr/bin/env bash
# Concurrency: three users -> three sandbox agents reply to three Caddy
# requests at the same time. Each user cold-provisions its own container, so
# the concurrent interval also covers parallel manager provisioning.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

wait_ready

USERS=()
TOKENS=()
for i in 1 2 3; do
	uid="par${i}-${RUN_ID}"
	token="tok-${uid}"
	seed_session "${uid}" "${token}"
	USERS[$i]="${uid}"
	TOKENS[$i]="${token}"
done
pass "seeded 3 sessions (${USERS[1]}, ${USERS[2]}, ${USERS[3]})"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "== 3 concurrent POST /u/<user>/prompt through caddy =="
for i in 1 2 3; do
	(
		started="$(date +%s%3N)"
		code=0
		curl -fsS --max-time 180 \
			-H "Cookie: better-auth.session_token=${TOKENS[$i]}" \
			-H 'content-type: application/json' \
			-d "{\"prompt\":\"list the files\",\"requestId\":\"par-${i}-${RUN_ID}\"}" \
			"${BASE}/u/${USERS[$i]}/prompt" >"${TMP}/${i}.json" 2>"${TMP}/${i}.err" || code=$?
		finished="$(date +%s%3N)"
		printf '%s %s %s\n' "${code}" "${started}" "${finished}" >"${TMP}/${i}.timing"
	) &
done
wait || true

CONTAINERS=()
for i in 1 2 3; do
	read -r code started finished <"${TMP}/${i}.timing"
	[[ "${code}" == "0" ]] || fail "request ${i} failed (curl ${code}): $(cat "${TMP}/${i}.err")"
	[[ "$(printf '%s' "$(cat "${TMP}/${i}.json")" | field "d['status']")" == "done" ]] \
		|| fail "request ${i} did not finish: $(cat "${TMP}/${i}.json")"
	[[ "$(printf '%s' "$(cat "${TMP}/${i}.json")" | field "d['answer']")" == *"notes.txt"* ]] \
		|| fail "request ${i} did not read its workspace: $(cat "${TMP}/${i}.json")"
	container="$(sql -c "SELECT container_name FROM sandbox_registry WHERE user_id = '${USERS[$i]}'")"
	[[ "$(printf '%s' "$(cat "${TMP}/${i}.json")" | field "d['agent']")" == "${container}" ]] \
		|| fail "request ${i} was answered by the wrong agent: $(cat "${TMP}/${i}.json")"
	[[ "$(docker inspect -f '{{.State.Running}}' "${container}")" == "true" ]] \
		|| fail "${container} is not running"
	CONTAINERS[$i]="${container}"
	printf '     req %s: %s ms from %s\n' "${i}" "$(( finished - started ))" "${container}"
done

[[ "${CONTAINERS[1]}" != "${CONTAINERS[2]}" && "${CONTAINERS[1]}" != "${CONTAINERS[3]}" && "${CONTAINERS[2]}" != "${CONTAINERS[3]}" ]] \
	|| fail "users share a sandbox: ${CONTAINERS[1]} ${CONTAINERS[2]} ${CONTAINERS[3]}"
pass "3 distinct sandbox agents answered (${CONTAINERS[1]}, ${CONTAINERS[2]}, ${CONTAINERS[3]})"

# The rows may already show 'idle_paused': the gate stack evicts aggressively
# (IDLE_GRACE_S=EVICT_TICK_S=2s), and the per-user queries above cost seconds of
# docker-CLI latency. The invariant under test is one live sandbox per user —
# the containers' Running state was asserted per user above.
[[ "$(sql -c "SELECT count(*) FROM sandbox_registry WHERE status IN ('running','idle_paused') AND user_id IN ('${USERS[1]}','${USERS[2]}','${USERS[3]}')")" == "3" ]] \
	|| fail "the registry does not show 3 live sandboxes"

python3 - "${TMP}" <<'PY' || fail "the three request intervals do not overlap (not concurrent)"
import glob, os, sys
timings = [open(p).read().split() for p in glob.glob(os.path.join(sys.argv[1], "*.timing"))]
starts = [int(t[1]) for t in timings]
ends = [int(t[2]) for t in timings]
sys.exit(0 if max(starts) < min(ends) else 1)
PY
pass "all three request intervals overlap in time (concurrent responses)"

echo
echo "PARALLEL TEST PASSED"
