#!/usr/bin/env python3
"""Sandbox Manager: on-demand starter and lifecycle supervisor for affido
agent sandboxes.

It answers three questions for every user:
  * does this user already have a sandbox?          -> sandbox_registry
  * what is the status of that sandbox?              -> docker inspect + GET /health
  * if there is none, provide one.                   -> docker create + start

It is the only writer of the sandbox_registry lifecycle columns and the only
component besides the Docker daemon that starts and stops agent containers.
Each agent keeps its own durable state in its /workspace and /data volumes.

Runtime dependency: psycopg[binary]. Docker is driven through the `docker` CLI.
"""

from __future__ import annotations

import base64
import binascii
import datetime
import hashlib
import hmac
import http.cookies
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import ssl
import string
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import psycopg
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from psycopg.rows import dict_row

log = logging.getLogger("sandbox-manager")
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)

# ── settings ────────────────────────────────────────────────────────────────
DSN             = os.environ["DATABASE_URL"]
AGENT_IMAGE     = os.getenv("AGENT_IMAGE", "affido-agent:latest")
AGENT_PORT      = int(os.getenv("AGENT_PORT", "8080"))
AGENT_IDLE_MS   = int(os.getenv("AGENT_IDLE_MS", "5000"))
AGENT_CITATIONS_DEFAULT = os.getenv("AGENT_CITATIONS_DEFAULT", "")
# RFC 0017 §3 / RFC 0018 §5: the post-gate coherence judge's mode. The
# agent's default is enforce, backed by a typed-choice classification that
# rides the run's OpenRouter credential (BYOK sidecar) and is simply absent
# when no such credential backs the run; it needs no weights, no model cache
# and no memory cap. This env exists to override that default, not to enable it.
AGENT_CITATION_JUDGE = os.getenv("AGENT_CITATION_JUDGE", "")
# RFC 0020 §4.3: the judge's derived latency budget, forwarded verbatim; empty
# means the agent's own defaults (8 s per-pair envelope, 4 pairs in flight,
# 30 s per run). The agent derives the retry ladder from the envelope at load
# and refuses to boot on an inconsistent value, so no validation lives here.
AGENT_CITATION_JUDGE_PAIR_TIMEOUT_MS = os.getenv("AGENT_CITATION_JUDGE_PAIR_TIMEOUT_MS", "")
AGENT_CITATION_JUDGE_CONCURRENCY = os.getenv("AGENT_CITATION_JUDGE_CONCURRENCY", "")
AGENT_CITATION_JUDGE_RUN_BUDGET_MS = os.getenv("AGENT_CITATION_JUDGE_RUN_BUDGET_MS", "")
# `off` (default): per-user networks are created without NAT egress, so a
# sandbox can talk to its guests (caddy, manager, web) on its own subnet and
# nothing else. `open` keeps the plain-bridge behaviour (internet egress) for
# deployments whose model provider is reached over the internet (openrouter).
AGENT_EGRESS    = os.getenv("AGENT_EGRESS", "off")
AGENT_MEMORY    = os.getenv("AGENT_MEMORY", "512m")
AGENT_CPUS      = os.getenv("AGENT_CPUS", "1.0")
# RFC 0013 §6.1/§6.3/R10: the per-sandbox key-injection sidecar. One image,
# second entrypoint (`node /app/sidecar.ts`), own reduced resource caps — a
# Node HTTP pass-through idles at ~10 MiB RSS (~25 MiB realistic), so cloning
# the agent's 512m would double the nominal per-user ceiling for nothing.
SIDECAR_PORT    = int(os.getenv("SIDECAR_PORT", "8081"))
SIDECAR_MEMORY  = os.getenv("SIDECAR_MEMORY", "128m")
SIDECAR_CPUS    = os.getenv("SIDECAR_CPUS", "0.25")
# RFC 0016: the per-user web-search node. One more container in the pair, on the
# per-user internal network and on the shared search network. No volumes, no
# user code, no egress: SearXNG and Camofox are its only outbound peers.
WEBSEARCH_PORT   = int(os.getenv("WEBSEARCH_PORT", "8082"))
WEBSEARCH_MEMORY = os.getenv("WEBSEARCH_MEMORY", "192m")
WEBSEARCH_CPUS   = os.getenv("WEBSEARCH_CPUS", "0.5")
# Operator-supplied search infrastructure. websearch-in is the internal network
# shared by every per-user node and the search services; websearch-out is the
# plain bridge where the services get their egress. The node is never attached
# to websearch-out.
WEBSEARCH_IN     = os.getenv("WEBSEARCH_IN", "websearch-in")
WEBSEARCH_OUT    = os.getenv("WEBSEARCH_OUT", "websearch-out")
SEARXNG_URL      = os.getenv("SEARXNG_URL", "http://searxng:8080")
CAMOFOX_URL      = os.getenv("CAMOFOX_URL", "http://camofox-browser:9377")
# Shared operator secret for Camofox's /evaluate. It never enters a sandbox:
# only the node container receives it, and no tool echoes it.
CAMOFOX_API_KEY  = os.getenv("CAMOFOX_API_KEY", "")
# ── RFC 0024: the per-user MCP node ─────────────────────────────────────────
# One `mcp-<user>` container per sandbox when MCP_SERVERS is non-empty: same
# image, fourth entrypoint (node /app/mcp-gateway.ts). Three network legs: the
# per-user internal network (the agent), mcp-in (operator-hosted servers,
# internal) and mcp-out (third-party servers, NAT, inter-container traffic
# disabled so tenants' nodes cannot reach each other there).
MCP_PORT         = int(os.getenv("MCP_PORT", "8083"))
MCP_MEMORY       = os.getenv("MCP_MEMORY", "192m")
MCP_CPUS         = os.getenv("MCP_CPUS", "0.5")
MCP_IN           = os.getenv("MCP_IN", "mcp-in")
MCP_OUT          = os.getenv("MCP_OUT", "mcp-out")
# The deployment subset of the operator catalog (agent/catalog/mcp.json,
# extracted from the image like provider-catalog.json). Empty: no MCP surface.
MCP_SERVERS_RAW  = os.getenv("MCP_SERVERS", "")
# Caddy stamps this on /prompt (X-MCP-Admission); the manager delivers it to
# the node with the server config. Missing key = no write run ever (R8, fail
# closed), reads unaffected.
MCP_ADMISSION_KEY = os.getenv("MCP_ADMISSION_KEY", "")
MCP_CATALOG_PATH_IN_IMAGE = "/app/catalog/mcp.json"
# RFC 0013 §6.4 P0.1: explicit seccomp profile (deny-list, EPERM) for the
# ptrace_may_access-gated syscall family, shipped in this image and read
# client-side by the docker CLI (the daemon never touches the host fs for
# it). Applied to BOTH agent and sidecar containers so the no-ptrace
# boundary no longer rides on host Yama/seccomp defaults.
SECCOMP_PROFILE = os.getenv("SECCOMP_PROFILE", "/app/seccomp-no-ptrace.json")
# gVisor is mandatory, not a knob. 
AGENT_RUNTIME = "runsc"
AGENT_DNS       = os.getenv("AGENT_DNS", "1.1.1.1")  # gVisor ignores Docker's 127.0.0.11 embedded DNS
# RFC 0012 BYOK: the manager owns no plaintext provider secrets anymore. Keys
# arrive over HTTP, live encrypted in provider_key, and are delivered to the
# running agent at resolve time. The legacy AGENT_SECRETS_DIR mount is gone
# from this path; running the agent image standalone keeps the secret-file
# branch of agent/model.ts.
STOP_AFTER_S    = int(os.getenv("STOP_AFTER_S", "600"))
LISTEN_ADDR     = os.getenv("LISTEN_ADDR", "0.0.0.0")
LISTEN_PORT     = int(os.getenv("LISTEN_PORT", "8090"))
READY_TIMEOUT_S = int(os.getenv("READY_TIMEOUT_S", "60"))
EVICT_TICK_S    = int(os.getenv("EVICT_TICK_S", "15"))
# A freshly provisioned agent reports paused=true until its first activating
# request. Do not label it idle before the activity clock has been quiet this long.
IDLE_GRACE_S    = int(os.getenv("IDLE_GRACE_S", str(EVICT_TICK_S)))
RECONCILE_S     = int(os.getenv("RECONCILE_S", "60"))
UNHEALTHY_LIMIT = int(os.getenv("UNHEALTHY_LIMIT", "3"))
MANAGER_TOKEN     = os.getenv("MANAGER_TOKEN")  # shared secret; all endpoints but /healthz

KNOWN_DEFAULT_TOKEN = "dev-manager-token"
MANAGER_ALLOW_DEFAULT_TOKEN = os.getenv("MANAGER_ALLOW_DEFAULT_TOKEN", "") == "1"
MANAGER_CONTAINER = os.getenv("MANAGER_CONTAINER", "sandbox-manager")  # for network connect
CADDY_CONTAINER   = os.getenv("CADDY_CONTAINER")  # compose container_name of caddy
WEB_CONTAINER     = os.getenv("WEB_CONTAINER")  # optional: SvelteKit app that calls /resolve
AUTH_COOKIE_NAME  = os.getenv("AUTH_COOKIE_NAME", "better-auth.session_token")
# ── machine identity surface (RFC 0023) ─────────────────────────────────────
# Four routes for server-to-server callers (worldGraph): register, login,
# logout and the email/name fields on /whoami. They are gated by a scoped
# X-Identity-Key, never by MANAGER_TOKEN: the key can mint an identity, not
# create/stop/inspect a sandbox. The manager stays the only writer of the
# better-auth tables and the web app keeps calling auth.api.* in-process.
IDENTITY_API_KEY = os.getenv("IDENTITY_API_KEY", "")
# Rotation: both keys are accepted while the caller switches over.
IDENTITY_API_KEY_PREVIOUS = os.getenv("IDENTITY_API_KEY_PREVIOUS", "")
IDENTITY_MIN_KEY_CHARS = 32
# BETTER_AUTH_SECRET seals the session cookie; ORIGIN picks the cookie name
# (https -> __Secure-) exactly like better-auth's createCookieGetter. Neither
# is ever logged. Missing either one makes the routes answer
# identity_unavailable instead of serving a cookie the web app cannot verify.
BETTER_AUTH_SECRET = os.getenv("BETTER_AUTH_SECRET", "")
ORIGIN            = os.getenv("ORIGIN", "")
IDENTITY_SESSION_TTL = datetime.timedelta(days=7)  # better-auth's expiresIn
IDENTITY_LOGIN_PER_MINUTE = int(os.getenv("IDENTITY_LOGIN_PER_MINUTE", "5"))
IDENTITY_REGISTER_PER_HOUR = int(os.getenv("IDENTITY_REGISTER_PER_HOUR", "10"))
IDENTITY_MAX_BODY = 16 * 1024
# ── BYOK (RFC 0012) ─────────────────────────────────────────────────────────
# 32-byte key-encryption key for provider_key ciphertext. Mounted read-only
# into this container only (compose: ./secrets/llm_key_kek). Raw or base64;
# anything else is kek_unavailable and every key-writing path fails closed.
LLM_KEK_FILE        = os.getenv("LLM_KEK_FILE", "/run/secrets/llm_key_kek")
# Dev-only relaxations of the §5.1 custom-baseUrl rules: http:// baseUrls are
# accepted. The e2e gate uses this for the fake OpenAI-compatible upstream.
PROVIDER_DEV_HTTP   = os.getenv("PROVIDER_DEV_HTTP", "") == "1"
# Optional compose container of an e2e-only fake OpenAI-compatible upstream.
# When set (and http is dev-allowed) the catalog gains an `e2e-fake` entry
# pointing at it and it is attached to per-user networks like the other guests.
FAKE_UPSTREAM_CONTAINER = os.getenv("FAKE_UPSTREAM_CONTAINER", "")
FAKE_UPSTREAM_PORT      = int(os.getenv("FAKE_UPSTREAM_PORT", "8090"))
# Path of the generated catalog inside AGENT_IMAGE (agent/Dockerfile builds it
# from pi-ai's static catalogs; the manager extracts and serves it verbatim).
CATALOG_PATH_IN_IMAGE = "/app/provider-catalog.json"

# ── identity: user_id -> docker-safe names ──────────────────────────────────
_NAME_RE = re.compile(r"[^a-zA-Z0-9_.-]")


def slug(user_id: str) -> str:
    """Map an opaque user id to a Docker-safe slug.

    Docker names and volume names must match [a-zA-Z0-9][a-zA-Z0-9_.-]*.
    The readable prefix is the cleaned id (a UUID stays readable), and a hash
    of the full id is always appended so two distinct ids can never collide
    on the same container or volume names.
    """
    if not user_id or len(user_id) > 256:
        raise ValueError("invalid user_id")
    digest = hashlib.sha1(user_id.encode()).hexdigest()[:12]
    clean = _NAME_RE.sub("-", user_id)[:32].strip("-") or "user"
    if not clean[0].isalnum():
        clean = "u" + clean
    return f"{clean}-{digest}"


def container_name(user_id: str) -> str:
    return "u" + slug(user_id)


def sidecar_name(user_id: str) -> str:
    """RFC 0013 §6.3: the key-injection sidecar of one user's pair. Same
    per-user network, no volumes, no published ports; created by create_args
    beside the agent (R5/R6)."""
    return container_name(user_id) + "-sidecar"


def websearch_name(user_id: str) -> str:
    """RFC 0016 §4: the per-user web-search node. Dual-homed on the user's
    network and the shared search network; created beside the pair."""
    return container_name(user_id) + "-websearch"


def mcp_node_name(user_id: str) -> str:
    """RFC 0024 §5: the per-user MCP node. Triple-homed on the user's network,
    the operator MCP network and the third-party egress network."""
    return container_name(user_id) + "-mcp"


def network_name(user_id: str) -> str:
    """One bridge network per user: agents cannot reach each other's :8080."""
    return "pi-net-" + slug(user_id)


def network_create_args() -> list[str]:
    """Docker create args for a per-user network.

    With AGENT_EGRESS != "open" the network is created --internal and without
    address masquerade. --internal is the load-bearing wall: the bridge gets
    no route off its own subnet, so the sandbox cannot NAT out to the
    internet, other subnets, or the host itself (without it, a 0.0.0.0-bound
    host service still answers on the gateway IP, because disabling
    masquerade only removes the FORWARD-path SNAT, not the bridge-to-host
    INPUT path). enable_ip_masquerade=false stays on as the second, redundant
    layer. Same-subnet guests (caddy, manager, web) remain reachable, which is
    all the data plane needs; the keyless faux provider needs no egress.
    """
    args = ["network", "create", "--label", "pi-sandbox-manager=1"]
    if AGENT_EGRESS != "open":
        args += ["--internal", "--opt", "com.docker.network.bridge.enable_ip_masquerade=false"]
    return args


def network_subnets(net: str) -> list[str]:
    """The CIDRs of one network, for the node's peer guard."""
    cp = subprocess.run(
        ["docker", "network", "inspect", "-f",
         "{{range .IPAM.Config}}{{.Subnet}} {{end}}", net],
        capture_output=True, text=True,
    )
    return cp.stdout.split() if cp.returncode == 0 else []


def ensure_websearch_networks() -> None:
    """RFC 0016 §4: the two operator networks, created when absent.

    `websearch-in` is `--internal` and carries no NAT: the node's only peers are
    the search services, which own the egress. `websearch-out` is a plain bridge
    where SearXNG and Camofox reach the internet. An existing `websearch-in`
    that is not internal would silently give the node egress, so it fails
    closed here instead of weakening the node's containment claim.
    """
    if not network_exists(WEBSEARCH_IN):
        docker(
            "network", "create", "--internal",
            "--opt", "com.docker.network.bridge.enable_ip_masquerade=false",
            "--label", "pi-affido-websearch=1", WEBSEARCH_IN,
        )
        invalidate_peer_cache()
    internal = docker("network", "inspect", "-f", "{{.Internal}}", WEBSEARCH_IN).strip()
    if internal != "true":
        raise RuntimeError(
            f"{WEBSEARCH_IN} exists but is not --internal: the web-search node"
            " would gain internet egress (RFC 0016). Recreate it --internal."
        )
    if not network_exists(WEBSEARCH_OUT):
        # Plain bridge: this is where the operator's search services get NAT.
        docker("network", "create", "--label", "pi-affido-websearch=1", WEBSEARCH_OUT)
        invalidate_peer_cache()


