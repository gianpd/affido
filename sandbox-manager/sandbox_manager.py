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

import hashlib
import hmac
import http.cookies
import json
import logging
import os
import re
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import psycopg
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
AGENT_MEMORY    = os.getenv("AGENT_MEMORY", "512m")
AGENT_CPUS      = os.getenv("AGENT_CPUS", "1.0")
AGENT_SECRETS   = os.getenv("AGENT_SECRETS_DIR")  # host dir -> /run/secrets:ro
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
MANAGER_CONTAINER = os.getenv("MANAGER_CONTAINER", "sandbox-manager")  # for network connect
CADDY_CONTAINER   = os.getenv("CADDY_CONTAINER")  # compose container_name of caddy
WEB_CONTAINER     = os.getenv("WEB_CONTAINER")  # optional: SvelteKit app that calls /resolve
AUTH_COOKIE_NAME  = os.getenv("AUTH_COOKIE_NAME", "better-auth.session_token")

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


def create_args(user_id: str) -> list[str]:
    name = container_name(user_id)
    args = [
        "create", "--name", name,
        "--network", network_name(user_id),
        "--label", "pi-sandbox-manager=1",
        "--memory", AGENT_MEMORY,
        "--cpus", AGENT_CPUS,
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
    if AGENT_SECRETS:
        # Docker secrets are files at /run/secrets; a host dir re-creates that
        # contract for containers created outside compose.
        args += ["-v", f"{AGENT_SECRETS}:/run/secrets:ro"]
    args.append(AGENT_IMAGE)
    return args


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
    for guest in (MANAGER_CONTAINER, CADDY_CONTAINER, WEB_CONTAINER):
        if guest and guest not in connected:
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


def agent_alive(container: str) -> bool:
    try:
        agent_get(container, "/health", timeout=2.0)
        return True
    except Exception:
        return False


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


def provision(user_id: str) -> None:
    """Create the per-user network/volumes/container if absent, then start it."""
    container = container_name(user_id)
    if docker_running(container) is None:
        net = network_name(user_id)
        if not network_exists(net):
            # check=True: a failed create must not leave a container pointing at
            # a network that does not exist (e.g. exhausted address pools).
            docker("network", "create", "--label", "pi-sandbox-manager=1", net)
        # The manager and Caddy must reach the agent on its private network;
        # both need stable container names (compose `container_name:`).
        for guest in (MANAGER_CONTAINER, CADDY_CONTAINER, WEB_CONTAINER):
            if guest:
                docker("network", "connect", net, guest, check=False)
        docker("volume", "create", workspace_vol(user_id))
        docker("volume", "create", data_vol(user_id))
        docker(*create_args(user_id))
    ensure_started(container)
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
    """
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

    def resolve_reply(self, user_id: str) -> None:
        try:
            result = resolve(user_id)
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

    def do_POST(self) -> None:
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


def main() -> None:
    migrate()
    start_loops()
    server = ThreadingHTTPServer((LISTEN_ADDR, LISTEN_PORT), Handler)
    log.info(
        "sandbox-manager on %s:%s (image=%s stop_after=%ss token=%s)",
        LISTEN_ADDR, LISTEN_PORT, AGENT_IMAGE, STOP_AFTER_S,
        "on" if MANAGER_TOKEN else "OFF",
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
