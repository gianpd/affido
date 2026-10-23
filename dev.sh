#!/usr/bin/env bash
# Single local-development entry point for the control plane.
#
# Sandbox agents are NOT compose services: the manager creates them on demand
# from AGENT_IMAGE (see create_args() in sandbox-manager/sandbox_manager.py).
# That is why provider selection is expressed as an image + an optional
# secrets mount, never as a compose service.
#
# Usage:
#   ./dev.sh up [--provider fake|openrouter] [--no-build] [--dry-run]
#   ./dev.sh reload [--provider fake|openrouter] [--no-build] [--dry-run]
#   ./dev.sh build [--provider fake|openrouter] [--dry-run]
#   ./dev.sh down
#   ./dev.sh reset [--yes]
#   ./dev.sh secrets [--provider fake|openrouter]
#   ./dev.sh status
#
# `reload` is the edit-test loop for agent code: rebuild the images, refresh the
# control plane, then remove the sandbox containers so the next request
# re-provisions them from the new image. The Postgres volume, pi-ws-<user> and
# pi-data-<user> are never touched, so documents, workspaces and sessions stay
# durable. `reset` remains the only command that deletes data. With `--no-build`
# reload keeps the current images and only recreates the containers.
#
# Provider:
#   fake        affido-agent:latest, no secrets mounted. model.ts falls
#               through to the keyless faux provider. Default.
#   openrouter  affido-agent:openrouter (ENV OPENROUTER_MODEL and
#               THINKING_LEVEL baked in) plus secrets/ mounted read-only at
#               /run/secrets. One key for every sandbox: single-tenant, see
#               docs/rfc/0004.
#
# Secrets are never passed as compose environment for the agents:
#   .env                        -> compose interpolation, control plane only
#   secrets/                    -> host dir the manager mounts into sandboxes
#   ENV OPENROUTER_MODEL        -> the only non-secret input, baked into the
#                                  openrouter image because the manager cannot
#                                  forward env vars to `docker create`
#   ENV THINKING_LEVEL          -> same path: reasoning effort requested from
#                                  the provider, empty keeps the runtime off
#
# Gate for the whole stack remains ./verify.sh (typecheck, unit tests, e2e).
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(pwd)"
PROJECT="affido"
BASE_IMAGE="affido-agent:latest"
OPENROUTER_IMAGE="affido-agent:openrouter"
PROVIDER="fake"
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
	# Compose reads .env itself; we also need OPENROUTER_MODEL and THINKING_LEVEL
	# here to bake them into the derived image.
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
	case "${PROVIDER}" in
		fake) printf '%s' "${BASE_IMAGE}" ;;
		openrouter) printf '%s' "${OPENROUTER_IMAGE}" ;;
		*) fail "unknown provider '${PROVIDER}' (use fake or openrouter)" ;;
	esac
}

secrets_dir() {
	# Empty string disables the mount (compose override uses ${VAR-default},
	# so a set-but-empty value wins over the default). create_args() then
	# skips -v /run/secrets and model.ts stays on faux.
	case "${PROVIDER}" in
		fake) printf '' ;;
		openrouter) printf '%s' "${ROOT}/secrets" ;;
	esac
}

build_base() {
	if ((BUILD)) || ! image_exists "${BASE_IMAGE}"; then
		echo "== build ${BASE_IMAGE} =="
		run docker build -q -t "${BASE_IMAGE}" ./agent
		((DRY_RUN)) || pass "${BASE_IMAGE} built"
	fi
}

