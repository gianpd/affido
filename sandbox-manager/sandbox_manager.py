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
import socket
import ssl
import subprocess
import sys
import threading
import time
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
# `off` (default): per-user networks are created without NAT egress, so a
# sandbox can talk to its guests (caddy, manager, web) on its own subnet and
# nothing else. `open` keeps the plain-bridge behaviour (internet egress) for
# deployments whose model provider is reached over the internet (openrouter).
AGENT_EGRESS    = os.getenv("AGENT_EGRESS", "off")
AGENT_MEMORY    = os.getenv("AGENT_MEMORY", "512m")
AGENT_CPUS      = os.getenv("AGENT_CPUS", "1.0")
AGENT_RUNTIME   = os.getenv("AGENT_RUNTIME", "runsc")  # gVisor: agents never run host-kernel syscalls
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
def user_from_session(handler: BaseHTTPRequestHandler) -> str | None:
    """Validate the better-auth session cookie against the OLTP.

    The Caddy `forward_auth` subrequest is a GET clone of the browser request,
    cookies included, so this is the only trustworthy source of identity on
    that path. Names follow better-auth's defaults and are pinned down
    together with the user_table shape (§9, item 1).
    """
    cookie = http.cookies.SimpleCookie()
    cookie.load(handler.headers.get("Cookie") or "")
    morsel = cookie.get(AUTH_COOKIE_NAME) or cookie.get("__Secure-" + AUTH_COOKIE_NAME)
    if morsel is None:
        return None
    # better-auth signs the cookie as "<token>.<hmac>". The token is the
    # unguessable database credential; the signature only protects it in
    # transit, so the lookup uses the token part.
    token = urllib.parse.unquote(morsel.value).split(".", 1)[0]
    with db() as conn:
        row = conn.execute(
            'SELECT "userId" FROM "session" '
            'WHERE "token" = %s AND "expiresAt" > now()',
            (token,),
        ).fetchone()
    return row["userId"] if row else None


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
        raw = open(LLM_KEK_FILE, "rb").read()
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


# ── BYOK delivery: reconcile desired state into the running agent (§5.4) ────

FAUX_CONFIG = {"provider": "faux", "modelId": "faux-1"}


def reconcile_provider(user_id: str, container: str) -> None:
    """§5.4 steps 2-5, inside resolve() after ensure_started + wait_healthy.

    Desired state is the OLTP row; the agent's /status reports its runtime
    {model, keyFingerprint}. On mismatch — or when a stopped sandbox lost its
    in-memory key — decrypt and POST /config on the per-user network. Never
    writes the key anywhere docker create owns (R3/R5). Raises ManagerError
    (egress_blocked §7.11, kek_unavailable §7.9, agent_image_old §7.5) so
    resolve fails closed instead of silently degrading to faux."""
    selection = provider_selection_get(user_id)
    try:
        status = agent_get(container, "/status", timeout=5.0)
    except Exception:
        return  # healthy moments ago; the reconcile tick or next resolve repairs
    model = status.get("model") or {}
    current = (model.get("provider"), model.get("modelId"), status.get("keyFingerprint"))
    if selection is None:
        if current[0] not in (None, "faux"):
            agent_post(container, "/config", FAUX_CONFIG)  # §5.4 step 5
        return
    key_row = None
    if selection["provider"] != "faux":
        key_row = provider_key_get(user_id, selection["provider"])
    want_fingerprint = key_row["fingerprint"] if key_row else None
    if (selection["provider"], selection["model_id"], want_fingerprint) == current:
        return
    if selection["provider"] != "faux" and AGENT_EGRESS != "open":
        raise ManagerError(
            "egress_blocked",
            f"provider '{selection['provider']}' is selected but AGENT_EGRESS is not open"
            " (§7.11: fail closed, never a silent faux fallback)",
        )
    payload: dict[str, Any] = {"provider": selection["provider"], "modelId": selection["model_id"]}
    if key_row is not None:
        payload["apiKey"] = decrypt_key(
            user_id, selection["provider"], key_row["ciphertext"], key_row["nonce"]
        )
        if key_row["base_url"]:
            payload["baseUrl"] = key_row["base_url"]
    agent_post(container, "/config", payload)
    log.info(
        "provider config delivered user=%s provider=%s fingerprint=%s",
        user_id, selection["provider"], want_fingerprint,
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
# The manager owns sandbox network creation, so it owns this wall too: one
# iptables DROP rule per sandbox bridge, installed through a short-lived
# host-network NET_ADMIN helper created via the docker socket it already
# drives. Nothing legitimate dials host services from a sandbox (guests are
# on-bridge, health checks are container-to-container, published ports are
# loopback-bound), so the rule is unconditional and fail-closed: a network
# whose wall cannot be installed is removed, and a resolve that cannot prove
# the wall answers 503 instead of routing users to an open sandbox.
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
        "--workdir", "/workspace",
        "-v", f"{workspace_vol(user_id)}:/workspace",
        "-v", f"{data_vol(user_id)}:/data",
        "-e", f"AGENT_NAME={name}",
        "-e", "WORKSPACE=/workspace",
        "-e", "SESSION_DB=/data/session.sqlite",
        "-e", f"IDLE_MS={AGENT_IDLE_MS}",
        "-e", f"PORT={AGENT_PORT}",
    ]
    if AGENT_CITATIONS_DEFAULT:
        # RFC 0006 §5.9: the mode of /prompt requests that omit the `citations`
        # field. Sandbox env is fixed at create; the per-request field always wins.
        args += ["-e", f"CITATIONS_DEFAULT={AGENT_CITATIONS_DEFAULT}"]
    for name, ip in sorted((hosts or {}).items()):
        args += ["--add-host", f"{name}:{ip}"]
    if AGENT_DNS:
        # With AGENT_EGRESS=off this is unroutable and name resolution fails
        # fast, which is the intended fail-closed behavior; with egress open it
        # is the only resolver a runsc sandbox has (see guest_ips).
        args += ["--dns", AGENT_DNS]
    args.append(AGENT_IMAGE)
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