def websearch_service_hosts() -> dict[str, str]:
    """The baked /etc/hosts entries for SearXNG and Camofox.

    gVisor's netstack ignores Docker's embedded DNS, so the node cannot resolve
    service names at runtime. Both URLs normally point at containers on
    WEBSEARCH_IN; a hostname with no matching container is simply omitted and
    the node reports the upstream as unavailable at call time.
    """
    wanted = set()
    for value in (SEARXNG_URL, CAMOFOX_URL):
        host = urllib.parse.urlsplit(value).hostname
        if not host:
            continue
        try:
            ipaddress.ip_address(host)
            continue  # already an address: nothing to bake
        except ValueError:
            pass
        wanted.add(host)
    if not wanted or not network_exists(WEBSEARCH_IN):
        return {}
    cp = subprocess.run(
        ["docker", "network", "inspect", WEBSEARCH_IN, "-f", "{{json .Containers}}"],
        capture_output=True, text=True,
    )
    if cp.returncode != 0:
        return {}
    try:
        containers = json.loads(cp.stdout or "{}")
    except json.JSONDecodeError:
        return {}
    hosts: dict[str, str] = {}
    for info in (containers or {}).values():
        name = info.get("Name")
        address = (info.get("IPv4Address") or "").split("/", 1)[0]
        if name in wanted and address:
            hosts[name] = address
    return hosts


# ── RFC 0024: MCP networks, catalog, host resolution ────────────────────────

def ensure_mcp_networks() -> None:
    """§5.1 D2: `mcp-in` is internal (operator servers, no NAT); `mcp-out` is a
    plain bridge with inter-container traffic disabled, so every tenant's node
    shares the egress leg without a tenant-to-tenant edge (T7). An existing
    network with the wrong shape fails closed instead of weakening it."""
    if not network_exists(MCP_IN):
        docker(
            "network", "create", "--internal",
            "--opt", "com.docker.network.bridge.enable_ip_masquerade=false",
            "--label", "pi-affido-mcp=1", MCP_IN,
        )
        invalidate_peer_cache()
    internal = docker("network", "inspect", "-f", "{{.Internal}}", MCP_IN).strip()
    if internal != "true":
        raise RuntimeError(
            f"{MCP_IN} exists but is not --internal: an MCP node attached to it"
            " would gain a non-isolated leg (RFC 0024 D2). Recreate it --internal."
        )
    if not network_exists(MCP_OUT):
        docker(
            "network", "create",
            "--opt", "com.docker.network.bridge.enable_icc=false",
            "--label", "pi-affido-mcp=1", MCP_OUT,
        )
        invalidate_peer_cache()
    icc = docker(
        "network", "inspect", "-f",
        "{{index .Options \"com.docker.network.bridge.enable_icc\"}}", MCP_OUT,
    ).strip()
    if icc != "false":
        raise RuntimeError(
            f"{MCP_OUT} exists but does not disable inter-container traffic: nodes"
            " of different tenants could reach each other on it (RFC 0024 T7)."
            " Recreate it with com.docker.network.bridge.enable_icc=false."
        )


_mcp_catalog_cache: dict[str, Any] | None = None


def mcp_catalog() -> dict[str, dict[str, Any]]:
    """The operator catalog by server id, extracted from AGENT_IMAGE once (the
    provider-catalog precedent): the node reads its own copy from the same
    image, so the two cannot drift. No static fallback — an image without the
    file fails closed with mcp_catalog_unavailable."""
    global _mcp_catalog_cache
    if _mcp_catalog_cache is not None:
        return _mcp_catalog_cache
    try:
        raw = docker(
            "run", "--rm", "--network", "none", "--entrypoint", "cat",
            AGENT_IMAGE, MCP_CATALOG_PATH_IN_IMAGE, timeout=60,
        )
        doc = json.loads(raw)
        servers = doc["servers"]
        if not isinstance(servers, list):
            raise ValueError("catalog has no servers array")
    except Exception as exc:
        raise ManagerError(
            "mcp_catalog_unavailable",
            f"cannot read {MCP_CATALOG_PATH_IN_IMAGE} from {AGENT_IMAGE}"
            f" ({type(exc).__name__}); rebuild affido-agent",
        )
    _mcp_catalog_cache = {entry["id"]: entry for entry in servers if "id" in entry}
    return _mcp_catalog_cache


def mcp_deployment() -> list[dict[str, Any]]:
    """MCP_SERVERS intersected with the catalog. An id that is not in the
    catalog is logged and dropped (the manager serves the valid subset; the
    agent boot check then never trips, because the manager bakes only the
    resolved ids into the container env)."""
    wanted = [s.strip() for s in MCP_SERVERS_RAW.split(",") if s.strip()]
    if not wanted:
        return []
    catalog = mcp_catalog()
    deployment = []
    for server_id in dict.fromkeys(wanted):  # dedupe, keep order
        entry = catalog.get(server_id)
        if entry is None:
            log.warning("MCP_SERVERS lists %r which is not in the catalog: dropped", server_id)
            continue
        deployment.append(entry)
    return deployment


def mcp_service_hosts(deployment: list[dict[str, Any]]) -> dict[str, str]:
    """§5.3: one baked /etc/hosts entry per catalog host, resolved now.

    mcp-in hosts resolve to the container that holds the alias on MCP_IN (the
    §14.4 runbook: `docker run --network mcp-in --network-alias <host>`); when
    no container matches, the network's gateway is used — the operator runs
    the server on the docker host itself (worldGraph under `uv run`), bound to
    a port reachable on the bridge. mcp-out hosts resolve through DNS. The
    allowlist stays structural either way: a host that is not in the catalog
    never gets an entry and is unresolvable inside the node."""
    hosts: dict[str, str] = {}
    in_hosts = {
        entry["host"] for entry in deployment
        if entry.get("network") == "mcp-in" and entry.get("host")
    }
    if in_hosts and network_exists(MCP_IN):
        ids = docker("ps", "-q", "--filter", f"network={MCP_IN}").split()
        for start in range(0, len(ids), 25):
            chunk = ids[start : start + 25]
            doc = json.loads(docker("inspect", *chunk))
            for container in doc:
                net = (container.get("NetworkSettings") or {}).get("Networks") or {}
                leg = net.get(MCP_IN) or {}
                address = (leg.get("IPAddress") or "").split("/", 1)[0]
                if not address:
                    continue
                names = {container.get("Name", "").lstrip("/")} | set(leg.get("Aliases") or [])
                for host in in_hosts:
                    if host in names:
                        hosts[host] = address  # first match wins; operator's job to keep one
    if in_hosts and network_exists(MCP_IN):
        gateway = docker(
            "network", "inspect", "-f", "{{(index .IPAM.Config 0).Gateway}}", MCP_IN
        ).strip()
        for host in in_hosts:
            hosts.setdefault(host, gateway)  # operator-hosted on the docker host
    for entry in deployment:
        if entry.get("network") != "mcp-out" or not entry.get("host"):
            continue
        host = entry["host"]
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror:
            log.warning("mcp-out host %s does not resolve; the node will fail its calls", host)
            continue
        hosts[host] = infos[0][4][0]
    return hosts


def workspace_vol(user_id: str) -> str:
    return "pi-ws-" + slug(user_id)


def data_vol(user_id: str) -> str:
    return "pi-data-" + slug(user_id)


def endpoint(user_id: str) -> str:
    return f"{container_name(user_id)}:{AGENT_PORT}"


# ── database ────────────────────────────────────────────────────────────────
SCHEMA = """
CREATE TABLE IF NOT EXISTS sandbox_registry (
  user_id        text        PRIMARY KEY,
  container_name text        NOT NULL,
  container_id   text,
  workspace_vol  text        NOT NULL,
  data_vol       text        NOT NULL,
  endpoint       text,
  status         text        NOT NULL CHECK (status IN
                   ('creating','running','idle_paused','stopped','checkpointed','error')),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- RFC 0012 §5.2: BYOK desired state. ciphertext is AES-256-GCM with
-- AAD = user_id || provider, so a row can never be swapped onto another
-- owner. No FK to sandbox_registry: a user may configure a provider before
-- the first resolve provisions a sandbox (§5.2 note).
CREATE TABLE IF NOT EXISTS provider_key (
  user_id     text        NOT NULL,
  provider    text        NOT NULL,
  ciphertext  bytea       NOT NULL,
  nonce       bytea       NOT NULL,
  fingerprint text        NOT NULL,
  base_url    text,
  verified_at timestamptz,
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS provider_selection (
  user_id     text        NOT NULL,
  provider    text        NOT NULL,
  model_id    text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id)
);

-- RFC 0024 §10.1: per-user MCP enablement and credentials. ciphertext is
-- AES-256-GCM under the same KEK as provider_key but with its own AAD
-- (user_id || "mcp:" || server_id), so an MCP token can never be decrypted
-- as a provider key or swapped onto another owner. No FK, same note as
-- provider_key: a user may connect a server before the first resolve.
CREATE TABLE IF NOT EXISTS mcp_server (
  user_id     text        NOT NULL,
  server_id   text        NOT NULL,
  enabled     boolean     NOT NULL DEFAULT false,
  ciphertext  bytea,
  nonce       bytea,
  key_version integer     NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, server_id)
);
"""


def db() -> psycopg.Connection:
    """One connection per call: the manager is low-QPS, and this keeps the
    script free of a pool while staying safe across the server's threads."""
    return psycopg.connect(DSN, row_factory=dict_row)


def migrate() -> None:
    with db() as conn:
        conn.execute(SCHEMA)


def registry_get(user_id: str) -> dict[str, Any] | None:
    with db() as conn:
        return conn.execute(
            "SELECT * FROM sandbox_registry WHERE user_id = %s", (user_id,)
        ).fetchone()


def rows(where: str = "") -> list[dict[str, Any]]:
    with db() as conn:
        return conn.execute(f"SELECT * FROM sandbox_registry {where}").fetchall()


def registry_set(user_id: str, status: str, **fields: Any) -> None:
    columns = ["status = %s", "updated_at = now()"]
    params: list[Any] = [status]
    for name, value in fields.items():
        columns.append(f"{name} = %s")
        params.append(value)
    params.append(user_id)
    with db() as conn:
        conn.execute(
            f"UPDATE sandbox_registry SET {', '.join(columns)} WHERE user_id = %s",
            params,
        )


def touch(user_id: str) -> None:
    with db() as conn:
        conn.execute(
            "UPDATE sandbox_registry SET last_seen_at = now(), updated_at = now() "
            "WHERE user_id = %s",
            (user_id,),
        )


def try_claim(user_id: str) -> bool:
    """Insert the 'creating' row for this user. One writer wins.

    The advisory transaction lock serialises concurrent resolves per user, so a
    double click cannot provision two containers; different users are parallel.
    """
    with db() as conn:
        with conn.transaction():
            conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext(%s)::bigint)", (user_id,)
            )
            exists = conn.execute(
                "SELECT 1 FROM sandbox_registry WHERE user_id = %s", (user_id,)
            ).fetchone()
            if exists is not None:
                return False
            conn.execute(
                "INSERT INTO sandbox_registry "
                "(user_id, container_name, workspace_vol, data_vol, endpoint, status) "
                "VALUES (%s, %s, %s, %s, %s, 'creating')",
                (
                    user_id,
                    container_name(user_id),
                    workspace_vol(user_id),
                    data_vol(user_id),
                    endpoint(user_id),
                ),
            )
            return True


# ── identity on the browser path: session cookie, never a client user_id ────
def _cookie_base_name() -> str:
    """The better-auth cookie name without a secure prefix."""
    return AUTH_COOKIE_NAME.removeprefix("__Secure-")


def identity_cookie_name() -> str:
    """better-auth's cookie name for the configured origin (RFC 0023 §4.2).

    createCookieGetter prefixes __Secure- when baseURL is https and not when
    it is http; the manager must mint the exact name getSession reads.
    """
    prefix = "__Secure-" if ORIGIN.lower().startswith("https://") else ""
    return prefix + _cookie_base_name()


def session_token(handler: BaseHTTPRequestHandler) -> str | None:
    """The unguessable token part of the presented better-auth cookie."""
    cookie = http.cookies.SimpleCookie()
    try:
        cookie.load(handler.headers.get("Cookie") or "")
    except http.cookies.CookieError:
        return None
    base = _cookie_base_name()
    morsel = (
        cookie.get(identity_cookie_name())
        or cookie.get(AUTH_COOKIE_NAME)
        or cookie.get("__Secure-" + base)
        or cookie.get(base)
    )
    if morsel is None:
        return None
    # better-auth signs the cookie as "<token>.<hmac>". The token is the
    # unguessable database credential; the signature only protects it in
    # transit, so the lookup uses the token part.
    return urllib.parse.unquote(morsel.value).split(".", 1)[0] or None


def user_from_session(handler: BaseHTTPRequestHandler) -> str | None:
    """Validate the better-auth session cookie against the OLTP.

    The Caddy `forward_auth` subrequest is a GET clone of the browser request,
    cookies included, so this is the only trustworthy source of identity on
    that path. Names follow better-auth's defaults and are pinned down
    together with the user_table shape (§9, item 1).
    """
    token = session_token(handler)
    if token is None:
        return None
    with db() as conn:
        row = conn.execute(
            'SELECT "userId" FROM "session" '
            'WHERE "token" = %s AND "expiresAt" > now()',
            (token,),
        ).fetchone()
    return row["userId"] if row else None


def session_identity(handler: BaseHTTPRequestHandler) -> dict[str, Any] | None:
    """Session + user fields for GET /whoami (RFC 0023 §6).

    LEFT JOIN: the e2e seeds session rows without a user row (no foreign key
    in the auth schema), and a missing `user` table must not break the
    browser path that only needs userId. Email and name stay absent there.
    """
    token = session_token(handler)
    if token is None:
        return None
    with db() as conn:
        try:
            row = conn.execute(
                'SELECT s."userId" AS user_id, u."email" AS email, u."name" AS name '
                'FROM "session" s LEFT JOIN "user" u ON u."id" = s."userId" '
                'WHERE s."token" = %s AND s."expiresAt" > now()',
                (token,),
            ).fetchone()
        except psycopg.errors.UndefinedTable:
            conn.rollback()
            row = conn.execute(
                'SELECT "userId" AS user_id FROM "session" '
                'WHERE "token" = %s AND "expiresAt" > now()',
                (token,),
            ).fetchone()
    return dict(row) if row else None


# ── machine identity: the write half of better-auth (RFC 0023) ─────────────
# A manager-side caller authenticates with X-Identity-Key and the password
# crosses once, server-to-server, to be hashed at the trust boundary that owns
# the DB. The scrypt parameters and the cookie signature are better-auth's,
# byte for byte (@better-auth/utils@0.5.0 password.node / better-call crypto).

_ID_ALPHABET = string.ascii_letters + string.digits
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_identity_hash: list[str] = []


def identity_keys() -> tuple[str, ...]:
    """Configured keys that are long enough to be a secret. A shorter value
    is ignored, so the routes fail closed with 401 instead of accepting a
    weak credential."""
    return tuple(
        key
        for key in (IDENTITY_API_KEY, IDENTITY_API_KEY_PREVIOUS)
        if len(key) >= IDENTITY_MIN_KEY_CHARS
    )


def identity_key_ok(provided: str) -> bool:
    """Constant-time over every configured key (rotation accepts two).

    Bytes, not str: hmac.compare_digest rejects non-ASCII str input, and a
    non-ASCII header must be a plain 401, not a 500.
    """
    provided_bytes = provided.encode("utf-8", "replace")
    ok = False
    for key in identity_keys():
        ok |= hmac.compare_digest(provided_bytes, key.encode("utf-8"))
    return ok


def identity_ready() -> bool:
    return bool(BETTER_AUTH_SECRET) and bool(ORIGIN)


def _random_alnum(length: int) -> str:
    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(length))


def _scrypt_key(password: str, salt: str) -> bytes:
    """@better-auth/utils' node path: NFKC, salt as its hex STRING, N=16384,
    r=16, p=1, dkLen=64, maxmem=128*N*r*2."""
    return hashlib.scrypt(
        unicodedata.normalize("NFKC", password).encode("utf-8"),
        salt=salt.encode("utf-8"),
        n=16384,
        r=16,
        p=1,
        dklen=64,
        maxmem=128 * 16384 * 16 * 2,
    )


def hash_password(password: str, salt: str | None = None) -> str:
    """`salt:key`, 32 hex chars of salt and 128 of key, like better-auth."""
    salt = salt or os.urandom(16).hex()
    return f"{salt}:{_scrypt_key(password, salt).hex()}"


def verify_password(stored: str, password: str) -> bool:
    """True when the plaintext reproduces the stored salt:key. A malformed
    or foreign hash is simply a failed login, never an exception."""
    salt, sep, key = stored.partition(":")
    if not sep or not salt or not key:
        return False
    try:
        computed = _scrypt_key(password, salt).hex()
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(computed, key)


def identity_dummy_hash() -> str:
    """One valid hash for the unknown-email path: login then costs a scrypt
    either way, so response time does not enumerate accounts."""
    if not _identity_hash:
        _identity_hash.append(hash_password("identity-dummy-password"))
    return _identity_hash[0]


def sealed_cookie(token: str, secret: str | None = None) -> str:
    """better-auth's signed cookie, URL-encoded like encodeURIComponent.

    signCookieValue: base64(HMAC-SHA256(secret, token)), appended after a dot,
    then the whole value is percent-encoded. The name follows ORIGIN.
    """
    signature = base64.b64encode(
        hmac.new(
            (secret if secret is not None else BETTER_AUTH_SECRET).encode(),
            token.encode(),
            hashlib.sha256,
        ).digest()
    ).decode()
    value = urllib.parse.quote(f"{token}.{signature}", safe="")
    return f"{identity_cookie_name()}={value}"


