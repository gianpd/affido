#!/usr/bin/env bash
# Single local-development entry point for the control plane.
#
# Sandbox agents are NOT compose services: the manager creates them on demand
# from AGENT_IMAGE (see create_args() in sandbox-manager/sandbox_manager.py).
# The manager stack runs one image, affido-agent:latest: the keyless faux
# provider is the default, and users who want a real model bring their own key
# through the manager's /providers API (RFC 0012 BYOK). Real providers need
# AGENT_EGRESS=open in .env (stack-level, fail-closed at setup otherwise).
#
# Usage:
#   ./dev.sh up [--no-build] [--dry-run]
#   ./dev.sh reload [--no-build] [--dry-run]
#   ./dev.sh build [--dry-run]
#   ./dev.sh down
#   ./dev.sh reset [--yes]
#   ./dev.sh secrets
#   ./dev.sh status
#
# `reload` is the edit-test loop for agent code: rebuild the images, refresh the
# control plane, then remove the sandbox containers so the next request
# re-provisions them from the new image. The Postgres volume, pi-ws-<user> and
# pi-data-<user> are never touched, so documents, workspaces and sessions stay
# durable. `reset` remains the only command that deletes data. With `--no-build`
# reload keeps the current images and only recreates the containers.
#
# Secrets are never passed as compose environment for the agents:
#   .env                        -> compose interpolation, control plane only
#   secrets/llm_key_kek         -> 32-byte KEK (base64 ok), mounted read-only
#                                  into the manager only; encrypts the users'
#                                  BYOK provider keys at rest
#   ENV THINKING_LEVEL          -> reasoning effort requested from the provider,
#                                  empty keeps the runtime off
#
# The operator openrouter flow (--provider openrouter: one shared plaintext
# key mounted into every sandbox) was removed by RFC 0012 §4: the manager no
# longer mounts host secrets into sandboxes. Running the agent image standalone
# still reads /run/secrets (agent/model.ts); see README "Use a real model".
#
# Gate for the whole stack remains ./verify.sh (typecheck, unit tests, e2e).
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(pwd)"
PROJECT="affido"
BASE_IMAGE="affido-agent:latest"
BUILD=1
DRY_RUN=0
ASSUME_YES=0
TMPDIRS=()
trap 'rm -rf "${TMPDIRS[@]}"' EXIT