# ── agent HTTP client (stdlib; /health never activates the agent) ───────────
def agent_get(container: str, path: str, timeout: float = 3.0) -> dict[str, Any]:
    url = f"http://{container}:{AGENT_PORT}{path}"
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode())


def agent_post(container: str, path: str, payload: dict[str, Any], timeout: float = 15.0) -> dict[str, Any]:
    """POST JSON to the agent on its per-user network (RFC 0012 §5.4 delivery)."""
    url = f"http://{container}:{AGENT_PORT}{path}"
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
            raise ManagerError("agent_image_old",
                               f"{container} runs an image without {path}; rebuild affido-agent and reprovision")
        raise ManagerError("delivery_failed", f"agent {path} answered {exc.code}")
    except urllib.error.URLError as exc:
        raise ManagerError("delivery_failed", f"agent {path} unreachable: {exc.reason}")


def agent_alive(container: str) -> bool:
    try:
        agent_get(container, "/health", timeout=2.0)
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


def provision(user_id: str) -> None:
    """Create the per-user network/volumes/container if absent, then start it."""
    container = container_name(user_id)
    if docker_running(container) is None:
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
        docker(*create_args(user_id, guest_ips(net)))
    ensure_started(container)
    if AGENT_DNS:
        dns_rewrite(container)
    wait_healthy(container)
    mark_running(user_id, container)


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
    ensure_guests(user_id)
    if docker_running(container) is None:
        provision(user_id)  # row exists but container is gone: repair, don't 503
    elif row["status"] != "running" or not agent_alive(container):
        ensure_started(container)
        wait_healthy(container)
        mark_running(user_id, container)

    # RFC 0012 §5.4: every activation reconciles the agent's runtime model
    # against the OLTP desired state (delivery, rotation, faux fallback).
    # Raises ManagerError (egress_blocked, kek_unavailable, agent_image_old)
    # so resolve fails closed with that code.
    reconcile_provider(user_id, container)

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
            reconcile_provider(user_id, container)
            return "delivered"
        except ManagerError as exc:
            return f"pending: {exc.code}"
        except Exception:
            return "pending: delivery_failed"

    def providers_get(self) -> None:
        """GET /whoami and GET /providers/* — behind the peer guard like every
        endpoint; /whoami never provisions (unlike /resolve)."""
        try:
            if self.path.startswith("/whoami"):
                user = user_from_session(self)
                if user is None:
                    return self.send(401, {"error": "invalid session"})
                return self.send(200, {"user_id": user})
            if self.path.startswith("/providers/catalog"):
                self.read_user(self.user_id(), require_user=False)
                return self.send(200, {"version": 1, "providers": provider_catalog()})
            if self.path.startswith("/providers/config"):
                user = self.read_user(self.user_id())
                return self.send(
                    200, provider_config_view(user), {"Cache-Control": "no-store"}
                )
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
        if self.path.startswith("/whoami") or self.path.startswith("/providers/"):
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


def main() -> None:
    enforce_token_default()
    migrate()
    start_loops()
    server = ManagerHTTPServer((LISTEN_ADDR, LISTEN_PORT), Handler)
    log.info(
        "sandbox-manager on %s:%s (image=%s stop_after=%ss egress=%s token=%s)",
        LISTEN_ADDR, LISTEN_PORT, AGENT_IMAGE, STOP_AFTER_S, AGENT_EGRESS,
        "on" if MANAGER_TOKEN else "OFF",
    )
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