def identity_email(value: Any) -> str:
    if not isinstance(value, str):
        raise ManagerError("invalid_input", "email is required", 400)
    email = value.strip().lower()  # RFC 0023 §5: one account per address
    if len(email) > 254 or not _EMAIL_RE.match(email):
        raise ManagerError("invalid_input", "email is not valid", 400)
    return email


def identity_password(value: Any) -> str:
    if not isinstance(value, str) or not 8 <= len(value) <= 128:
        raise ManagerError("invalid_input", "password must be 8-128 characters", 400)
    return value


def identity_name(value: Any) -> str:
    if not isinstance(value, str):
        raise ManagerError("invalid_input", "name is required", 400)
    name = value.strip()
    if not 1 <= len(name) <= 200:
        raise ManagerError("invalid_input", "name must be 1-200 characters", 400)
    return name


def identity_result(user_id: str, email: str, name: str, token: str) -> dict[str, Any]:
    return {
        "user": {"id": user_id, "email": email, "name": name},
        "session": {"cookie": sealed_cookie(token)},
    }


def identity_register(
    email: str, password: str, name: str, ip: str, user_agent: str
) -> dict[str, Any]:
    """user + account + session in ONE transaction (RFC 0023 §3)."""
    user_id = _random_alnum(32)
    token = _random_alnum(32)
    now = datetime.datetime.now(datetime.timezone.utc)
    expires = now + IDENTITY_SESSION_TTL
    password_hash = hash_password(password)
    try:
        with db() as conn:
            with conn.transaction():
                conn.execute(
                    'INSERT INTO "user" ("id", "name", "email", "emailVerified",'
                    ' "image", "createdAt", "updatedAt")'
                    " VALUES (%s, %s, %s, false, NULL, %s, %s)",
                    (user_id, name, email, now, now),
                )
                conn.execute(
                    'INSERT INTO "account" ("id", "accountId", "providerId",'
                    ' "userId", "password", "createdAt", "updatedAt")'
                    " VALUES (%s, %s, 'credential', %s, %s, %s, %s)",
                    (_random_alnum(32), user_id, user_id, password_hash, now, now),
                )
                conn.execute(
                    'INSERT INTO "session" ("id", "token", "userId", "expiresAt",'
                    ' "ipAddress", "userAgent", "createdAt", "updatedAt")'
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    (_random_alnum(32), token, user_id, expires, ip, user_agent, now, now),
                )
    except psycopg.errors.UniqueViolation as exc:
        # The only realistic unique violation is user.email. Anything else
        # (a token/ID collision) is an outage, not a taken address.
        constraint = getattr(exc.diag, "constraint_name", "") or ""
        if "email" not in constraint:
            log.exception("identity register hit a non-email unique constraint")
            raise ManagerError("identity_unavailable", "the identity store is unavailable", 503)
        raise ManagerError("email_taken", "an account with this email already exists", 409)
    except psycopg.Error:
        # Never include the statement or the parameters: they carry the hash.
        log.exception("identity register failed")
        raise ManagerError("identity_unavailable", "the identity store is unavailable", 503)
    return identity_result(user_id, email, name, token)


def identity_login(
    email: str, password: str, ip: str, user_agent: str
) -> dict[str, Any]:
    try:
        with db() as conn:
            row = conn.execute(
                'SELECT u."id" AS id, u."email" AS email, u."name" AS name,'
                ' a."password" AS password FROM "user" u'
                ' JOIN "account" a ON a."userId" = u."id"'
                " WHERE lower(u.\"email\") = %s AND a.\"providerId\" = 'credential'"
                ' ORDER BY a."createdAt" DESC LIMIT 1',
                (email,),
            ).fetchone()
    except psycopg.Error:
        log.exception("identity login lookup failed")
        raise ManagerError("identity_unavailable", "the identity store is unavailable", 503)
    if row is None:
        verify_password(identity_dummy_hash(), password)
        raise ManagerError("invalid_credentials", "email or password is incorrect", 401)
    if not row["password"] or not verify_password(row["password"], password):
        raise ManagerError("invalid_credentials", "email or password is incorrect", 401)
    token = _random_alnum(32)
    now = datetime.datetime.now(datetime.timezone.utc)
    try:
        with db() as conn:
            conn.execute(
                'INSERT INTO "session" ("id", "token", "userId", "expiresAt",'
                ' "ipAddress", "userAgent", "createdAt", "updatedAt")'
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    _random_alnum(32), token, row["id"], now + IDENTITY_SESSION_TTL,
                    ip, user_agent, now, now,
                ),
            )
    except psycopg.Error:
        log.exception("identity login session insert failed")
        raise ManagerError("identity_unavailable", "the identity store is unavailable", 503)
    return identity_result(row["id"], row["email"], row["name"], token)


def identity_logout(handler: BaseHTTPRequestHandler) -> None:
    """Delete the presented session; every answer is 204, so a stale cookie
    cannot be used to test whether a token still exists."""
    token = session_token(handler)
    if token is None:
        return
    try:
        with db() as conn:
            conn.execute('DELETE FROM "session" WHERE "token" = %s', (token,))
    except psycopg.Error:
        log.exception("identity logout failed")
        raise ManagerError("identity_unavailable", "the identity store is unavailable", 503)


class _RateWindows:
    """In-process sliding windows: one manager process, low QPS."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hits: dict[tuple[str, str], list[float]] = {}

    def allow(self, bucket: str, key: str, limit: int, window_s: float) -> tuple[bool, int]:
        now = time.time()
        slot = (bucket, key)
        with self._lock:
            hits = [t for t in self._hits.get(slot, ()) if now - t < window_s]
            if len(hits) >= limit:
                self._hits[slot] = hits
                return False, max(1, int(window_s - (now - hits[0])))
            hits.append(now)
            self._hits[slot] = hits
            return True, 0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


_identity_windows = _RateWindows()
IDENTITY_ROUTES = frozenset({"/identity/register", "/identity/login", "/identity/logout"})


def client_ip(handler: BaseHTTPRequestHandler) -> str:
    """Rate-limit key. Caddy appends the real client to X-Forwarded-For; the
    last hop is the one it added. A malformed value falls back to the peer."""
    peer = handler.client_address[0]
    forwarded = handler.headers.get("X-Forwarded-For") or ""
    hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
    if hops:
        try:
            return str(ipaddress.ip_address(hops[-1]))
        except ValueError:
            pass
    return peer


# ── BYOK: provider keys, catalog, delivery (RFC 0012) ───────────────────────

class ManagerError(Exception):
    """An error with a stable machine code. HTTP handlers and resolve surface
    the code verbatim (egress_blocked, kek_unavailable, agent_image_old, ...);
    the message never contains key material."""

    def __init__(self, code: str, message: str, status: int = 503):
        super().__init__(message)
        self.code = code
        self.status = status


_kek: dict[str, bytes] = {}


def load_kek() -> bytes:
    """The 32-byte KEK (RFC 0012 §5.2 / RFC 0004 §4.7 scheme), read once.

    Accepts 32 raw bytes or their base64 encoding (the openssl runbook writes
    base64). Anything else is `kek_unavailable`: every key-writing and
    key-delivering path fails closed, never a silent faux fallback (§7.9)."""
    if "key" in _kek:
        return _kek["key"]
    try:
        with open(LLM_KEK_FILE, "rb") as fh:
            raw = fh.read()
    except OSError as exc:
        raise ManagerError(
            "kek_unavailable", f"KEK unreadable at {LLM_KEK_FILE}: {exc.strerror}"
        )
    key = raw if len(raw) == 32 else None
    if key is None:
        try:
            key = base64.b64decode(raw.strip(), validate=True)
        except (binascii.Error, ValueError):
            key = b""
    if len(key) != 32:
        raise ManagerError(
            "kek_unavailable", "KEK must be 32 raw bytes or their base64 encoding"
        )
    _kek["key"] = key
    return key


def key_aad(user_id: str, provider: str) -> bytes:
    """§5.2: AAD = user_id || provider, binding each ciphertext to its owner so
    rows cannot be swapped between users or providers."""
    return user_id.encode() + provider.encode()


def encrypt_key(user_id: str, provider: str, api_key: str) -> tuple[bytes, bytes]:
    nonce = os.urandom(12)
    ciphertext = AESGCM(load_kek()).encrypt(nonce, api_key.encode(), key_aad(user_id, provider))
    return ciphertext, nonce


def decrypt_key(user_id: str, provider: str, ciphertext: bytes, nonce: bytes) -> str:
    # Any failure (lost/rotated KEK, corrupted row, swapped AAD) maps to
    # kek_unavailable: fail closed (§7.9).
    try:
        return AESGCM(load_kek()).decrypt(nonce, bytes(ciphertext), key_aad(user_id, provider)).decode()
    except Exception as exc:
        raise ManagerError(
            "kek_unavailable", f"provider key ciphertext undecryptable ({type(exc).__name__})"
        )


def key_fingerprint(api_key: str) -> str:
    """sha256(key)[:12] hex — the only key-derived value any API returns (§8.3)."""
    return hashlib.sha256(api_key.encode()).hexdigest()[:12]


def provider_key_get(user_id: str, provider: str) -> dict[str, Any] | None:
    with db() as conn:
        return conn.execute(
            "SELECT * FROM provider_key WHERE user_id = %s AND provider = %s AND status = 'active'",
            (user_id, provider),
        ).fetchone()


def provider_keys(user_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        return conn.execute(
            "SELECT * FROM provider_key WHERE user_id = %s AND status = 'active' ORDER BY provider",
            (user_id,),
        ).fetchall()


def provider_key_upsert(
    user_id: str, provider: str, api_key: str, base_url: str | None, verified: bool
) -> str:
    ciphertext, nonce = encrypt_key(user_id, provider, api_key)
    fingerprint = key_fingerprint(api_key)
    with db() as conn:
        conn.execute(
            "INSERT INTO provider_key (user_id, provider, ciphertext, nonce, fingerprint,"
            " base_url, verified_at, status) VALUES (%s, %s, %s, %s, %s, %s, %s, 'active')"
            " ON CONFLICT (user_id, provider) DO UPDATE SET ciphertext = EXCLUDED.ciphertext,"
            " nonce = EXCLUDED.nonce, fingerprint = EXCLUDED.fingerprint, base_url = EXCLUDED.base_url,"
            " verified_at = EXCLUDED.verified_at, status = 'active', updated_at = now()",
            (
                user_id, provider, psycopg.Binary(ciphertext), psycopg.Binary(nonce),
                fingerprint, base_url, datetime.datetime.now(datetime.timezone.utc) if verified else None,
            ),
        )
    return fingerprint


def provider_key_delete(user_id: str, provider: str) -> bool:
    with db() as conn:
        return conn.execute(
            "DELETE FROM provider_key WHERE user_id = %s AND provider = %s", (user_id, provider)
        ).rowcount > 0


def provider_selection_get(user_id: str) -> dict[str, Any] | None:
    with db() as conn:
        return conn.execute(
            "SELECT * FROM provider_selection WHERE user_id = %s", (user_id,)
        ).fetchone()


def provider_selection_set(user_id: str, provider: str, model_id: str) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO provider_selection (user_id, provider, model_id) VALUES (%s, %s, %s)"
            " ON CONFLICT (user_id) DO UPDATE SET provider = EXCLUDED.provider,"
            " model_id = EXCLUDED.model_id, updated_at = now()",
            (user_id, provider, model_id),
        )


def provider_selection_clear(user_id: str) -> None:
    with db() as conn:
        conn.execute("DELETE FROM provider_selection WHERE user_id = %s", (user_id,))


def providers_delete_all(user_id: str) -> None:
    """§7.13 account-deletion cascade: drop both tables' rows for the user."""
    with db() as conn:
        conn.execute("DELETE FROM provider_selection WHERE user_id = %s", (user_id,))
        conn.execute("DELETE FROM provider_key WHERE user_id = %s", (user_id,))


def provider_config_view(user_id: str) -> dict[str, Any]:
    """The masked view every /providers/config response returns: selection plus
    key fingerprints; the key itself is never in any response (§8.3)."""
    selection = provider_selection_get(user_id)
    keys = []
    for row in provider_keys(user_id):
        entry: dict[str, Any] = {
            "provider": row["provider"],
            "fingerprint": row["fingerprint"],
            "verified": row["verified_at"] is not None,
            "verifiedAt": row["verified_at"].isoformat() if row["verified_at"] else None,
        }
        if row["base_url"]:
            entry["baseUrl"] = row["base_url"]
        keys.append(entry)
    return {
        "selection": None
        if selection is None
        else {"provider": selection["provider"], "modelId": selection["model_id"]},
        "keys": keys,
    }


# ── RFC 0024 §10: per-user MCP credentials (encrypted under the same KEK) ──

def mcp_key_aad(user_id: str, server_id: str) -> bytes:
    """AAD binds each ciphertext to its owner and to the MCP domain: a row can
    be swapped neither onto another user nor onto a provider_key (§10.1)."""
    return user_id.encode() + b"mcp:" + server_id.encode()


def mcp_token_encrypt(user_id: str, server_id: str, token: str) -> tuple[bytes, bytes]:
    nonce = os.urandom(12)
    ciphertext = AESGCM(load_kek()).encrypt(nonce, token.encode(), mcp_key_aad(user_id, server_id))
    return ciphertext, nonce


def mcp_token_decrypt(user_id: str, server_id: str, ciphertext: bytes, nonce: bytes) -> str:
    try:
        return AESGCM(load_kek()).decrypt(nonce, bytes(ciphertext), mcp_key_aad(user_id, server_id)).decode()
    except Exception as exc:
        raise ManagerError(
            "kek_unavailable", f"mcp token ciphertext undecryptable ({type(exc).__name__})"
        )