usage() { sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
pass() { printf 'ok   %s\n' "$1"; }
warn() { printf 'WARN %s\n' "$1" >&2; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }
run() {
	if ((DRY_RUN)); then printf '     + %s\n' "$*"; return 0; fi
	# Commands print their own progress (compose) or ids (build) on stdout;
	# dev.sh reports the outcome itself.
	"$@" >/dev/null
}

load_env() {
	# Compose reads .env itself; THINKING_LEVEL and AGENT_EGRESS are read here
	# too (summary, compose_up).
	if [[ -f .env ]]; then
		set -a
		# shellcheck disable=SC1091
		. ./.env
		set +a
	fi
}

need_docker() {
	docker info >/dev/null 2>&1 || fail "docker daemon not reachable"
}

image_exists() { docker image inspect "$1" >/dev/null 2>&1; }

agent_image() {
	printf '%s' "${BASE_IMAGE}"
}

ensure_kek() {
	# RFC 0012 §5.2: compose mounts this file read-only into the manager only.
	# Docker would turn a missing file into a directory at that path, so it must
	# exist before any `up`; without it every BYOK key write fails closed with
	# kek_unavailable (the keyless faux default is unaffected).
	if [ ! -f "${ROOT}/secrets/llm_key_kek" ]; then
		umask 077
		mkdir -p "${ROOT}/secrets"
		openssl rand -base64 32 > "${ROOT}/secrets/llm_key_kek"
		pass "created secrets/llm_key_kek (BYOK KEK; back it up: keys are unrecoverable without it)"
	fi
}

ensure_manager_token() {
	# Pentest W1 (2026-10): the compose fallback `dev-manager-token` is a
	# well-known constant, and the manager's bridge IP answers any host process
	# without root — with the default, a local process can pause, resolve as, or
	# read any tenant. Generate a random per-stack token into .env (compose
	# interpolation feeds the same value to caddy and the manager); the manager
	# also refuses the known default at startup (sandbox_manager.py,
	# enforce_token_default) as the second, independent layer.
	if ! grep -q '^MANAGER_TOKEN=' "${ROOT}/.env" 2>/dev/null; then
		if ((DRY_RUN)); then
			printf '     + generate MANAGER_TOKEN into .env\n'
			return 0
		fi
		# The operator's .env may lack a trailing newline: prepend one or the
		# token glues onto the last line and both settings break.
		if [ -f "${ROOT}/.env" ] && [ -n "$(tail -c 1 "${ROOT}/.env" 2>/dev/null)" ]; then
			printf '\n' >> "${ROOT}/.env"
		fi
		printf 'MANAGER_TOKEN=%s\n' "$(openssl rand -hex 24)" >> "${ROOT}/.env"
		chmod 600 "${ROOT}/.env"
		pass "created MANAGER_TOKEN in .env (random per stack; rotate by editing .env + ./dev.sh up)"
	fi
}

build_base() {
	if ((BUILD)) || ! image_exists "${BASE_IMAGE}"; then
		echo "== build ${BASE_IMAGE} =="
		run docker build -q -t "${BASE_IMAGE}" ./agent
		((DRY_RUN)) || pass "${BASE_IMAGE} built"
	fi
}

warn_stale_sandboxes() {
	local want="$1" id img stale=0
	# Sandbox env is fixed at `docker create`: a provider switch only affects
	# sandboxes created after it. Stopped (L1) sandboxes count too.
	while read -r id; do
		[[ -n "${id}" ]] || continue
		img="$(docker inspect -f '{{.Config.Image}}' "${id}" 2>/dev/null || true)"
		if [[ "${img}" != "${want}" ]]; then
			warn "sandbox ${id} still runs ${img:-unknown}"
			stale=1
		fi
	done < <(docker ps -aq --filter label=pi-sandbox-manager=1)
	((stale)) && warn "run ./dev.sh reload to reprovision from ${want} (volumes kept)"
	return 0
}

summary() {
	echo
	printf 'agent image  %s\n' "$(agent_image)"
	printf 'default      keyless faux provider; real models via BYOK (Settings -> AI provider)\n'
	printf 'byok kek     %s\n' "$([ -f "${ROOT}/secrets/llm_key_kek" ] && echo "${ROOT}/secrets/llm_key_kek (mounted into the manager only)" || echo "MISSING: BYOK key writes fail closed")"
printf 'manager key  %s\n' "$(grep -q '^MANAGER_TOKEN=' "${ROOT}/.env" 2>/dev/null && echo 'MANAGER_TOKEN in .env (random per stack)' || echo 'MISSING: manager refuses the dev-manager-token default')"
	printf 'egress       %s (BYOK with a real provider needs open)\n' "${AGENT_EGRESS:-off}"
	printf 'thinking     %s (empty means off)\n' "${THINKING_LEVEL:-off}"
	printf 'control plane caddy :18080, oltp :%s, sandbox-manager (no host port)\n' "${OLTP_PORT:-15432}"
	printf 'secrets map  see ./dev.sh secrets\n'
}

wait_oltp() {
	# On a fresh volume the healthcheck can pass against initdb's temporary
	# server, so compose may report healthy while the real one still logs
	# "database system is starting up". Wait for an actual query.
	local _
	for _ in $(seq 1 60); do
		docker compose exec -T oltp psql -U pi -d pi -tAc 'select 1' >/dev/null 2>&1 \
			&& return 0
		sleep 1
	done
	fail "oltp did not accept queries within 60s"
}

require_override() {
	# Base compose hardcodes AGENT_IMAGE; the override is where AGENT_IMAGE is
	# forwarded to the manager.
	[[ -f docker-compose.override.yml ]] \
		|| fail "docker-compose.override.yml is missing: it forwards AGENT_IMAGE"
}

compose_up() {
	local image
	image="$(agent_image)"
	ensure_kek
	ensure_manager_token

	echo "== docker compose up =="
	local compose_args=(up -d)
	((BUILD)) && compose_args+=(--build)
	# Explicit env defeats docker-compose.override.yml defaults. AGENT_EGRESS
	# comes from the environment (default off): only a stack whose users bring
	# real-provider keys needs open (RFC 0012 §5.5).
	if ((DRY_RUN)); then
		printf '     + AGENT_IMAGE=%s AGENT_EGRESS=%s docker compose %s\n' \
			"${image}" "${AGENT_EGRESS:-off}" "${compose_args[*]}"
	else
		AGENT_IMAGE="${image}" AGENT_EGRESS="${AGENT_EGRESS:-off}" \
			docker compose "${compose_args[@]}" >/dev/null
	fi
	if ((DRY_RUN)); then pass "dry run: nothing executed"
	else
		pass "control plane up"
		wait_oltp
		pass "oltp accepts queries"
	fi
}

cmd_up() {
	need_docker
	load_env
	require_override
	build_base
	warn_stale_sandboxes "$(agent_image)"
	compose_up
	summary
}

# Remove the sandbox containers, never their volumes. `provision()` in the
# manager creates the named volumes idempotently, so the next request mounts the
# same pi-ws-<user> (workspace, corpus) and pi-data-<user> (session.sqlite).
recreate_sandboxes() {
	local ids nets
	ids="$(docker ps -aq --filter label=pi-sandbox-manager=1 || true)"
	if [[ -z "${ids}" ]]; then
		pass "no sandbox containers to recreate"
	else
		# shellcheck disable=SC2086
		run docker rm -f ${ids}
		((DRY_RUN)) || pass "sandboxes removed: next request re-provisions from $(agent_image)"
	fi
	# Networks are part of the sandbox envelope, not user state: remove them too
	# so re-provisioning picks up current network_create_args() (e.g. --internal).
	# Per-user volumes (pi-ws-*, pi-data-*) are never touched here.
	nets="$(docker network ls -q --filter label=pi-sandbox-manager=1 || true)"
	if [[ -n "${nets}" ]]; then
		# Guests (caddy/manager/web) stay attached after the sandboxes are gone;
		# disconnect them or the network remove is refused.
		for net in ${nets}; do
			for guest in $(docker network inspect -f \
				'{{range .Containers}}{{.Name}} {{end}}' "${net}" 2>/dev/null); do
				run docker network disconnect -f "${net}" "${guest}"
			done
			run docker network rm "${net}"
		done
		((DRY_RUN)) || pass "sandbox networks removed: recreated on next resolve"
	fi
}

cmd_reload() {
	need_docker
	load_env
	require_override
	build_base
	compose_up
	recreate_sandboxes
	summary
	((DRY_RUN)) || printf '\nagent code is live; sessions and uploads kept (postgres volume untouched)\n'
}

cmd_build() {
	need_docker
	load_env
	agent_image >/dev/null # validates the provider
	build_base
	pass "${BASE_IMAGE} ready (faux default; real models via BYOK)"
}

cmd_down() {
	need_docker
	# Per-user sandboxes and their volumes survive, by design.
	echo "== docker compose down (sandboxes keep their state) =="
	run docker compose down --remove-orphans
	pass "control plane stopped"
}

cmd_reset() {
	need_docker
	if ((!ASSUME_YES && !DRY_RUN)); then
		[[ -t 0 ]] || fail "reset is destructive; pass --yes in a non-interactive shell"
		local answer
		read -r -p "Remove every ${PROJECT} container, volume and agent image? [y/N] " answer
		[[ "${answer}" == y || "${answer}" == Y || "${answer}" == yes ]] || fail "aborted"
	fi

	echo "== control plane: containers, networks, compose volumes =="
	run docker compose down -v --remove-orphans || true

	echo "== sandboxes: containers, networks, per-user volumes =="
	local ids nets vols
	ids="$(docker ps -aq --filter label=pi-sandbox-manager=1 || true)"
	# shellcheck disable=SC2086
	[[ -n "${ids}" ]] && run docker rm -f ${ids} >/dev/null
	nets="$(docker network ls -q --filter label=pi-sandbox-manager=1 || true)"
	# shellcheck disable=SC2086
	[[ -n "${nets}" ]] && run docker network rm ${nets} >/dev/null
	vols="$(docker volume ls -q | grep -E '^pi-(ws|data)-' || true)"
	# shellcheck disable=SC2086
	[[ -n "${vols}" ]] && run docker volume rm -f ${vols} >/dev/null
	vols="$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" || true)"
	# shellcheck disable=SC2086
	[[ -n "${vols}" ]] && run docker volume rm -f ${vols} >/dev/null

	echo "== images =="
	run docker image rm -f "${BASE_IMAGE}" >/dev/null 2>&1 || true
	pass "reset done: next ./dev.sh up rebuilds from zero"
}

