#!/usr/bin/env bash
# Shared helpers for the e2e checks. Sourced by the scripts in this directory.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "${E2E_DIR}")"
HOST_PORT="${HOST_PORT:-18080}"
BASE="http://localhost:${HOST_PORT}"
COMPOSE=(docker compose -f "${ROOT}/docker-compose.yml")
RUN_ID="$(date +%s)-$$"

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; exit 1; }

# Read a JSON field: field "d['agent']"
field() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

# Query the sandbox registry via the oltp service.
sql() { "${COMPOSE[@]}" exec -T oltp psql -U pi -d pi -v ON_ERROR_STOP=1 -tA "$@"; }

# The Web Client (better-auth) is not part of this repo, so seed the session row
# the manager validates the cookie against. Caddy, the manager, Postgres and the
# sandbox agents are the real components.
seed_session() {
	local user_id="$1" token="$2"
	sql >/dev/null <<SQL
CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY,
  "userId" text NOT NULL,
  "token" text NOT NULL UNIQUE,
  "expiresAt" timestamptz NOT NULL
);
INSERT INTO "session" ("id", "userId", "token", "expiresAt")
VALUES ('sess-${user_id}', '${user_id}', '${token}', now() + interval '1 hour')
ON CONFLICT ("id") DO UPDATE SET "token" = EXCLUDED."token", "expiresAt" = EXCLUDED."expiresAt";
SQL
}

wait_ready() {
	for _ in $(seq 1 60); do
		if curl -fsS --max-time 2 "${BASE}/" >/dev/null 2>&1; then return 0; fi
		sleep 1
	done
	fail "caddy is not reachable at ${BASE}"
}