def mcp_servers_get(user_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        return conn.execute(
            "SELECT * FROM mcp_server WHERE user_id = %s ORDER BY server_id", (user_id,)
        ).fetchall()


def mcp_server_set(user_id: str, server_id: str, enabled: bool, token: str | None) -> None:
    """Upsert one row. A token replaces the stored one; without a token the
    stored ciphertext (if any) is kept, so `enabled` flips never lose a key."""
    with db() as conn:
        if token is not None:
            ciphertext, nonce = mcp_token_encrypt(user_id, server_id, token)
            conn.execute(
                "INSERT INTO mcp_server (user_id, server_id, enabled, ciphertext, nonce)"
                " VALUES (%s, %s, %s, %s, %s)"
                " ON CONFLICT (user_id, server_id) DO UPDATE SET enabled = EXCLUDED.enabled,"
                " ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, updated_at = now()",
                (user_id, server_id, enabled, psycopg.Binary(ciphertext), psycopg.Binary(nonce)),
            )
        else:
            conn.execute(
                "INSERT INTO mcp_server (user_id, server_id, enabled) VALUES (%s, %s, %s)"
                " ON CONFLICT (user_id, server_id) DO UPDATE SET enabled = EXCLUDED.enabled,"
                " updated_at = now()",
                (user_id, server_id, enabled),
            )


def mcp_servers_view(user_id: str) -> dict[str, Any]:
    """The masked view of GET /mcp/servers: the deployment subset with each
    server's user state. A token is never returned, only whether one exists."""
    deployment = mcp_deployment()
    rows = {row["server_id"]: row for row in mcp_servers_get(user_id)}
    servers = []
    for entry in deployment:
        row = rows.get(entry["id"])
        servers.append({
            "id": entry["id"],
            "title": entry.get("title", entry["id"]),
            "network": entry.get("network"),
            "authRequired": bool((entry.get("auth") or {}).get("required")),
            "toolCount": len(entry.get("tools") or []),
            "writeTools": sum(1 for t in (entry.get("tools") or []) if t.get("tier") == "write"),
            "enabled": bool(row and row["enabled"]),
            "hasToken": bool(row and row["ciphertext"]),
        })
    return {"servers": servers}


_catalog_cache: list[dict[str, Any]] | None = None


def provider_catalog() -> list[dict[str, Any]]:
    """The catalog served verbatim (§5.1): generated at agent-image build time
    from pi-ai's static catalogs (agent/scripts/gen-provider-catalog.mjs), so
    catalog and provider wrappers always come from the same pi-ai version.
    Extracted from AGENT_IMAGE once and cached; no static fallback — an image
    without the file fails closed with catalog_unavailable."""
    global _catalog_cache
    if _catalog_cache is not None:
        return _catalog_cache
    try:
        raw = docker(
            "run", "--rm", "--network", "none", "--entrypoint", "cat",
            AGENT_IMAGE, CATALOG_PATH_IN_IMAGE, timeout=60,
        )
        doc = json.loads(raw)
        providers = doc["providers"]
        if not isinstance(providers, list) or not providers:
            raise ValueError("catalog has no providers")
    except Exception as exc:
        raise ManagerError(
            "catalog_unavailable",
            f"cannot read {CATALOG_PATH_IN_IMAGE} from {AGENT_IMAGE} ({type(exc).__name__});"
            " rebuild affido-agent",
        )
    if FAKE_UPSTREAM_CONTAINER and PROVIDER_DEV_HTTP:
        providers.append(
            {
                "id": "e2e-fake",
                "name": "E2E fake upstream (dev)",
                "baseUrl": f"http://{FAKE_UPSTREAM_CONTAINER}:{FAKE_UPSTREAM_PORT}/v1",
                "builtin": False,
                "models": [{"id": "e2e-fake-1", "name": "e2e-fake-1", "reasoning": False}],
            }
        )
    _catalog_cache = providers
    return providers


def catalog_entry(provider: str) -> dict[str, Any]:
    for entry in provider_catalog():
        if entry.get("id") == provider:
            return entry
    raise ManagerError("unknown_provider", f"provider '{provider}' is not in the catalog", 400)


# ── BYOK validation: §5.1 rules + §5.6 upstream check (TOCTOU-safe) ─────────


def _url_parts(base_url: str) -> urllib.parse.SplitResult:
    """Scheme/shape rules of §5.1. https only; http is a dev flag for the fake
    upstream e2e. Length <= 2048, host required, no userinfo/query/fragment."""
    if len(base_url) > 2048:
        raise ManagerError("invalid_base_url", "baseUrl must be at most 2048 characters", 400)
    parts = urllib.parse.urlsplit(base_url)
    allowed = ("https",) if not PROVIDER_DEV_HTTP else ("https", "http")
    if parts.scheme not in allowed:
        raise ManagerError(
            "invalid_base_url", "baseUrl must be https://" + (" (http needs PROVIDER_DEV_HTTP=1)" if parts.scheme == "http" else ""), 400,
        )
    if not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ManagerError("invalid_base_url", "baseUrl must be a plain https URL with a host", 400)
    return parts


def _resolve(hostname: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        raise ManagerError("invalid_base_url", f"cannot resolve {hostname}", 400)
    return [ipaddress.ip_address(info[4][0]) for info in infos]


def check_custom_base_url(base_url: str) -> None:
    """User-supplied custom baseUrls (the manager-side SSRF surface, §5.1):
    every DNS answer must be a public address — RFC1918 and docker networks
    are is_global == False and rejected."""
    parts = _url_parts(base_url)
    addresses = _resolve(parts.hostname)
    if any(not address.is_global for address in addresses):
        raise ManagerError(
            "invalid_base_url", f"{parts.hostname} resolves into a private or docker network", 400
        )


def validate_upstream(
    base_url: str,
    api_key: str,
    require_public: bool,
    timeout: float = 10.0,
    path_suffix: str = "/models",
) -> None:
    """§5.6 optional upstream validation, TOCTOU-safe: resolve the DNS name
    once, enforce the §5.1 rules on the resolved addresses (public-only when
    the URL is user-supplied), then connect to that verified address while the
    hostname stays in Host (and SNI). Non-2xx on GET {base}{path_suffix} is
    `invalid_key`; connection problems surface as `validation_failed` without
    a stored verdict — the key is then simply unverified (§7.2).

    path_suffix defaults to /models but comes from the catalog entry's
    validatePath where the upstream's /models does not actually check auth:
    OpenRouter's /models is public and ignores Authorization (any garbage key
    answers 200, verified 2026-10), so its entry pins /key, the auth-required
    account endpoint. The suffix originates in the operator-built agent image
    but is shape-checked anyway — the request line is built by concatenation,
    so a malformed value must never reach the socket."""
    if not re.fullmatch(r"/[A-Za-z0-9._/-]+", path_suffix or "") or ".." in path_suffix:
        raise ManagerError(
            "invalid_catalog", f"catalog validatePath {path_suffix!r} is not a plain path", 500
        )
    parts = _url_parts(base_url)
    addresses = _resolve(parts.hostname)
    if require_public and any(not address.is_global for address in addresses):
        raise ManagerError("invalid_base_url", f"{parts.hostname} resolves into a private or docker network", 400)
    address = addresses[0]
    port = parts.port or (443 if parts.scheme == "https" else 80)
    path = parts.path.rstrip("/") + path_suffix
    try:
        sock = socket.create_connection((str(address), port), timeout=timeout)
        if parts.scheme == "https":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=parts.hostname)
        with sock:
            sock.sendall(
                f"GET {path} HTTP/1.1\r\nHost: {parts.hostname}\r\n"
                f"Authorization: Bearer {api_key}\r\nAccept: application/json\r\n"
                "Connection: close\r\n\r\n".encode()
            )
            status_line = sock.recv(256).decode("latin-1", "replace")
    except (OSError, ssl.SSLError) as exc:
        raise ManagerError("validation_failed", f"{parts.hostname} did not answer: {type(exc).__name__}", 400)
    if not status_line.startswith("HTTP/"):
        raise ManagerError("validation_failed", f"{parts.hostname} sent a non-HTTP reply", 400)
    try:
        status = int(status_line.split(" ", 2)[1])
    except (IndexError, ValueError):
        raise ManagerError("validation_failed", f"cannot parse status from {parts.hostname}", 400)
    if not 200 <= status < 300:
        raise ManagerError("invalid_key", f"upstream answered {status} on GET {path}", 400)


# ── BYOK delivery: reconcile desired state into the running pair (§5.4, RFC 0013 §6.3) ──

FAUX_CONFIG = {"provider": "faux", "modelId": "faux-1"}


def desired_upstream(provider: str, key_row: dict[str, Any] | None) -> str | None:
    """The upstream the sidecar must pin for this selection: the user-registered
    custom endpoint when one is stored, else the catalog entry's baseUrl (the
    operator-built agent image), null for faux/keyless."""
    if provider == "faux" or key_row is None:
        return None
    if key_row.get("base_url"):
        return str(key_row["base_url"])
    entry = catalog_entry(provider)  # unknown_provider: fail closed, never guess
    return str(entry.get("baseUrl") or "") or None


def reconcile_provider(user_id: str, container: str, sidecar: str | None = None) -> None:
    """RFC 0012 §5.4 steps 2-5 as amended by RFC 0013 §5: the delivery split.

    Desired state is the OLTP row. The runtime state is read from BOTH halves
    of the pair: the sidecar's /status (provider, modelId, keyFingerprint,
    upstream — the key half) and the agent's /status (model, keyVia — the
    keyless half). On mismatch — or when a stopped sidecar lost its in-memory
    key — decrypt and POST the key payload to the sidecar, then the keyless
    payload ({provider, modelId, viaSidecar: true, baseUrl?}) to the agent.
    Never writes the key anywhere docker create owns (R3/R5). Raises
    ManagerError (egress_blocked §7.11, kek_unavailable §7.9, agent_image_old
    §7.5, sidecar_unhealthy §8) so resolve fails closed instead of silently
    degrading to faux."""
    selection = provider_selection_get(user_id)
    try:
        status = agent_get(container, "/status", timeout=5.0)
        side_status = sidecar_get(sidecar, "/status", timeout=5.0) if sidecar else {}
    except Exception:
        return  # healthy moments ago; the reconcile tick or next resolve repairs
    model = status.get("model") or {}
    current = (model.get("provider"), model.get("modelId"), status.get("keyFingerprint"))
    if selection is None:
        if current[0] not in (None, "faux"):
            agent_post(container, "/config", FAUX_CONFIG)  # §5.4 step 5
            if sidecar and side_status.get("provider") not in (None, "faux"):
                # The sidecar drops its key: nothing of the old selection stays in RAM.
                sidecar_post(sidecar, "/config", FAUX_CONFIG)
        return
    provider, model_id = selection["provider"], selection["model_id"]
    key_row = None
    if provider != "faux":
        key_row = provider_key_get(user_id, provider)
    want_fingerprint = key_row["fingerprint"] if key_row else None
    if provider == "faux" or key_row is None:
        # Keyless selection (faux, or a model without a stored key): the agent
        # half alone, exactly as RFC 0012 delivered it — but a stale sidecar-mode
        # runtime must not satisfy the match.
        keyless_match = (
            (provider, model_id, want_fingerprint) == current
            and status.get("keyVia") in (None, "direct")
        )
        if keyless_match:
            return
        if provider != "faux" and AGENT_EGRESS != "open":
            raise ManagerError(
                "egress_blocked",
                f"provider '{provider}' is selected but AGENT_EGRESS is not open"
                " (§7.11: fail closed, never a silent faux fallback)",
            )
        payload: dict[str, Any] = {"provider": provider, "modelId": model_id}
        if key_row is not None and key_row.get("base_url"):
            payload["baseUrl"] = key_row["base_url"]
        agent_post(container, "/config", payload)
        return
    if AGENT_EGRESS != "open":
        raise ManagerError(
            "egress_blocked",
            f"provider '{provider}' is selected but AGENT_EGRESS is not open"
            " (§7.11: fail closed, never a silent faux fallback)",
        )
    if sidecar is None:
        raise ManagerError("sidecar_unhealthy", "a keyed selection needs the sidecar pair")
    if "keyVia" not in status:
        # An image from before RFC 0013 ignores the viaSidecar field and would
        # register a keyless provider: refuse instead (§7.5 discipline).
        raise ManagerError(
            "agent_image_old",
            f"{container} runs an image without sidecar-mode /config; rebuild affido-agent and reprovision",
        )
    want_upstream = desired_upstream(provider, key_row)
    side_match = (
        side_status.get("provider") == provider
        and side_status.get("modelId") == model_id
        and side_status.get("keyFingerprint") == want_fingerprint
        and (want_upstream is None or side_status.get("upstream") == want_upstream)
    )
    agent_match = (
        model.get("provider") == provider
        and model.get("modelId") == model_id
        and status.get("keyVia") == "sidecar"
    )
    if side_match and agent_match:
        return
    side_payload: dict[str, Any] = {
        "provider": provider,
        "modelId": model_id,
        "apiKey": decrypt_key(user_id, provider, key_row["ciphertext"], key_row["nonce"]),
    }
    if key_row.get("base_url"):
        side_payload["baseUrl"] = key_row["base_url"]
    sidecar_post(sidecar, "/config", side_payload)
    agent_payload: dict[str, Any] = {"provider": provider, "modelId": model_id, "viaSidecar": True}
    if key_row.get("base_url"):
        # Not a secret: the agent resolves its models' compat quirks from the
        # real URL before the sidecar rewrite (RFC 0013 §4 A3).
        agent_payload["baseUrl"] = key_row["base_url"]
    agent_post(container, "/config", agent_payload)
    log.info(
        "provider config delivered user=%s provider=%s fingerprint=%s via=sidecar",
        user_id, provider, want_fingerprint,
    )


# ── docker ──────────────────────────────────────────────────────────────────
def docker(*args: str, check: bool = True, timeout: int = 120) -> str:
    cp = subprocess.run(
        ["docker", *args], capture_output=True, text=True, timeout=timeout
    )
    if check and cp.returncode != 0:
        raise RuntimeError(f"docker {' '.join(args)} failed: {cp.stderr.strip()}")
    return cp.stdout


def network_exists(name: str) -> bool:
    cp = subprocess.run(
        ["docker", "network", "inspect", name], capture_output=True, text=True
    )
    return cp.returncode == 0


# ── host wall: docker has no knob for the bridge-to-host INPUT path ────────
# `--internal` stops forwarding off the bridge, but the bridge gateway is a
# host interface: packets addressed to it reach the host INPUT chain, where
# any 0.0.0.0-bound host service answers (proven by e2e-test/security.sh).
HOSTWALL_COMMENT = "pi-sandbox-hostwall"


def bridge_iface(net_id: str) -> str:
    """Host bridge interface name of a docker network id (br-<first 12>)."""
    return "br-" + net_id[:12]


def hostwall(script: str) -> None:
    """Run an iptables script in the host network namespace.

    The helper is this manager's own image (by tag, via MANAGER_CONTAINER's
    Config.Image), short-lived, and only ever runs scripts this module wrote: no
    user input reaches it (bridge names derive from docker network ids). The
    tag, not the digest: on containerd-store daemons a rebuild can garbage-
    collect the digest a running container still reports, and `docker run
    <digest>` would then fail with "No such image" mid-provision.
    """
    if not MANAGER_CONTAINER:
        raise RuntimeError("HOSTWALL needs MANAGER_CONTAINER (compose container name)")
    image = docker("inspect", "-f", "{{.Config.Image}}", MANAGER_CONTAINER).strip()
    docker(
        "run", "--rm", "--network", "host", "--cap-add", "NET_ADMIN",
        "--entrypoint", "sh", image, "-c", script,
    )


def hostwall_ensure(net_id: str) -> None:
    """Idempotently install the INPUT DROP rule for one sandbox bridge."""
    iface = bridge_iface(net_id)
    hostwall(
        f"iptables -C INPUT -i {iface} -m comment --comment {HOSTWALL_COMMENT} -j DROP "
        f"2>/dev/null || "
        f"iptables -I INPUT 1 -i {iface} -m comment --comment {HOSTWALL_COMMENT} -j DROP "
        f"|| exit 1"
    )


def hostwall_reconcile() -> None:
    """Re-assert walls for every labelled network and drop stale rules.

    Daemon restarts flush iptables while network objects survive, so this
    runs on the reconcile tick: cheap in-kernel checks in one helper run.
    """
    net_ids = docker(
        "network", "ls", "-q", "--filter", "label=pi-sandbox-manager=1"
    ).split()
    wanted = " ".join(bridge_iface(n) for n in net_ids)
    hostwall(
        "for i in " + wanted + " ; do "
        f"iptables -C INPUT -i $i -m comment --comment {HOSTWALL_COMMENT} -j DROP 2>/dev/null || "
        f"iptables -I INPUT 1 -i $i -m comment --comment {HOSTWALL_COMMENT} -j DROP || exit 1; "
        "done; "
        f"for r in $(iptables -S INPUT | sed -n \"s/^-A INPUT -i \\([^ ]*\\).*{HOSTWALL_COMMENT}.*/\\1/p\"); do "
        f"case \" {wanted} \" in *\" $r \"*) ;; *) "
        f"iptables -D INPUT -i $r -m comment --comment {HOSTWALL_COMMENT} -j DROP || true;; esac; "
        "done"
    )


def docker_running(container: str) -> bool | None:
    """True / False if the container exists, None if it does not."""
    cp = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", container],
        capture_output=True,
        text=True,
    )
    if cp.returncode != 0:
        return None
    return cp.stdout.strip() == "true"


def guest_ips(net: str) -> dict[str, str]:
    """Per-network IPs of the control-plane guests, for the sandbox's --add-host.

    gVisor's netstack does not serve Docker's embedded DNS: 127.0.0.11 is an
    iptables DNAT inside the container netns, which netstack ignores, so
    container-name resolution is dead under runsc (ECONNREFUSED). The manager
    knows the guests and connects them to every sandbox network, so it bakes
    their names into /etc/hosts at create time. Stale after a guest is
    recreated with a new IP (fine: production agents never dial the control
    plane by name, the peer guard forbids it); a reprovision refreshes them.
    """
    cp = subprocess.run(
        ["docker", "network", "inspect", "-f",
         "{{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}", net],
        capture_output=True, text=True,
    )
    if cp.returncode != 0:
        return {}
    ips: dict[str, str] = {}
    for pair in cp.stdout.split():
        name, _, cidr = pair.partition("=")
        if name in control_plane_guests():
            ips[name] = cidr.split("/", 1)[0]
    return ips


def hardening_args() -> list[str]:
    """RFC 0013 §6.4 Phase 0 (P0.1 seccomp, P0.2 core=0, P0.3 cap-drop ALL),
    applied to every container this manager creates. The seccomp profile path
    is read client-side by the docker CLI from this image. cap-drop ALL is
    the runtime-independent layer that kills AF_PACKET/ARP spoofing of the
    per-user bridge even if some future runtime hands raw sockets back:
    neither process needs a Linux capability — ports 8080/8081 are >1024,
    /workspace and /data are root-owned named volumes matched by uid, the
    healthcheck is a Node fetch, and the sidecar does HTTP/TLS outbound only."""
    return [
        "--security-opt", f"seccomp={SECCOMP_PROFILE}",
        "--ulimit", "core=0",
        "--cap-drop", "ALL",
    ]