build_openrouter() {
	[[ -n "${OPENROUTER_MODEL:-}" ]] || fail "OPENROUTER_MODEL is not set (put it in .env)"
	[[ -s "${ROOT}/secrets/openrouter_api_key" ]] || fail "missing or empty secrets/openrouter_api_key"

	# The model id alone does not make the image current: the derived image bakes
	# the base layer, so a rebuilt base with the same model id would be skipped
	# and every sandbox would keep running the old code. The build records the
	# base image id as a label and the check compares it.
	local base_id current current_level current_base
	base_id="$(docker image inspect -f '{{.Id}}' "${BASE_IMAGE}" 2>/dev/null || true)"
	[[ -n "${base_id}" ]] || fail "${BASE_IMAGE} is missing; run ./dev.sh build first"
	current="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${OPENROUTER_IMAGE}" 2>/dev/null \
		| sed -n 's/^OPENROUTER_MODEL=//p' || true)"
	current_level="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${OPENROUTER_IMAGE}" 2>/dev/null \
		| sed -n 's/^THINKING_LEVEL=//p' || true)"
	current_base="$(docker image inspect \
		-f '{{with .Config.Labels}}{{index . "pi.base-image-id"}}{{end}}' "${OPENROUTER_IMAGE}" 2>/dev/null || true)"
	if [[ "${current}" == "${OPENROUTER_MODEL}" && "${current_level}" == "${THINKING_LEVEL:-}" && "${current_base}" == "${base_id}" ]]; then
		pass "${OPENROUTER_IMAGE} is current (OPENROUTER_MODEL=${OPENROUTER_MODEL}, THINKING_LEVEL=${THINKING_LEVEL:-off})"
		return 0
	fi

	echo "== build ${OPENROUTER_IMAGE} =="
	if ((DRY_RUN)); then
		printf '     + docker build --build-arg BASE_IMAGE_ID=%s --build-arg OPENROUTER_MODEL=%s --build-arg THINKING_LEVEL=%s -t %s <tmp>\n' \
			"${base_id}" "${OPENROUTER_MODEL}" "${THINKING_LEVEL:-}" "${OPENROUTER_IMAGE}"
		return 0
	fi
	# The image ENV is the only lever: the manager forwards no *_MODEL to
	# `docker create`, and an empty value would be falsy for model.ts.
	local ctx
	ctx="$(mktemp -d)"
	TMPDIRS+=("${ctx}")
	cat >"${ctx}/Dockerfile" <<'EOF'
# Derived from the agent image; only adds the model id and reasoning effort the
# manager cannot pass.
ARG BASE_IMAGE=affido-agent:latest
FROM ${BASE_IMAGE}
ARG OPENROUTER_MODEL
ARG THINKING_LEVEL
ARG BASE_IMAGE_ID
ENV OPENROUTER_MODEL=${OPENROUTER_MODEL}
# Empty is what agent/server.ts reads as "unset": the runtime then keeps `off`.
ENV THINKING_LEVEL=${THINKING_LEVEL}
# Ties this image to the exact base layer it was built from, so dev.sh can tell
# whether a rebuilt base image has been picked up.
LABEL pi.base-image-id=${BASE_IMAGE_ID}
EOF
	docker build -q \
		--build-arg "BASE_IMAGE=${BASE_IMAGE}" \
		--build-arg "BASE_IMAGE_ID=${base_id}" \
		--build-arg "OPENROUTER_MODEL=${OPENROUTER_MODEL}" \
		--build-arg "THINKING_LEVEL=${THINKING_LEVEL:-}" \
		-t "${OPENROUTER_IMAGE}" "${ctx}" >/dev/null || fail "cannot build ${OPENROUTER_IMAGE}"
	pass "${OPENROUTER_IMAGE} built (OPENROUTER_MODEL=${OPENROUTER_MODEL}, THINKING_LEVEL=${THINKING_LEVEL:-off})"
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
	((stale)) && warn "run ./dev.sh reload --provider ${PROVIDER} to reprovision from ${want} (volumes kept)"
	return 0
}

summary() {
	echo
	printf 'provider     %s\n' "${PROVIDER}"
	printf 'agent image  %s\n' "$(agent_image)"
	if [[ "${PROVIDER}" == openrouter ]]; then
		printf 'agent secrets %s -> /run/secrets (ro, one dir per sandbox)\n' "${ROOT}/secrets"
		printf 'model id     %s (baked as ENV in %s)\n' "${OPENROUTER_MODEL}" "${OPENROUTER_IMAGE}"
		printf 'thinking     %s (baked as ENV; empty means off)\n' "${THINKING_LEVEL:-off}"
	else
		printf 'agent secrets none mounted -> keyless faux provider in agent/model.ts\n'
	fi
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
	# Base compose hardcodes AGENT_IMAGE; the override is where the provider
	# levers (AGENT_IMAGE, AGENT_SECRETS_DIR) are forwarded to the manager.
	[[ -f docker-compose.override.yml ]] \
		|| fail "docker-compose.override.yml is missing: it forwards AGENT_IMAGE/AGENT_SECRETS_DIR"
}

