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

# Read one manager environment variable, for the values the e2e must agree on.
manager_env() { "${COMPOSE[@]}" exec -T sandbox-manager printenv "$1" | tr -d '\r'; }

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

# The web app owns the better-auth tables (frontend/drizzle); the compose stack
# has no web app, so the identity e2e creates the three tables that surface
# writes. Shape mirrors frontend/src/lib/server/db/auth.schema.ts. IF NOT
# EXISTS everywhere: the seeded `session` table already exists with four
# columns and the extra columns are added, exactly like the Drizzle migration.
ensure_auth_tables() {
	# If the web app already migrated this DB, leave its tables alone. If the
	# e2e creates them, identity.sh drops them on exit so a later
	# `pnpm db:migrate` still starts from a clean schema.
	local have_user have_account
	have_user="$(sql -c "SELECT to_regclass('public.\"user\"') IS NOT NULL")"
	have_account="$(sql -c "SELECT to_regclass('public.\"account\"') IS NOT NULL")"
	AUTH_TABLES_CREATED=0
	if [[ "${have_user}" != "t" && "${have_account}" != "t" ]]; then
		AUTH_TABLES_CREATED=1
	fi
	sql >/dev/null <<'SQL'
SET client_min_messages TO warning;
CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "emailVerified" boolean DEFAULT false NOT NULL,
  "image" text,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_email_unique" ON "user" ("email");
CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamp,
  "refreshTokenExpiresAt" timestamp,
  "scope" text,
  "password" text,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");
CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "token" text NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL
);
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "createdAt" timestamp DEFAULT now() NOT NULL;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "updatedAt" timestamp DEFAULT now() NOT NULL;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "ipAddress" text;
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "userAgent" text;
CREATE UNIQUE INDEX IF NOT EXISTS "session_token_unique" ON "session" ("token");
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
SQL
}

wait_ready() {
	for _ in $(seq 1 60); do
		if curl -fsS --max-time 2 "${BASE}/" >/dev/null 2>&1; then return 0; fi
		sleep 1
	done
	fail "caddy is not reachable at ${BASE}"
}