def create_args(user_id: str, hosts: dict[str, str] | None = None) -> list[str]:
    name = container_name(user_id)
    args = [
        "create", "--name", name,
        "--network", network_name(user_id),
        "--label", "pi-sandbox-manager=1",
        "--memory", AGENT_MEMORY,
        "--cpus", AGENT_CPUS,
        "--runtime", AGENT_RUNTIME,
        "--security-opt", "no-new-privileges",
        *hardening_args(),
        "--workdir", "/workspace",
        "-v", f"{workspace_vol(user_id)}:/workspace",
        "-v", f"{data_vol(user_id)}:/data",
        "-e", f"AGENT_NAME={name}",
        "-e", "WORKSPACE=/workspace",
        "-e", "SESSION_DB=/data/session.sqlite",
        "-e", f"IDLE_MS={AGENT_IDLE_MS}",
        "-e", f"PORT={AGENT_PORT}",
        # RFC 0013 §6.2: where the agent finds its sidecar. Inert until a
        # viaSidecar /config delivery arrives; faux/keyless runs never dial it.
        "-e", f"SIDECAR_URL=http://{sidecar_name(user_id)}:{SIDECAR_PORT}",
        # RFC 0016: the node the web tools dial. Inert for faux/keyless chat.
        "-e", f"WEBSEARCH_URL=http://{websearch_name(user_id)}:{WEBSEARCH_PORT}",
    ]
    # RFC 0024 §6: the MCP surface exists only when the deployment offers
    # servers. The subset is resolved against the catalog here, so a bad
    # MCP_SERVERS id never reaches the agent's fail-loud boot check.
    deployment = mcp_deployment()
    if deployment:
        args += [
            "-e", "MCP_SERVERS=" + ",".join(entry["id"] for entry in deployment),
            "-e", f"MCP_URL=http://{mcp_node_name(user_id)}:{MCP_PORT}",
        ]
    if AGENT_CITATIONS_DEFAULT:
        # RFC 0006 §5.9: the mode of /prompt requests that omit the `citations`
        # field. Sandbox env is fixed at create; the per-request field always wins.
        args += ["-e", f"CITATIONS_DEFAULT={AGENT_CITATIONS_DEFAULT}"]
    if AGENT_CITATION_JUDGE:
        # RFC 0017 §3 / RFC 0018 §5: the coherence layer's mode. No secret ever
        # travels here; the judge target resolves from the run's own provider.
        args += ["-e", f"CITATION_JUDGE={AGENT_CITATION_JUDGE}"]
    for name, value in (
        ("CITATION_JUDGE_PAIR_TIMEOUT_MS", AGENT_CITATION_JUDGE_PAIR_TIMEOUT_MS),
        ("CITATION_JUDGE_CONCURRENCY", AGENT_CITATION_JUDGE_CONCURRENCY),
        ("CITATION_JUDGE_RUN_BUDGET_MS", AGENT_CITATION_JUDGE_RUN_BUDGET_MS),
    ):
        # RFC 0020 §4.3: the derived judge budget, verbatim; the agent asserts
        # the constants' invariant at load, so a bad value fails the boot loudly.
        if value:
            args += ["-e", f"{name}={value}"]
    for name, ip in sorted((hosts or {}).items()):
        args += ["--add-host", f"{name}:{ip}"]
    if AGENT_DNS:
        # With AGENT_EGRESS=off this is unroutable and name resolution fails
        # fast, which is the intended fail-closed behavior; with egress open it
        # is the only resolver a runsc sandbox has (see guest_ips).
        args += ["--dns", AGENT_DNS]
    args.append(AGENT_IMAGE)
    return args


def sidecar_create_args(user_id: str, hosts: dict[str, str] | None = None) -> list[str]:
    """RFC 0013 §6.3: the sidecar half of the pair. Same per-user --internal
    network, no volumes (its whole state is one key in RAM), no published
    ports (R6), gVisor runtime and Phase 0 hardening like the agent, own
    reduced caps (R10). No env secrets: the key arrives over POST /config
    from this manager and never appears in docker create (R3). The guest map
    is baked like the agent's so the e2e fake upstream (a control-plane
    guest) is resolvable under runsc, where Docker's embedded DNS is dead."""
    args = [
        "create", "--name", sidecar_name(user_id),
        "--network", network_name(user_id),
        "--label", "pi-sandbox-manager=1",
        "--memory", SIDECAR_MEMORY,
        "--cpus", SIDECAR_CPUS,
        "--runtime", AGENT_RUNTIME,
        "--security-opt", "no-new-privileges",
        *hardening_args(),
        "--workdir", "/app",
        "-e", f"PORT={SIDECAR_PORT}",
        "-e", f"PROVIDER_CATALOG={CATALOG_PATH_IN_IMAGE}",
    ]
    for name, ip in sorted((hosts or {}).items()):
        args += ["--add-host", f"{name}:{ip}"]
    if AGENT_DNS:
        # Internet names (real provider upstreams) resolve only with
        # AGENT_EGRESS=open; with egress off this fails fast, which is fine.
        args += ["--dns", AGENT_DNS]
    # The agent image has no ENTRYPOINT, so overriding CMD selects the second
    # entrypoint of the same image (RFC 0013 §6.1: one image, two entrypoints).
    args += [AGENT_IMAGE, "sh", "-c", "ulimit -c 0 && exec node /app/sidecar.ts"]
    return args


def websearch_create_args(
    user_id: str,
    hosts: dict[str, str] | None = None,
    peers: list[str] | None = None,
) -> list[str]:
    """RFC 0016 §4: the web-search node of one user's sandbox.

    Same per-user --internal network as the agent (the only edge into it), plus
    the shared search network attached by provision() after create. No volumes:
    a fetched page has nowhere to be written. No published ports. gVisor and
    the Phase 0 hardening apply like every other container this manager
    creates. `WEBSEARCH_PEERS` is the per-user subnet: the node refuses peers
    outside it, so another tenant's node on websearch-in is not a caller.

    SearXNG and Camofox are resolved through baked /etc/hosts entries, not
    Docker's embedded DNS (dead under runsc). The operator's hostnames must
    match the containers on WEBSEARCH_IN; a missing entry makes the node fail
    its upstream call, never the sandbox.

    The Camofox key is a shared operator secret, not a tenant credential: it
    travels in the node's env and never reaches the sandbox (no tool echoes it).
    """
    args = [
        "create", "--name", websearch_name(user_id),
        "--network", network_name(user_id),
        "--label", "pi-sandbox-manager=1",
        "--memory", WEBSEARCH_MEMORY,
        "--cpus", WEBSEARCH_CPUS,
        "--runtime", AGENT_RUNTIME,
        "--security-opt", "no-new-privileges",
        *hardening_args(),
        "--workdir", "/app",
        "-e", f"PORT={WEBSEARCH_PORT}",
        "-e", "WEBSEARCH_PEERS=" + ",".join(peers or []),
        "-e", f"SEARXNG_URL={SEARXNG_URL}",
        "-e", f"CAMOFOX_URL={CAMOFOX_URL}",
        "-e", f"WEBSEARCH_USER={slug(user_id)}",
    ]
    if CAMOFOX_API_KEY:
        args += ["-e", f"CAMOFOX_API_KEY={CAMOFOX_API_KEY}"]
    for name, ip in sorted((hosts or {}).items()):
        args += ["--add-host", f"{name}:{ip}"]
    # Same image, third entrypoint: no internet DNS is configured on purpose.
    args += [AGENT_IMAGE, "sh", "-c", "ulimit -c 0 && exec node /app/websearch.ts"]
    return args


def mcp_create_args(
    user_id: str,
    hosts: dict[str, str] | None = None,
    peers: list[str] | None = None,
) -> list[str]:
    """RFC 0024 §5: the per-user MCP node.

    Same per-user --internal network as the agent (the only edge into it); the
    two shared MCP legs are attached by provision() after create. No volumes,
    no published ports, read-only rootfs with a /tmp tmpfs (the node writes
    nothing; M1). The control token is baked here from the manager's own
    secret — docker create env, which no other container can read — so a bash
    child of the sandbox (same subnet, different container) can never forge a
    config delivery or win a first-set race. `MCP_PEERS` is the per-user
    subnet, exactly like the web-search node."""
    args = [
        "create", "--name", mcp_node_name(user_id),
        "--network", network_name(user_id),
        "--label", "pi-sandbox-manager=1",
        "--memory", MCP_MEMORY,
        "--cpus", MCP_CPUS,
        "--runtime", AGENT_RUNTIME,
        "--security-opt", "no-new-privileges",
        *hardening_args(),
        "--read-only",
        "--tmpfs", "/tmp:rw,size=16m,noexec",
        "--workdir", "/app",
        "-e", f"PORT={MCP_PORT}",
        "-e", "MCP_PEERS=" + ",".join(peers or []),
        "-e", f"MCP_CONTROL_TOKEN={mcp_control_token(user_id)}",
        "-e", f"MCP_CATALOG={MCP_CATALOG_PATH_IN_IMAGE}",
    ]
    for name, ip in sorted((hosts or {}).items()):
        args += ["--add-host", f"{name}:{ip}"]
    # Same image, fourth entrypoint. No DNS: only catalog hosts are baked.
    args += [AGENT_IMAGE, "sh", "-c", "ulimit -c 0 && exec node /app/mcp-gateway.ts"]
    return args


def control_plane_guests() -> list[str]:
    """Containers the manager attaches to every per-user network: the callers
    that must reach the agent (caddy, web) plus the optional e2e fake upstream
    (RFC 0012 §10 M2: a same-subnet stand-in for a real OpenAI-compatible
    provider). None of them is ever an agent container."""
    return [g for g in (MANAGER_CONTAINER, CADDY_CONTAINER, WEB_CONTAINER,
                        FAKE_UPSTREAM_CONTAINER) if g]


def ensure_guests(user_id: str) -> None:
    """Re-join the manager, Caddy and the web app to an existing user network.

    The manager is recreated by `docker compose up` and then loses every
    per-user network attachment. New provisions connect the guests, but an
    already-created sandbox would stay unreachable until it is reprovisioned.
    """
    net = network_name(user_id)
    cp = subprocess.run(
        ["docker", "network", "inspect", "-f",
         "{{range .Containers}}{{.Name}} {{end}}", net],
        capture_output=True, text=True,
    )
    if cp.returncode != 0:
        return
    connected = set(cp.stdout.split())
    for guest in control_plane_guests():
        if guest not in connected:
            docker("network", "connect", net, guest, check=False)


def ensure_started(container: str) -> None:
    state = docker_running(container)
    if state is None:
        raise RuntimeError(f"container {container} does not exist")
    if not state:
        docker("start", container)


# ── sandbox HTTP client (stdlib; /health never activates the agent) ───────

def _container_get(container: str, port: int, path: str, timeout: float = 3.0) -> dict[str, Any]:
    url = f"http://{container}:{port}{path}"
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode())


def _container_post(
    container: str, port: int, path: str, payload: dict[str, Any], timeout: float = 15.0
) -> dict[str, Any]:
    """POST JSON to a sandbox container on its per-user network (RFC 0012
    §5.4 delivery; RFC 0013 splits the payload between agent and sidecar)."""
    url = f"http://{container}:{port}{path}"
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        # §7.5: an image that predates POST /config answers 404. Resolve then
        # fails with agent_image_old instead of routing users to a sandbox that
        # can never receive the desired provider.
        if exc.code == 404:
            raise ManagerError(
                "agent_image_old",
                f"{container} runs an image without {path}; rebuild affido-agent and reprovision",
            )
        raise ManagerError("delivery_failed", f"{container} {path} answered {exc.code}")
    except urllib.error.URLError as exc:
        raise ManagerError("delivery_failed", f"{container} {path} unreachable: {exc.reason}")


def agent_get(container: str, path: str, timeout: float = 3.0) -> dict[str, Any]:
    return _container_get(container, AGENT_PORT, path, timeout)


def agent_post(container: str, path: str, payload: dict[str, Any], timeout: float = 15.0) -> dict[str, Any]:
    return _container_post(container, AGENT_PORT, path, payload, timeout)


def sidecar_get(container: str, path: str, timeout: float = 3.0) -> dict[str, Any]:
    return _container_get(container, SIDECAR_PORT, path, timeout)


def sidecar_post(container: str, path: str, payload: dict[str, Any], timeout: float = 15.0) -> dict[str, Any]:
    return _container_post(container, SIDECAR_PORT, path, payload, timeout)


def websearch_get(container: str, path: str, timeout: float = 3.0) -> dict[str, Any]:
    return _container_get(container, WEBSEARCH_PORT, path, timeout)


def websearch_post(container: str, path: str, payload: dict[str, Any], timeout: float = 5.0) -> dict[str, Any]:
    return _container_post(container, WEBSEARCH_PORT, path, payload, timeout)


def mcp_get(container: str, path: str, timeout: float = 3.0) -> dict[str, Any]:
    return _container_get(container, MCP_PORT, path, timeout)


def mcp_post(
    container: str, path: str, payload: dict[str, Any],
    token: str | None = None, timeout: float = 5.0,
) -> dict[str, Any]:
    """POST JSON to the MCP node. The config route carries the control token
    the node's env already holds (RFC 0024 §7.1)."""
    url = f"http://{container}:{MCP_PORT}{path}"
    headers = {"content-type": "application/json"}
    if token:
        headers["X-Control-Token"] = token
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST", headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        raise ManagerError("delivery_failed", f"{container} {path} answered {exc.code}")
    except urllib.error.URLError as exc:
        raise ManagerError("delivery_failed", f"{container} {path} unreachable: {exc.reason}")


def agent_alive(container: str) -> bool:
    try:
        agent_get(container, "/health", timeout=2.0)
        return True
    except Exception:
        return False


def sidecar_alive(container: str) -> bool:
    try:
        sidecar_get(container, "/health", timeout=2.0)
        return True
    except Exception:
        return False


def websearch_alive(container: str) -> bool:
    try:
        websearch_get(container, "/health", timeout=2.0)
        return True
    except Exception:
        return False


def mcp_alive(container: str) -> bool:
    try:
        mcp_get(container, "/health", timeout=2.0)
        return True
    except Exception:
        return False


# ── peer guard: the API never answers sandbox containers ───────────────────
# The manager is attached to every per-user network to health-check agents, so
# its HTTP API is L3-reachable from containers that run user code. The token is
# one wall; this is the second: any peer whose IP sits on a per-user network and
# is not one of the control-plane guests on it (manager, caddy, web) is an agent
# container and gets 403 before any endpoint logic runs.
PEER_CACHE_S = int(os.getenv("PEER_CACHE_S", "10"))
_peer_cache: dict[str, Any] = {
    "at": 0.0,
    "sandbox_subnets": frozenset(),  # networks labelled pi-sandbox-manager=1
    "known_subnets": frozenset(),    # every other docker network
    "guests": frozenset(),           # manager/caddy/web IPs, any network
}
_last_forced: list[float] = [0.0]


def refresh_peer_cache() -> None:
    """Snapshot every docker network in two CLI calls: which subnets belong to
    per-user sandboxes, and which IPs the control-plane guests hold. Two calls
    (not one per network) so a forced refresh stays cheap enough to run on the
    request path."""
    ids = docker("network", "ls", "-q").split()
    sandbox: set[ipaddress.IPv4Network] = set()
    known: set[ipaddress.IPv4Network] = set()
    guests: set[str] = set()
    guest_names = {g for g in (MANAGER_CONTAINER, CADDY_CONTAINER, WEB_CONTAINER,
                               FAKE_UPSTREAM_CONTAINER) if g}
    for start in range(0, len(ids), 50):  # stay far below ARG_MAX
        chunk = ids[start : start + 50]
        doc = json.loads(docker("network", "inspect", *chunk))
        for net in doc:
            subnets = []
            for cfg in (net.get("IPAM") or {}).get("Config") or []:
                raw = cfg.get("Subnet")
                if raw:
                    try:
                        subnets.append(ipaddress.ip_network(raw))
                    except ValueError:
                        continue
            if not subnets:
                continue
            is_sandbox = (net.get("Labels") or {}).get("pi-sandbox-manager") == "1"
            for subnet in subnets:
                (sandbox if is_sandbox else known).add(subnet)
            for container in (net.get("Containers") or {}).values():
                if container.get("Name") in guest_names:
                    address = (container.get("IPv4Address") or "").split("/")[0]
                    if address:
                        guests.add(address)
    _peer_cache["at"] = time.time()
    _peer_cache["sandbox_subnets"] = frozenset(sandbox)
    _peer_cache["known_subnets"] = frozenset(known)
    _peer_cache["guests"] = frozenset(guests)


def invalidate_peer_cache() -> None:
    """A network was just created: the next guarded request must re-snapshot
    before deciding, or a brand-new sandbox stays invisible to the guard for up
    to PEER_CACHE_S (exactly the provision-then-probe race an attacker rides)."""
    _peer_cache["at"] = 0.0


def _peer_class(peer: str) -> str | None:
    """"sandbox" when the peer is an agent container, "guest" for the
    control-plane containers, None when the peer sits on no known subnet."""
    try:
        address = ipaddress.ip_address(peer)
    except ValueError:
        return None
    if str(address) in _peer_cache["guests"]:
        return "guest"
    for subnet in _peer_cache["sandbox_subnets"]:
        if address in subnet:
            return "sandbox"
    for subnet in _peer_cache["known_subnets"]:
        if address in subnet:
            return "guest"  # non-sandbox docker network: not an agent
    return None