cmd_secrets() {
	load_env
	cat <<'TXT'
Where each value comes from, and where it lands.

.env (gitignored; docker compose interpolates it into the control plane)
  MANAGER_TOKEN      shared secret for Caddy forward_auth <-> manager HTTP API;
                     generated randomly by ./dev.sh up|reload and verify.sh when
                     missing. The manager refuses the well-known compose default
                     (dev-manager-token) at startup; MANAGER_ALLOW_DEFAULT_TOKEN=1
                     is the explicit opt-in for throwaway stacks
  STOP_AFTER_S       L1 stop threshold for a paused sandbox
  EVICT_TICK_S       manager eviction/reconcile tick
  AGENT_IDLE_MS      in-process idle pause threshold inside the agent
  OLTP_PORT          host port for the control-plane Postgres
  WEB_CONTAINER      optional compose container joined to every sandbox network
  AGENT_EGRESS       off (default) or open; BYOK with a real provider needs open
  THINKING_LEVEL     reasoning effort forwarded to the agent at create time

secrets/ (gitignored host dir; only llm_key_kek is mounted, into the manager)
  llm_key_kek        32-byte KEK (raw or base64) -> /run/secrets/llm_key_kek in
                     the sandbox-manager only. Encrypts the users' BYOK provider
                     keys (AES-256-GCM, RFC 0012 §5.2). Keys are unrecoverable
                     without it; rotate by re-encrypting, never by deleting rows.

BYOK user keys never touch this host: a user's API key is POSTed through Caddy
to the manager (/providers/config), stored encrypted in Postgres, and delivered
to the running agent's memory at resolve time (POST /config). It is never in a
URL, a log, docker inspect, /proc/1/environ, the agent filesystem, or any GET.

Standalone agent runs (no manager) keep the secret-file branch of
agent/model.ts: `docker run -e OPENROUTER_MODEL=<id> -v $PWD/secrets:/run/secrets
affido-agent:latest` reads openrouter_api_key/openai_api_key at boot.
TXT
	echo
	echo "== BYOK readiness =="
	if [ -f "${ROOT}/secrets/llm_key_kek" ]; then
		printf 'present  secrets/llm_key_kek
'
	else
		printf 'missing  secrets/llm_key_kek (./dev.sh up creates one; BYOK key writes fail closed without it)\n'
	fi
	if [[ "${AGENT_EGRESS:-off}" == "open" ]]; then
		printf 'present  AGENT_EGRESS=open (real providers can reach the internet)\n'
	else
		printf 'off      AGENT_EGRESS (custom endpoints and catalog providers are refused at setup)\n'
	fi
}