compose_up() {
	local image dir
	image="$(agent_image)"
	dir="$(secrets_dir)"

	echo "== docker compose up =="
	local compose_args=(up -d)
	((BUILD)) && compose_args+=(--build)
	# Explicit env defeats docker-compose.override.yml defaults.
	if ((DRY_RUN)); then
		printf '     + AGENT_IMAGE=%s AGENT_SECRETS_DIR=%s docker compose %s\n' \
			"${image}" "${dir}" "${compose_args[*]}"
	else
		AGENT_IMAGE="${image}" AGENT_SECRETS_DIR="${dir}" \
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
	[[ "${PROVIDER}" == openrouter ]] && build_openrouter
	warn_stale_sandboxes "$(agent_image)"
	compose_up
	summary
}

# Remove the sandbox containers, never their volumes. `provision()` in the
# manager creates the named volumes idempotently, so the next request mounts the
# same pi-ws-<user> (workspace, corpus) and pi-data-<user> (session.sqlite).
recreate_sandboxes() {
	local ids
	ids="$(docker ps -aq --filter label=pi-sandbox-manager=1 || true)"
	if [[ -z "${ids}" ]]; then
		pass "no sandbox containers to recreate"
		return 0
	fi
	# shellcheck disable=SC2086
	run docker rm -f ${ids}
	((DRY_RUN)) || pass "sandboxes removed: next request re-provisions from $(agent_image)"
}

cmd_reload() {
	need_docker
	load_env
	require_override
	build_base
	[[ "${PROVIDER}" == openrouter ]] && build_openrouter
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
	[[ "${PROVIDER}" == openrouter ]] && build_openrouter
	pass "images ready for --provider ${PROVIDER}"
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
	run docker image rm -f "${BASE_IMAGE}" "${OPENROUTER_IMAGE}" >/dev/null 2>&1 || true
	pass "reset done: next ./dev.sh up rebuilds from zero"
}

cmd_secrets() {
	load_env
	cat <<'TXT'
Where each value comes from, and where it lands.

.env (gitignored; docker compose interpolates it into the control plane)
  MANAGER_TOKEN      shared secret for Caddy forward_auth <-> manager HTTP API
  STOP_AFTER_S       L1 stop threshold for a paused sandbox
  EVICT_TICK_S       manager eviction/reconcile tick
  AGENT_IDLE_MS      in-process idle pause threshold inside the agent
  OLTP_PORT          host port for the control-plane Postgres
  WEB_CONTAINER      optional compose container joined to every sandbox network
  OPENROUTER_MODEL   model id; NOT a secret; baked as ENV into the derived image

secrets/ (gitignored host dir; never mounted into the control plane)
  openrouter_api_key   -> /run/secrets/openrouter_api_key in each sandbox
  openai_api_key       -> /run/secrets/openai_api_key in each sandbox

The mount is created by the manager (`docker create -v <host dir>:/run/secrets:ro`),
not by compose: sandboxes are not compose services. AGENT_SECRETS_DIR is the
host path; when empty the mount is skipped and agent/model.ts uses faux.
agent/model.ts reads the files (never process.env) via readSecret().
TXT
	echo
	echo "== provider readiness =="
	local ok=1
	for f in openrouter_api_key openai_api_key; do
		if [[ -s "${ROOT}/secrets/${f}" ]]; then printf 'present  secrets/%s\n' "${f}"
		else printf 'empty    secrets/%s\n' "${f}"; fi
	done
	if [[ -n "${OPENROUTER_MODEL:-}" ]]; then printf 'present  OPENROUTER_MODEL=%s\n' "${OPENROUTER_MODEL}"
	else printf 'missing  OPENROUTER_MODEL\n'; fi
	case "${PROVIDER}" in
		fake) printf 'active   fake: no secret needed\n' ;;
		openrouter)
			if [[ -z "${OPENROUTER_MODEL:-}" || ! -s "${ROOT}/secrets/openrouter_api_key" ]]; then
				printf 'active   openrouter: NOT ready (see missing/empty rows above)\n'
				ok=0
			else printf 'active   openrouter: ready\n'; fi
			;;
		*) fail "unknown provider '${PROVIDER}' (use fake or openrouter)" ;;
	esac
	((ok)) || exit 1
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
				--provider) PROVIDER="${2:-}"; shift 2 ;;
				--provider=*) PROVIDER="${1#*=}"; shift ;;
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
	*) fail "unknown command '${CMD}' (try --help)" ;;
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