def is_sandbox_peer(peer: str) -> bool:
    """True when the peer address belongs to a per-user sandbox network and is
    not one of the guests (manager, caddy, web) — i.e. an agent container."""
    now = time.time()
    if now - _peer_cache["at"] > PEER_CACHE_S:
        try:
            refresh_peer_cache()
        except Exception:
            log.exception("peer cache refresh failed; keeping the last snapshot")
    if _peer_class(peer) == "sandbox":
        return True
    # A peer on NO known subnet may sit on a network created after the last
    # snapshot (every docker source is on some subnet). One forced refresh,
    # capped at one per second, closes that window even for networks this
    # manager did not create itself.
    if _peer_class(peer) is None and now - _last_forced[0] >= 1.0:
        _last_forced[0] = now
        try:
            refresh_peer_cache()
        except Exception:
            log.exception("forced peer cache refresh failed")
    return _peer_class(peer) == "sandbox"


def wait_healthy(container: str) -> dict[str, Any]:
    deadline = time.time() + READY_TIMEOUT_S
    while time.time() < deadline:
        try:
            return agent_get(container, "/health")
        except Exception:
            time.sleep(0.25)
    raise TimeoutError(f"{container} was not healthy within {READY_TIMEOUT_S}s")


def wait_healthy_sidecar(container: str) -> dict[str, Any]:
    """RFC 0013 §8: a sidecar that never answers fails the resolve closed with
    sidecar_unhealthy — same policy as egress_blocked, never a silent faux
    fallback or a keyless delivery to the agent."""
    deadline = time.time() + READY_TIMEOUT_S
    while time.time() < deadline:
        try:
            return sidecar_get(container, "/health")
        except Exception:
            time.sleep(0.25)
    raise ManagerError(
        "sidecar_unhealthy",
        f"sidecar {container} was not healthy within {READY_TIMEOUT_S}s"
        " (rebuild affido-agent and reprovision if it crash-loops)",
    )


def wait_healthy_websearch(container: str) -> dict[str, Any]:
    """The node's liveness. Unlike the sidecar this is not on the model path:
    a node that never answers is logged and the sandbox still serves chat, with
    the web tools reporting `websearch_unavailable` at call time. The deadline
    is shorter than the sidecar's on purpose: a broken optional node must not
    hold a cold provision for the full READY_TIMEOUT_S."""
    timeout = min(READY_TIMEOUT_S, 10)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return websearch_get(container, "/health")
        except Exception:
            time.sleep(0.25)
    raise TimeoutError(f"{container} was not healthy within {timeout}s")


def wait_healthy_mcp(container: str) -> dict[str, Any]:
    """The MCP node's liveness: same optional, short-deadline rule as the
    web-search node (RFC 0024's node is never on the chat path either)."""
    timeout = min(READY_TIMEOUT_S, 10)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return mcp_get(container, "/health")
        except Exception:
            time.sleep(0.25)
    raise TimeoutError(f"{container} was not healthy within {timeout}s")


def container_ip(net: str, container: str) -> str | None:
    """The IPv4 a container holds on one network (None when not connected)."""
    cp = subprocess.run(
        ["docker", "network", "inspect", "-f",
         "{{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}", net],
        capture_output=True, text=True,
    )
    if cp.returncode != 0:
        return None
    for pair in cp.stdout.split():
        name, _, cidr = pair.partition("=")
        if name == container:
            return cidr.split("/", 1)[0]
    return None


def mark_running(user_id: str, container: str) -> None:
    container_id = docker("inspect", "-f", "{{.Id}}", container).strip()
    registry_set(
        user_id, "running", container_id=container_id, endpoint=endpoint(user_id)
    )


def dns_rewrite(container: str) -> None:
    """Point the sandbox's resolver at AGENT_DNS first, Docker's embedded one
    as fallback.

    Two stacked gVisor facts: netstack does not serve 127.0.0.11 (it is an
    iptables DNAT inside a netns that netstack replaces), and on user-defined
    networks Docker never writes --dns into resolv.conf anyway -- it becomes an
    upstream of the embedded resolver instead. So under runsc the container
    has no working nameserver for internet names (real BYOK providers) until
    this rewrite. Written from inside, once per container lifetime: the file
    lives in the writable layer and survives stop/start. Non-fatal on failure:
    DNS is availability, not a wall; AGENT_EGRESS=off sandboxes never resolve
    anything legitimate either way.
    """
    cp = subprocess.run(
        ["docker", "exec", "-u", "0", container, "sh", "-c",
         'printf "nameserver %s\\nnameserver 127.0.0.11\\n" "$1" > /etc/resolv.conf',
         "dns", AGENT_DNS],
        capture_output=True, text=True,
    )
    if cp.returncode != 0:
        logging.warning("resolv.conf rewrite failed for %s: %s",
                        container, cp.stderr.strip())


def start_pair(user_id: str, container: str, sidecar: str) -> None:
    """Start the agent, its key sidecar and the web-search node (RFC 0013 R7,
    RFC 0016 §4).

    Re-runs the resolv.conf rewrite on every start: this daemon regenerates
    /etc/resolv.conf for user-defined networks at each container start, and
    under runsc the 127.0.0.11 it leaves behind is unreachable — without the
    rewrite, a pair that comes back from L1 eviction cannot resolve internet
    names (the sidecar's pinned upstreams first of all).

    The node has no internet names to resolve (its two upstreams are baked
    /etc/hosts entries) and its health is deliberately not fatal: chat still
    works while the search stack is down, and the web tools answer a named
    `websearch_unavailable` instead of failing the whole resolve."""
    websearch = websearch_name(user_id)
    try:
        ensure_started(websearch)
        wait_healthy_websearch(websearch)
    except Exception as exc:
        log.warning("web-search node %s is unavailable: %s", websearch, exc)
    if mcp_deployment():
        # Same non-fatal rule: a down MCP node costs the mcp__ tools, never chat.
        mcp = mcp_node_name(user_id)
        try:
            ensure_started(mcp)
            wait_healthy_mcp(mcp)
        except Exception as exc:
            log.warning("mcp node %s is unavailable: %s", mcp, exc)
    ensure_started(sidecar)
    if AGENT_DNS:
        dns_rewrite(sidecar)
    wait_healthy_sidecar(sidecar)
    ensure_started(container)
    if AGENT_DNS:
        dns_rewrite(container)
    wait_healthy(container)
    mark_running(user_id, container)


def provision(user_id: str) -> None:
    """Create the per-user network/volumes/agent+sidecar pair and the web-search
    node if absent, then start the group (RFC 0013 §6.3, RFC 0016 §4)."""
    container = container_name(user_id)
    sidecar = sidecar_name(user_id)
    websearch = websearch_name(user_id)
    if (
        docker_running(container) is None
        or docker_running(sidecar) is None
        or docker_running(websearch) is None
    ):
        net = network_name(user_id)
        created_net = False
        if not network_exists(net):
            # check=True: a failed create must not leave a container pointing at
            # a network that does not exist (e.g. exhausted address pools).
            docker(*network_create_args(), net)
            invalidate_peer_cache()
            created_net = True
        try:
            hostwall_ensure(docker("network", "inspect", "-f", "{{.Id}}", net).strip())
        except Exception:
            # fail closed: never leave a reachable sandbox behind a wall that
            # could not be proven (a network we just made is rolled back).
            if created_net:
                docker("network", "rm", net, check=False)
            raise
        # The manager and Caddy must reach the agent on its private network;
        # both need stable container names (compose `container_name:`).
        for guest in control_plane_guests():
            docker("network", "connect", net, guest, check=False)
        docker("volume", "create", workspace_vol(user_id))
        docker("volume", "create", data_vol(user_id))
        # RFC 0016: the shared search networks exist even when the operator's
        # SearXNG/Camofox are not attached yet; the node then fails its upstream
        # call with a named error instead of taking the sandbox down.
        ensure_websearch_networks()
        # RFC 0024 D1: the MCP legs exist before any node references them; the
        # catalog is read once here (docker run --rm, no network) so a broken
        # image fails the provision loudly, never silently empty.
        deployment = mcp_deployment()
        if deployment:
            ensure_mcp_networks()
        mcp_hosts = mcp_service_hosts(deployment) if deployment else {}
        hosts = guest_ips(net)
        sidecar_recreated = False
        if docker_running(sidecar) is None:
            docker(*sidecar_create_args(user_id, hosts))
            sidecar_recreated = True
        websearch_recreated = False
        if docker_running(websearch) is None or created_net:
            # A new per-user network has a new subnet, and the node's peer guard
            # is baked at create time: recreate it rather than leave it refusing
            # every caller.
            if docker_running(websearch) is not None:
                docker("rm", "-f", websearch, check=False)
            docker(*websearch_create_args(
                user_id,
                websearch_service_hosts(),
                network_subnets(net),
            ))
            websearch_recreated = True
        mcp = mcp_node_name(user_id)
        mcp_recreated = False
        if deployment and (docker_running(mcp) is None or created_net):
            # Same recreate rule as the web-search node, plus §5.3/R5: a
            # recreated node re-bakes every catalog host, so an address drift
            # heals on the next provision.
            if docker_running(mcp) is not None:
                docker("rm", "-f", mcp, check=False)
            docker(*mcp_create_args(user_id, mcp_hosts, network_subnets(net)))
            mcp_recreated = True
        # (Re-)attach the shared search network. Idempotent; a manager restart
        # or a rebuilt websearch-in can leave the node detached.
        docker("network", "connect", WEBSEARCH_IN, websearch, check=False)
        # (Re-)attach the MCP legs (D2): operator servers on mcp-in, the
        # third-party egress leg on mcp-out. Idempotent for the same reason.
        if deployment:
            docker("network", "connect", MCP_IN, mcp, check=False)
            docker("network", "connect", MCP_OUT, mcp, check=False)
        if (
            docker_running(container) is None
            or sidecar_recreated
            or websearch_recreated
            or mcp_recreated
        ):
            # The agent's routes to the sidecar and the node are baked /etc/hosts
            # entries (runsc cannot use Docker's embedded DNS), fixed at create
            # time. A recreated container may hold a new IP, so the agent is
            # recreated with it — durable state lives on volumes, nothing is
            # lost (R7).
            ensure_started(sidecar)
            ensure_started(websearch)
            sidecar_ip = container_ip(net, sidecar)
            websearch_ip = container_ip(net, websearch)
            if sidecar_ip is None:
                raise RuntimeError(f"sidecar {sidecar} has no address on {net}")
            if websearch_ip is None:
                raise RuntimeError(f"web-search node {websearch} has no address on {net}")
            baked = {**hosts, sidecar: sidecar_ip, websearch: websearch_ip}
            if deployment:
                ensure_started(mcp)
                mcp_ip = container_ip(net, mcp)
                if mcp_ip is None:
                    raise RuntimeError(f"mcp node {mcp} has no address on {net}")
                baked[mcp] = mcp_ip
            if docker_running(container) is not None:
                docker("rm", "-f", container, check=False)
            docker(*create_args(user_id, baked))
    start_pair(user_id, container, sidecar)


# ── RFC 0016 §7: per-run web authorisation ──────────────────────────────────

def websearch_control_token(user_id: str) -> str:
    """The node's control token for one user, derived from MANAGER_TOKEN.

    The node accepts a run registration only with this token, and only the
    trusted admission path in the agent holds it (delivered over /webconfig,
    kept in process memory, never in env or disk). A bash child of the sandbox
    cannot read it, so it cannot register a run and cannot search even though
    it shares the agent's network address. Deriving it from the manager secret
    keeps it stable across manager restarts; changing MANAGER_TOKEN requires
    reprovisioning the node (it refuses a different token).
    """
    if not MANAGER_TOKEN:
        raise ManagerError("token_unavailable", "MANAGER_TOKEN is required for web-search authorisation")
    return hmac.new(
        MANAGER_TOKEN.encode(), b"websearch:" + user_id.encode(), hashlib.sha256
    ).hexdigest()


def deliver_websearch_control(user_id: str, websearch: str, container: str) -> None:
    """Deliver the node's control token to the node and to the agent, every
    resolve. Fail-soft: a dead node only costs the web tools, never chat or
    uploads (the tools answer websearch_unavailable)."""
    token = websearch_control_token(user_id)
    try:
        websearch_post(websearch, "/control", {"token": token}, timeout=2.0)
        agent_post(container, "/webconfig", {"controlToken": token}, timeout=2.0)
    except Exception as exc:  # noqa: BLE001 - fail-soft by design, never chat
        log.debug("web-search control delivery failed for %s: %s", user_id, exc)


# ── RFC 0024 §7: per-user MCP delivery ──────────────────────────────────────

def mcp_control_token(user_id: str) -> str:
    """The MCP node's control token for one user, derived from MANAGER_TOKEN
    (deterministic, so the manager can always mint the value it baked into the
    node's env at create time) and never delivered to the agent's memory by
    any path the sandbox shares: the agent gets it too (it must register runs),
    but a bash child cannot read either container's env."""
    if not MANAGER_TOKEN:
        raise ManagerError("token_unavailable", "MANAGER_TOKEN is required for MCP authorisation")
    return hmac.new(
        MANAGER_TOKEN.encode(), b"mcp-node:" + user_id.encode(), hashlib.sha256
    ).hexdigest()


def deliver_mcp_config(user_id: str, node: str, container: str) -> None:
    """Rebuild the node's whole config on every resolve (idempotent, §10.2):
    the user-enabled deployment servers with their decrypted tokens, plus the
    admission key Caddy stamps. The agent gets the keyless half (node URL,
    control token, enabled ids) — never a credential, never the admission key.
    Fail-soft like the web-search delivery: MCP being down never costs chat."""
    deployment = mcp_deployment()
    if not deployment:
        return
    deployment_ids = {entry["id"] for entry in deployment}
    catalog = mcp_catalog()
    servers: list[dict[str, Any]] = []
    enabled_ids: list[str] = []
    for row in mcp_servers_get(user_id):
        if not row["enabled"] or row["server_id"] not in deployment_ids:
            continue
        entry: dict[str, Any] = {
            "id": row["server_id"],
            "url": catalog[row["server_id"]]["url"],
        }
        if row["ciphertext"] is not None:
            try:
                entry["token"] = mcp_token_decrypt(
                    user_id, row["server_id"], row["ciphertext"], row["nonce"]
                )
            except ManagerError as exc:
                log.warning(
                    "mcp token for %s/%s undecryptable, delivering without it: %s",
                    user_id, row["server_id"], exc.code,
                )
        servers.append(entry)
        enabled_ids.append(row["server_id"])
    token = mcp_control_token(user_id)
    payload: dict[str, Any] = {"servers": servers}
    if MCP_ADMISSION_KEY:
        payload["admissionKey"] = MCP_ADMISSION_KEY
    try:
        mcp_post(node, "/mcp/config", payload, token=token, timeout=4.0)
        agent_post(
            container, "/mcpconfig",
            {
                "gatewayUrl": f"http://{node}:{MCP_PORT}",
                "controlToken": token,
                "servers": enabled_ids,
            },
            timeout=3.0,
        )
    except Exception as exc:  # noqa: BLE001 - fail-soft by design, never chat
        log.debug("mcp config delivery failed for %s: %s", user_id, exc)


# ── resolve: the only write path on the request hot path ────────────────────
def wait_until_ready(user_id: str) -> dict[str, Any]:
    deadline = time.time() + READY_TIMEOUT_S
    while time.time() < deadline:
        row = registry_get(user_id)
        if row is not None and row["status"] != "creating":
            return row
        time.sleep(0.25)
    raise TimeoutError(f"sandbox for {user_id} stayed in 'creating'")


def resolve(user_id: str) -> dict[str, Any]:
    started = time.time()
    row = registry_get(user_id)

    if row is None:
        if try_claim(user_id):
            provision(user_id)
        else:
            time.sleep(0.2)  # lost the race; the winner is provisioning

    row = registry_get(user_id)
    if row is None:
        raise RuntimeError("no registry row after claim")
    if row["status"] == "creating":
        row = wait_until_ready(user_id)

    container = row["container_name"]
    sidecar = sidecar_name(user_id)
    websearch = websearch_name(user_id)
    deployment = mcp_deployment()
    mcp = mcp_node_name(user_id)
    ensure_guests(user_id)
    if (
        docker_running(container) is None
        or docker_running(sidecar) is None
        or docker_running(websearch) is None
        or (deployment and docker_running(mcp) is None)
    ):
        provision(user_id)  # row exists but part of the group is gone: repair all, don't 503
    elif (
        row["status"] != "running"
        or not agent_alive(container)
        or not sidecar_alive(sidecar)
    ):
        # The node's own health is not part of this decision: it is optional
        # (chat and uploads do not need it) and a crash-looping node must not
        # add its health deadline to every request. reconcile_tick restarts it
        # off the hot path; its tools report websearch_unavailable meanwhile.
        start_pair(user_id, container, sidecar)

    # RFC 0012 §5.4 / RFC 0013 §5: every activation reconciles the runtime
    # pair against the OLTP desired state (delivery, rotation, faux fallback).
    # Raises ManagerError (egress_blocked, kek_unavailable, agent_image_old,
    # sidecar_unhealthy) so resolve fails closed with that code.
    reconcile_provider(user_id, container, sidecar)
    # RFC 0016 §7: the node and the agent must agree on the control token before
    # the prompt body reaches the agent; resolve runs first on every request.
    deliver_websearch_control(user_id, websearch, container)
    # RFC 0024 §10.2: same ordering for the MCP config — the node's whole
    # server set (credentials included) and the agent's keyless half land
    # before the prompt, so a revocation is a resolve, never a restart (V9).
    if deployment:
        deliver_mcp_config(user_id, mcp, container)

    touch(user_id)
    return {
        "endpoint": f"{container}:{AGENT_PORT}",
        "status": "running",
        "container_name": container,
        "cold_start_ms": int((time.time() - started) * 1000),
    }