cmd_status() {
	need_docker
	echo "== control plane =="
	docker compose ps
	echo
	echo "== sandboxes (manager-owned) =="
	docker ps -a --filter label=pi-sandbox-manager=1 \
		--format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' || true
	echo
	echo "== volumes =="
	docker volume ls --filter "label=com.docker.compose.project=${PROJECT}" --format 'table {{.Name}}\t{{.Driver}}'
	printf 'pi-user volumes: %s\n' "$(docker volume ls -q | grep -cE '^pi-(ws|data)-' || true)"
}

CMD="${1:-}"
[[ -n "${CMD}" ]] && shift || true

case "${CMD}" in
	up|reload|build|reset|secrets)
		while (($#)); do
			case "$1" in
				--provider*)
					# Explicit error, not a silent faux degradation: the manager no
					# longer mounts host secrets (RFC 0012 §4).
					fail "--provider was removed by RFC 0012: use BYOK (Settings -> AI provider or PUT /providers/config), or run the agent image standalone with /run/secrets"
					;;
				--no-build) BUILD=0; shift ;;
				--dry-run) DRY_RUN=1; shift ;;
				--yes|-y) ASSUME_YES=1; shift ;;
				-h|--help) usage; exit 0 ;;
				*) fail "unknown argument '$1' (try --help)" ;;
			esac
		done
		if [[ "${CMD}" == build && ${BUILD} -eq 0 ]]; then fail "build has nothing to skip"; fi
		;;
	down|status)
		while (($#)); do
			case "$1" in
				-h|--help) usage; exit 0 ;;
				*) fail "unknown argument '$1' (try --help)" ;;
			esac
		done
		;;
	""|-h|--help|help) usage; exit 0 ;;
	*)
		# Kept as an explicit error instead of silently degrading to faux:
		# the manager no longer mounts host secrets (RFC 0012 §4).
		if [[ "${1:-}" == --provider* ]]; then
			fail "--provider was removed by RFC 0012: use BYOK (Settings -> AI provider or PUT /providers/config), or run the agent image standalone with /run/secrets"
		fi
		fail "unknown command '${CMD}' (try --help)"
		;;
esac

case "${CMD}" in
	up) cmd_up ;;
	reload) cmd_reload ;;
	build) cmd_build ;;
	down) cmd_down ;;
	reset) cmd_reset ;;
	secrets) cmd_secrets ;;
	status) cmd_status ;;
esac