# ── background loops: L1 eviction + watchdog ────────────────────────────────
_unhealthy: dict[str, int] = {}


def eviction_tick() -> None:
    """Stop a sandbox once its agent has paused itself and the user has gone.

    The agent pauses in-process after IDLE_MS (L0). Because Caddy asks the
    manager to resolve on every request, last_seen_at is a faithful activity
    clock; STOP_AFTER_S after the last touch, the container is stopped (L1) and
    its RAM returns to the host. The SQLite session stays on /data.
    """
    for row in rows("WHERE status IN ('running','idle_paused')"):
        user_id, container = row["user_id"], row["container_name"]
        try:
            status = agent_get(container, "/status")
        except Exception:
            continue
        if not status.get("paused", True):
            touch(user_id)
            continue
        idle_for = time.time() - row["last_seen_at"].timestamp()
        if row["status"] == "running" and idle_for >= IDLE_GRACE_S:
            registry_set(user_id, "idle_paused")
        if idle_for >= STOP_AFTER_S:
            log.info("stopping idle sandbox %s (idle %.0fs)", container, idle_for)
            docker("stop", "--time", "10", container, check=False)
            # RFC 0013 R7 / RFC 0016 §4: the group evicts together — an idle
            # user's sidecar holds no key in RAM, the node holds no run tables,
            # and idle cost stays zero. RFC 0024 §5: the MCP node joins the
            # group eviction (no credentials in RAM for an idle user).
            docker("stop", "--time", "5", sidecar_name(user_id), check=False)
            docker("stop", "--time", "5", websearch_name(user_id), check=False)
            docker("stop", "--time", "5", mcp_node_name(user_id), check=False)
            registry_set(user_id, "stopped")


def reconcile_tick() -> None:
    """Repair registry/docker drift and restart containers that stop answering.

    A stop recorded in the registry is never resurrected; only a container the
    registry believes is running and that fails /health N times is restarted.
    Also re-asserts the host wall: iptables rules vanish on daemon restart
    while network objects survive.
    """
    try:
        hostwall_reconcile()
    except Exception:
        log.exception("hostwall reconcile failed (rules may be missing)")
    for row in rows():
        user_id, container, status = (
            row["user_id"], row["container_name"], row["status"]
        )
        running = docker_running(container)
        if running is None:
            if status != "stopped":
                log.warning("registry says %s but container is gone", container)
                registry_set(user_id, "stopped")
            _unhealthy.pop(user_id, None)
            continue
        if status not in ("running", "idle_paused"):
            continue
        sidecar = sidecar_name(user_id)
        if docker_running(sidecar) is False:
            # R7: the pair runs together. A stopped sidecar lost its key; the
            # next resolve re-delivers it from desired state (§8). The restart
            # also regenerates resolv.conf, so the rewrite must follow it.
            docker("start", sidecar, check=False)
            if AGENT_DNS:
                dns_rewrite(sidecar)
        websearch = websearch_name(user_id)
        if docker_running(websearch) is False:
            # RFC 0016: the node keeps no durable state, so a restart is all it
            # needs. A node that is gone entirely is repaired by resolve, which
            # then recreates the agent too (its baked IP changed).
            docker("start", websearch, check=False)
        elif docker_running(websearch) is True and not websearch_alive(websearch):
            # Running but not answering: restart it here, never on resolve's
            # hot path (the node is optional; tool calls fail soft meanwhile).
            log.warning("restarting unresponsive web-search node %s", websearch)
            docker("restart", websearch, check=False)
        if mcp_deployment():
            mcp = mcp_node_name(user_id)
            if docker_running(mcp) is False:
                # RFC 0024: same repair rule as the web-search node — the MCP
                # node keeps no durable state either (D9: RAM only).
                docker("start", mcp, check=False)
            elif docker_running(mcp) is True and not mcp_alive(mcp):
                log.warning("restarting unresponsive mcp node %s", mcp)
                docker("restart", mcp, check=False)
        if agent_alive(container):
            _unhealthy[user_id] = 0
            continue
        _unhealthy[user_id] = _unhealthy.get(user_id, 0) + 1
        if _unhealthy[user_id] >= UNHEALTHY_LIMIT:
            log.warning("restarting unhealthy sandbox %s", container)
            docker("restart", "--time", "10", container, check=False)
            _unhealthy[user_id] = 0


def loop(tick, every_s: int) -> None:
    while True:
        try:
            tick()
        except Exception:
            log.exception("%s failed", getattr(tick, "__name__", tick))
        time.sleep(every_s)


def start_loops() -> None:
    for tick, every in ((eviction_tick, EVICT_TICK_S), (reconcile_tick, RECONCILE_S)):
        threading.Thread(target=loop, args=(tick, every), daemon=True).start()


# ── HTTP API (Caddy and the Web Client are the only callers) ────────────────
def metrics() -> dict[str, Any]:
    with db() as conn:
        grouped = conn.execute(
            "SELECT status, count(*) AS n FROM sandbox_registry GROUP BY status"
        ).fetchall()
    return {
        "by_status": {row["status"]: row["n"] for row in grouped},
        "unhealthy": {uid: n for uid, n in _unhealthy.items() if n},
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        log.debug("%s %s", self.address_string(), fmt % args)

    def authorized(self) -> bool:
        """Shared-secret wall: the manager sits on networks agents can reach."""
        if not MANAGER_TOKEN:
            return True
        return hmac.compare_digest(
            self.headers.get("X-Manager-Token") or "", MANAGER_TOKEN
        )

    def rejected_sandbox_peer(self) -> bool:
        """Second wall: per-user networks host untrusted agent containers, so a
        peer from those subnets that is not a control-plane guest never gets an
        answer — token or not."""
        return is_sandbox_peer(self.client_address[0])

    def send(self, code: int, payload: Any, headers: dict[str, str] | None = None):
        body = json.dumps(payload, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def user_id(self) -> str:
        parsed = urllib.parse.urlparse(self.path)
        return (urllib.parse.parse_qs(parsed.query).get("user_id") or [""])[0]

    def query_param(self, name: str) -> str:
        parsed = urllib.parse.urlparse(self.path)
        return (urllib.parse.parse_qs(parsed.query).get(name) or [""])[0]

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            raise ManagerError("invalid_json", "request body is not valid JSON", 400)
        if not isinstance(body, dict):
            raise ManagerError("invalid_json", "request body must be a JSON object", 400)
        return body

    def send_error(self, exc: ManagerError) -> None:
        self.send(exc.status, {"error": exc.code, "message": str(exc)})

    # ── machine identity surface (RFC 0023) ─────────────────────────────────
    def send_identity(
        self, code: int, payload: Any, headers: dict[str, str] | None = None
    ) -> None:
        self.send(code, payload, {"Cache-Control": "no-store", **(headers or {})})

    def send_identity_error(
        self, exc: ManagerError, headers: dict[str, str] | None = None
    ) -> None:
        self.send_identity(
            exc.status, {"code": exc.code, "message": str(exc)}, headers
        )

    def send_empty(self, code: int) -> None:
        self.send_response(code)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def identity_body(self, raw: bytes) -> dict[str, Any]:
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            raise ManagerError("invalid_input", "request body is not valid JSON", 400)
        if not isinstance(body, dict):
            raise ManagerError("invalid_input", "request body must be a JSON object", 400)
        return body

    def identity_post(self) -> None:
        """POST /identity/register|login|logout. Key first, then the walls:
        no Origin (server-to-server only), a scoped key, a configured secret,
        then the per-IP window. Every answer is no-store."""
        path = urllib.parse.urlsplit(self.path).path
        # Read the body before any early return: leaving Content-Length bytes
        # unread desyncs the next request on a keep-alive connection.
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.close_connection = True
            return self.send_identity(
                400,
                {"code": "invalid_input", "message": "invalid Content-Length"},
                {"Connection": "close"},
            )
        if length < 0 or length > IDENTITY_MAX_BODY:
            self.close_connection = True
            return self.send_identity(
                400,
                {"code": "invalid_input", "message": "request body is too large"},
                {"Connection": "close"},
            )
        raw = self.rfile.read(length) if length else b""
        if path not in IDENTITY_ROUTES:
            return self.send_identity(404, {"code": "not_found", "message": "not found"})
        # A browser always sends Origin on a cross-origin POST; this surface is
        # machine-only. Caddy deliberately does NOT strip it, so this check is
        # live through the gateway (RFC 0023 §5).
        if "Origin" in self.headers:
            return self.send_identity_error(
                ManagerError("forbidden_origin", "machine callers only: Origin must be absent", 403)
            )
        if not identity_key_ok(self.headers.get("X-Identity-Key") or ""):
            return self.send_identity_error(
                ManagerError("unauthorized", "bad or missing X-Identity-Key", 401)
            )
        if not identity_ready():
            log.error(
                "identity routes are called but BETTER_AUTH_SECRET/ORIGIN are not configured"
            )
            return self.send_identity_error(
                ManagerError("identity_unavailable", "identity is not configured", 503)
            )
        ip = client_ip(self)
        user_agent = (self.headers.get("User-Agent") or "")[:512]
        if path == "/identity/logout":
            try:
                identity_logout(self)
            except ManagerError as exc:
                return self.send_identity_error(exc)
            return self.send_empty(204)
        limit, window = (
            (IDENTITY_REGISTER_PER_HOUR, 3600.0)
            if path == "/identity/register"
            else (IDENTITY_LOGIN_PER_MINUTE, 60.0)
        )
        allowed, retry = _identity_windows.allow(path, ip, limit, window)
        if not allowed:
            return self.send_identity_error(
                ManagerError("rate_limited", "too many requests", 429),
                {"Retry-After": str(retry)},
            )
        try:
            body = self.identity_body(raw)
            email = identity_email(body.get("email"))
            password = identity_password(body.get("password"))
            if path == "/identity/register":
                result = identity_register(
                    email, password, identity_name(body.get("name")), ip, user_agent
                )
                return self.send_identity(201, result)
            result = identity_login(email, password, ip, user_agent)
            return self.send_identity(200, result)
        except ManagerError as exc:
            return self.send_identity_error(exc)
        except Exception:
            # Never echo the exception: it can carry statement parameters.
            log.exception("identity request failed")
            return self.send_identity_error(
                ManagerError("identity_unavailable", "the identity store is unavailable", 503)
            )

    # ── BYOK identity (RFC 0012 §5.3 + review clarification) ─────────────────
    # One explicit rule for PUT/DELETE /providers/config: a valid session
    # cookie is the only identity and any body user_id is ignored; with no
    # session, the request is a trusted caller only when it did NOT transit
    # the Caddy /providers/* route. The route is pinned by the X-Gateway-Route
    # header Caddy adds on that route (after stripping any client-supplied
    # copy), so a cookieless browser request can never reach a write handler:
    # forward_auth /whoami 401s it before the proxy hop, and the manager
    # rejects it again here if it somehow arrives.

    def gateway_routed(self) -> bool:
        return (self.headers.get("X-Gateway-Route") or "") == "1"

    def write_user(self, body: dict[str, Any], requested: str = "") -> tuple[str, bool]:
        """(user_id, via_session) for writes. Raises 401/400 via ManagerError.
        `requested` carries a query-string user_id (DELETE has no body)."""
        session = user_from_session(self)
        if session is not None:
            return session, True  # body user_id ignored outright
        if self.gateway_routed():
            raise ManagerError("unauthorized", "a session cookie is required on this route", 401)
        if not self.authorized():
            raise ManagerError("unauthorized", "bad or missing X-Manager-Token", 401)
        user_id = body.get("user_id", "") or requested
        if not isinstance(user_id, str) or not user_id:
            raise ManagerError("user_id_required", "user_id is required on the trusted-caller path", 400)
        return user_id, False

    def read_user(self, requested: str, require_user: bool = True) -> str:
        """Identity for GET /providers/*: the session (an explicit user_id is
        cross-checked, mismatch is 403) or the trusted caller's user_id."""
        session = user_from_session(self)
        if session is not None:
            if requested and requested != session:
                raise ManagerError("forbidden", "session user mismatch", 403)
            return session
        if self.gateway_routed():
            raise ManagerError("unauthorized", "a session cookie is required on this route", 401)
        if not self.authorized():
            raise ManagerError("unauthorized", "bad or missing X-Manager-Token", 401)
        if require_user:
            if not requested:
                raise ManagerError("user_id_required", "user_id is required on the trusted-caller path", 400)
            return requested
        return ""

    def write_origin_ok(self) -> bool:
        """CSRF wall on the browser path (§7.14): a PUT/DELETE riding a session
        cookie must carry Origin (or Referer) equal to the origin Caddy served
        the request on. Caddy sets X-Forwarded-Proto/Host itself on the
        /providers route (client copies are stripped first), and the Host
        header is verbatim; browsers cannot set Host on fetch, so this holds
        for every client the wall addresses. The trusted-caller path (no
        session) is server-to-server and exempt."""
        origin = self.headers.get("Origin")
        if origin is None:
            referer = self.headers.get("Referer")
            if referer:
                parts = urllib.parse.urlsplit(referer)
                origin = f"{parts.scheme}://{parts.netloc}"
        if origin is None:
            return False  # browser-path writes without Origin are rejected (M4)
        host = self.headers.get("Host") or self.headers.get("X-Forwarded-Host") or ""
        proto = (self.headers.get("X-Forwarded-Proto") or "http").lower()
        try:
            got = urllib.parse.urlsplit(origin)
            want = urllib.parse.urlsplit(f"//{host}")
            if not got.hostname or not want.hostname:
                return False
            # Compare scheme-safety + hostname + effective port, so a portless
            # Origin matches a Host with the default port and vice versa.
            got_key = (got.scheme == "https", got.hostname.lower(), got.port or (443 if got.scheme == "https" else 80))
            want_key = (proto == "https", want.hostname.lower(), want.port or (443 if proto == "https" else 80))
        except ValueError:
            return False
        return hmac.compare_digest(repr(got_key), repr(want_key))

    def apply_live(self, user_id: str) -> str:
        """§5.3 'apply live': deliver now when a sandbox is already running;
        otherwise the next resolve reconciles (every request through Caddy
        resolves). Best effort — a pending delivery never fails the PUT."""
        row = registry_get(user_id)
        if row is None:
            return "no_sandbox"
        container = row["container_name"]
        if docker_running(container) is not True:
            return "sandbox_stopped"
        try:
            reconcile_provider(user_id, container, sidecar_name(user_id))
            return "delivered"
        except ManagerError as exc:
            return f"pending: {exc.code}"
        except Exception:
            return "pending: delivery_failed"

    def apply_mcp_live(self, user_id: str) -> str:
        """RFC 0024 §10.2: a config change is one delivery away when the group
        runs; otherwise the next resolve carries it. Best effort, same rule."""
        row = registry_get(user_id)
        if row is None:
            return "no_sandbox"
        container = row["container_name"]
        if docker_running(container) is not True:
            return "sandbox_stopped"
        try:
            deliver_mcp_config(user_id, mcp_node_name(user_id), container)
            return "delivered"
        except Exception:
            return "pending: delivery_failed"

    def providers_get(self) -> None:
        """GET /whoami and GET /providers/* — behind the peer guard like every
        endpoint; /whoami never provisions (unlike /resolve)."""
        try:
            if self.path.startswith("/whoami"):
                try:
                    identity = session_identity(self)
                except psycopg.Error:
                    log.exception("whoami lookup failed")
                    return self.send_identity(
                        503,
                        {"code": "identity_unavailable", "message": "the identity store is unavailable"},
                    )
                if identity is None:
                    return self.send(
                        401, {"error": "invalid session"}, {"Cache-Control": "no-store"}
                    )
                payload: dict[str, Any] = {"user_id": identity["user_id"]}
                for field in ("email", "name"):
                    if identity.get(field):
                        payload[field] = identity[field]
                return self.send(200, payload, {"Cache-Control": "no-store"})
            if self.path.startswith("/providers/catalog"):
                self.read_user(self.user_id(), require_user=False)
                return self.send(200, {"version": 1, "providers": provider_catalog()})
            if self.path.startswith("/providers/config"):
                user = self.read_user(self.user_id())
                return self.send(
                    200, provider_config_view(user), {"Cache-Control": "no-store"}
                )
            if self.path.startswith("/mcp/servers"):
                user = self.read_user(self.user_id())
                return self.send(200, mcp_servers_view(user), {"Cache-Control": "no-store"})
            return self.send(404, {"error": "not found"})
        except ManagerError as exc:
            return self.send_error(exc)

    def providers_put(self, body: dict[str, Any]) -> None:
        """PUT /providers/config: upsert key (when apiKey), set selection,
        optionally validate upstream, apply live. Returns the masked view."""
        try:
            user_id, via_session = self.write_user(body)
            if via_session and not self.write_origin_ok():
                raise ManagerError("forbidden", "Origin does not match the serving origin", 403)
            provider = body.get("provider")
            model_id = body.get("modelId")
            api_key = body.get("apiKey")
            base_url = body.get("baseUrl")
            validate = body.get("validate") is True
            if not isinstance(provider, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", provider or ""):
                raise ManagerError("invalid_provider", "provider must be a catalog id, 'custom', or 'faux'", 400)
            if not isinstance(model_id, str) or not (1 <= len(model_id) <= 200):
                raise ManagerError("invalid_model", "modelId must be 1-200 characters", 400)
            if api_key is not None and (not isinstance(api_key, str) or not (1 <= len(api_key) <= 4096)):
                raise ManagerError("invalid_api_key", "apiKey must be 1-4096 characters", 400)
            if base_url is not None and not isinstance(base_url, str):
                raise ManagerError("invalid_base_url", "baseUrl must be a string", 400)
            pinned_base_url: str | None = None
            validate_path = "/models"  # §5.6 auth-checked suffix; a catalog entry may override
            if provider == "faux":
                if model_id != "faux-1":
                    raise ManagerError("invalid_model", "the faux provider has exactly one model: faux-1", 400)
                api_key = None
                base_url = None
            elif provider == "custom":
                if not isinstance(base_url, str) or not base_url:
                    raise ManagerError("invalid_base_url", "custom endpoints need a baseUrl", 400)
                check_custom_base_url(base_url)  # §5.1: https-only, no private/docker answers
            else:
                entry = catalog_entry(provider)  # unknown_provider -> 400
                if base_url:
                    raise ManagerError("invalid_base_url", "built-in providers take no baseUrl", 400)
                if model_id not in {model.get("id") for model in entry.get("models", [])}:
                    raise ManagerError("invalid_model", f"modelId '{model_id}' is not in the {provider} catalog", 400)
                if entry.get("baseUrl"):
                    pinned_base_url = str(entry["baseUrl"])
                if entry.get("validatePath"):
                    validate_path = str(entry["validatePath"])
                # Catalog entries that are not pi-ai built-ins (the dev e2e-fake
                # upstream) reach the agent through their pinned endpoint: the
                # delivery payload needs that baseUrl, so it is stored on the key.
                if not entry.get("builtin", True):
                    base_url = pinned_base_url
            # Egress gate (§5.5) after shape validation, before anything is
            # stored: fail closed at setup, not at first prompt.
            if provider != "faux" and AGENT_EGRESS != "open":
                raise ManagerError(
                    "egress_blocked",
                    f"provider '{provider}' needs internet egress; this stack runs AGENT_EGRESS != open",
                    400,
                )
            if api_key is not None:
                if validate:
                    # §5.6: validate against the pinned/catalog base URL before
                    # storing; failure stores nothing (§7.2). Only user-supplied
                    # custom baseUrls carry the public-address rules; catalog
                    # URLs are operator-pinned and validated as-is.
                    target = base_url if base_url else pinned_base_url
                    if target:
                        validate_upstream(
                            target, api_key,
                            require_public=provider == "custom", path_suffix=validate_path,
                        )
                provider_key_upsert(user_id, provider, api_key, base_url, verified=validate)
            provider_selection_set(user_id, provider, model_id)
            delivery = self.apply_live(user_id)
            view = provider_config_view(user_id)
            view["delivery"] = delivery
            return self.send(200, view)
        except ManagerError as exc:
            return self.send_error(exc)
        except Exception:
            log.exception("PUT /providers/config failed")
            return self.send(500, {"error": "internal", "message": "provider config write failed"})

    def mcp_put(self, body: dict[str, Any]) -> None:
        """PUT /mcp/servers: enable/disable one catalog server for the caller,
        optionally storing (or replacing) its credential. The server must be in
        the deployment subset (D4: no user URL, ever); the token is encrypted
        under the BYOK KEK with MCP-specific AAD and never leaves the manager
        in plaintext again. The response is the masked view + delivery."""
        try:
            user_id, via_session = self.write_user(body)
            if via_session and not self.write_origin_ok():
                raise ManagerError("forbidden", "Origin does not match the serving origin", 403)
            server_id = body.get("serverId")
            enabled = body.get("enabled")
            token = body.get("token")
            if not isinstance(server_id, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", server_id or ""):
                raise ManagerError("invalid_server", "serverId must be a catalog id", 400)
            if not isinstance(enabled, bool):
                raise ManagerError("invalid_enabled", "enabled must be a boolean", 400)
            if token is not None and (not isinstance(token, str) or not (1 <= len(token) <= 4096)):
                raise ManagerError("invalid_token", "token must be 1-4096 characters", 400)
            deployment = mcp_deployment()
            if server_id not in {entry["id"] for entry in deployment}:
                raise ManagerError(
                    "unknown_server",
                    f"server '{server_id}' is not offered by this deployment (D4)",
                           400,
                )
            entry = next(e for e in deployment if e["id"] == server_id)
            if enabled and token is None:
                row = next(
                    (r for r in mcp_servers_get(user_id) if r["server_id"] == server_id), None,
                )
                if (entry.get("auth") or {}).get("required") and (row is None or row["ciphertext"] is None):
                    raise ManagerError(
                        "token_required",
                        f"server '{server_id}' requires a bearer token; supply one to enable it",
                        400,
                    )
            mcp_server_set(user_id, server_id, enabled, token)
            delivery = self.apply_mcp_live(user_id)
            view = mcp_servers_view(user_id)
            view["delivery"] = delivery
            return self.send(200, view)
        except ManagerError as exc:
            return self.send_error(exc)
        except Exception:
            log.exception("PUT /mcp/servers failed")
            return self.send(500, {"error": "internal", "message": "mcp servers write failed"})

    def providers_delete(self) -> None:
        """DELETE /providers/config: clear selection; ?provider= also revokes
        that key; ?all=1 drops both tables' rows (§7.13 account deletion)."""
        try:
            user_id, via_session = self.write_user({}, self.user_id())
            if via_session and not self.write_origin_ok():
                raise ManagerError("forbidden", "Origin does not match the serving origin", 403)
            provider = self.query_param("provider")
            if self.query_param("all") == "1":
                providers_delete_all(user_id)
            else:
                provider_selection_clear(user_id)
                if provider:
                    provider_key_delete(user_id, provider)
            delivery = self.apply_live(user_id)
            view = provider_config_view(user_id)
            view["delivery"] = delivery
            return self.send(200, view)
        except ManagerError as exc:
            return self.send_error(exc)
        except Exception:
            log.exception("DELETE /providers/config failed")
            return self.send(500, {"error": "internal", "message": "provider config delete failed"})

    def resolve_reply(self, user_id: str) -> None:
        try:
            result = resolve(user_id)
        except ManagerError as exc:
            log.warning("resolve failed for %s: %s", user_id, exc.code)
            try:
                registry_set(user_id, "error")
            except Exception:
                pass
            return self.send(exc.status, {"error": exc.code, "message": str(exc)})
        except Exception as exc:
            log.exception("resolve failed for %s", user_id)
            try:
                registry_set(user_id, "error")
            except Exception:
                pass
            return self.send(503, {"error": str(exc)})
        return self.send(200, result, {"X-Sandbox-Endpoint": result["endpoint"]})

    def do_GET(self) -> None:
        if self.path.startswith("/healthz"):
            return self.send(200, {"status": "ok"})
        if self.rejected_sandbox_peer():
            return self.send(403, {"error": "sandbox peers cannot call the manager"})
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/identity/"):
            # The route exists but only accepts POST: 405 lets a doctor tell
            # "route missing" (404 from the gateway catch-all) from "route
            # present" without creating an account.
            if path in IDENTITY_ROUTES:
                return self.send_identity(
                    405,
                    {"code": "method_not_allowed", "message": "use POST"},
                    {"Allow": "POST"},
                )
            return self.send_identity(404, {"code": "not_found", "message": "not found"})
        if self.path.startswith("/whoami") or self.path.startswith("/providers/") or self.path.startswith("/mcp/"):
            return self.providers_get()
        if not self.authorized():
            return self.send(401, {"error": "bad or missing X-Manager-Token"})
        if self.path.startswith("/resolve"):
            # Browser path (Caddy forward_auth): the subrequest is a GET clone
            # of the original request, cookies included. Identity comes from
            # the validated session; the query user_id is only cross-checked.
            authed = user_from_session(self)
            if authed is None:
                return self.send(401, {"error": "invalid session"})
            requested = self.user_id()
            if requested and requested != authed:
                return self.send(403, {"error": "session user mismatch"})
            return self.resolve_reply(authed)
        if self.path.startswith("/metrics"):
            return self.send(200, metrics())
        if self.path.startswith("/status"):
            user_id = self.user_id()
            if not user_id:
                return self.send(400, {"error": "user_id is required"})
            row = registry_get(user_id)
            if row is None:
                return self.send(404, {"error": "unknown user"})
            return self.send(200, {**row, "docker_running": docker_running(row["container_name"])})
        return self.send(404, {"error": "not found"})

    def do_PUT(self) -> None:
        if self.rejected_sandbox_peer():
            return self.send(403, {"error": "sandbox peers cannot call the manager"})
        if self.path.startswith("/providers/"):
            return self.providers_put(self.read_json_body())
        if self.path.startswith("/mcp/"):
            return self.mcp_put(self.read_json_body())
        return self.send(404, {"error": "not found"})

    def do_DELETE(self) -> None:
        if self.rejected_sandbox_peer():
            return self.send(403, {"error": "sandbox peers cannot call the manager"})
        if self.path.startswith("/providers/"):
            return self.providers_delete()
        return self.send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.rejected_sandbox_peer():
            return self.send(403, {"error": "sandbox peers cannot call the manager"})
        if urllib.parse.urlsplit(self.path).path.startswith("/identity/"):
            return self.identity_post()
        if not self.authorized():
            return self.send(401, {"error": "bad or missing X-Manager-Token"})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self.send(400, {"error": "invalid json"})
        user_id = body.get("user_id", "")
        if not user_id:
            return self.send(400, {"error": "user_id is required"})

        if self.path.startswith("/resolve"):
            # Trusted-caller path (the Web Client authenticated the user
            # server-side): the body user_id is authoritative.
            return self.resolve_reply(user_id)

        if self.path.startswith("/pause"):
            row = registry_get(user_id)
            if row is None:
                return self.send(404, {"error": "unknown user"})
            docker("stop", "--time", "10", row["container_name"], check=False)
            registry_set(user_id, "stopped")
            return self.send(200, {"user_id": user_id, "status": "stopped"})

        return self.send(404, {"error": "not found"})


def enforce_token_default() -> None:
    """Refuse to serve with no credential or the well-known default.

    Fail-closed second layer behind the dev.sh/verify.sh token generation:
    `docker compose up` without a MANAGER_TOKEN in .env would otherwise run
    the whole stack on a constant secret. Exit 1 (compose restart policy will
    not mask it into availability) unless MANAGER_ALLOW_DEFAULT_TOKEN=1 opts
    into a throwaway stack explicitly."""
    if MANAGER_ALLOW_DEFAULT_TOKEN:
        return
    if not MANAGER_TOKEN:
        log.fatal(
            "MANAGER_TOKEN is empty: every manager endpoint would be unauthenticated. "
            "Set a random value in .env (./dev.sh up generates one) or set "
            "MANAGER_ALLOW_DEFAULT_TOKEN=1 to accept an unauthenticated manager."
        )
        raise SystemExit(1)
    if hmac.compare_digest(MANAGER_TOKEN, KNOWN_DEFAULT_TOKEN):
        log.fatal(
            "MANAGER_TOKEN is the well-known compose default '%s': any local process "
            "could pause, resolve as, or read any tenant (pentest W1). Generate a "
            "random value in .env (./dev.sh up does this) or set "
            "MANAGER_ALLOW_DEFAULT_TOKEN=1 to explicitly accept it.",
            KNOWN_DEFAULT_TOKEN,
        )
        raise SystemExit(1)


def enforce_runsc_runtime() -> None:
    """Fail closed at boot unless the daemon serves the runsc runtime.

    gVisor is a hard requirement (see AGENT_RUNTIME): the sidecar delivery is
    cleartext HTTP on the per-user bridge, and under runc a compromised agent
    (root, default caps, CAP_NET_RAW) can ARP-spoof the sidecar and capture
    the key mid-delivery. A boot warning would leave the stack serving while
    every keyed selection is one ARP poison away from disclosure, so the
    manager refuses to start instead — same fail-closed layer as
    enforce_token_default."""
    try:
        known = docker(
            "info", "--format", "{{range $k, $v := .Runtimes}}{{$k}} {{end}}"
        ).split()
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        log.fatal(
            "cannot list docker runtimes (%s): cannot prove runsc is served; "
            "refusing to start. Install gVisor and restart this manager.", exc,
        )
        raise SystemExit(1)
    if AGENT_RUNTIME not in known:
        log.fatal(
            "the docker daemon has no '%s' runtime (have: %s): gVisor is "
            "mandatory — the sidecar key delivery is cleartext HTTP on the "
            "per-user bridge, and only runsc makes that bridge unspoofable "
            "from inside a sandbox. Install runsc and restart this manager.",
            AGENT_RUNTIME, " ".join(sorted(known)) or "none",
        )
        raise SystemExit(1)


class ManagerHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer with quiet peer-disconnect handling.

    stdlib http.server funnels every client-side connection reset into
    handle_error's full traceback. Resets are routine here: the web app aborts
    in-flight fetches (navigation, AbortSignal timeouts) and Caddy propagates
    the cancel by closing its upstream connections mid-request. Log one INFO
    line; anything that is not a peer reset keeps the stdlib traceback."""

    def handle_error(self, request: Any, client_address: tuple[str, int] | None) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            log.info(
                "client %s closed the connection (%s)",
                client_address[0] if client_address else "?", type(exc).__name__,
            )
            return
        super().handle_error(request, client_address)


def warn_seccomp_profile() -> None:
    """One loud line when the Phase 0 profile is missing from this image: every
    provision would fail closed at docker create (the CLI reads the file
    client-side), and this puts the diagnosis in the operator's first stop."""
    if not os.path.exists(SECCOMP_PROFILE):
        log.error(
            "seccomp profile %s does not exist in this container: every provision"
            " fails at docker create. Rebuild the sandbox-manager image.",
            SECCOMP_PROFILE,
        )


def main() -> None:
    enforce_token_default()
    enforce_runsc_runtime()
    warn_seccomp_profile()
    migrate()
    try:
        ensure_websearch_networks()
    except Exception as exc:
        # The node's containment claim depends on websearch-in being internal;
        # a non-internal one must stop the boot, not silently weaken it.
        log.error("web-search networks are unusable: %s", exc)
        raise
    if mcp_deployment():
        try:
            ensure_mcp_networks()
        except Exception as exc:
            # Same fail-closed rule: an MCP leg with the wrong shape must stop
            # the boot, never quietly weaken the node's containment (D2/T7).
            log.error("mcp networks are unusable: %s", exc)
            raise
        if not MCP_ADMISSION_KEY:
            # R8: fail closed. Every run registers read-only until the operator
            # sets the key; reads are unaffected and the stack still serves.
            log.warning(
                "MCP_SERVERS is set but MCP_ADMISSION_KEY is empty: no run can "
                "authorize write-tier tools (fail closed, RFC 0024 R8)"
            )
    start_loops()
    server = ManagerHTTPServer((LISTEN_ADDR, LISTEN_PORT), Handler)
    log.info(
        "sandbox-manager on %s:%s (image=%s stop_after=%ss egress=%s token=%s)",
        LISTEN_ADDR, LISTEN_PORT, AGENT_IMAGE, STOP_AFTER_S, AGENT_EGRESS,
        "on" if MANAGER_TOKEN else "OFF",
    )
    if identity_keys() and identity_ready():
        log.info("identity surface: on (%s key(s), cookie=%s)",
                 len(identity_keys()), identity_cookie_name())
    elif IDENTITY_API_KEY and not identity_keys():
        log.error(
            "IDENTITY_API_KEY is shorter than %d characters: every identity request"
            " is rejected with 401",
            IDENTITY_MIN_KEY_CHARS,
        )
    elif IDENTITY_API_KEY:
        # Never log the key or the secret: only the missing piece.
        log.warning(
            "identity surface: configured key but BETTER_AUTH_SECRET/ORIGIN missing;"
            " /identity/* answers identity_unavailable"
        )
    else:
        log.info("identity surface: off (IDENTITY_API_KEY is empty)")
    try:
        load_kek()
        log.info("BYOK KEK loaded from %s", LLM_KEK_FILE)
    except ManagerError as exc:
        # Not fatal: the keyless default stack never touches the KEK. Key
        # writes and delivery fail closed with kek_unavailable until it exists.
        log.warning("BYOK disabled: %s", exc)
    server.serve_forever()


if __name__ == "__main__":
    main()
