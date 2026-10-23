# RFC 0003 — Python Sandbox Manager, Postgres `sandbox_registry`, per-user agent sandboxes

| Field | Value |
|---|---|
| Status | Draft |
| Author | Affido maintainers |
| Date | 2026-10-17 |
| Target | `affido` (new `sandbox-manager/` service, `caddy/Caddyfile`, `web/` + `oltp/` from the `pitas.png` topology) |
| Related | RFC 0002 (`docs/rfc/0002-n-users-n-sandboxes.md`, superseded by §4 here); `pitas.png` |

## 1. Summary

`pitas.png` places a **Python container labelled "Sandbox Manager"** between Caddy
and a fleet of Node agent sandboxes, with a Postgres `OLTP` holding a `user_table`
and a `sandbox_registry`. The manager "check[s] if user has already a sandbox,
check[s] its status, provide[s] the sandbox", driven by `json-rpc/docker-cli`; it
reads and writes `sandbox_registry` over JDBC.

This RFC specifies that component as a **single, self-contained Python service**.
It is a thin **lifecycle supervisor and service resolver**, not a code-execution
sandbox: it owns Docker lifecycle and the `user → sandbox` mapping, while the agent
container keeps owning its session state (SQLite on `/data`, workspace on
`/workspace`) exactly as it does today.

The complete script is written out in §5. It depends only on `psycopg` and drives
Docker through the `docker` CLI; there is no other library, no generated code, and
nothing to keep in sync with a second codebase. Each RFC-sized behaviour paragraph
in §6–§8 maps to a function in that script.

This supersedes the Node `sandbox-gw` of RFC 0002. RFC 0002's measurements (L1
`docker stop` ≈ 440 ms resume, ~63 MiB idle per sandbox, 40 in ≈ 5 s out / 7 s in)
still describe the platform; RFC 0002's in-gateway SQLite action queue is replaced
by the Postgres `sandbox_registry` that `pitas.png` mandates.

## 2. Context

Today the stack is static: `caddy:18080` routes `/a1 /a2 /a3` to three long-lived
`agent-a/b/c` containers. There is no user concept and no database. `pitas.png`
introduces both:

- a **Web Client** (SvelteKit) that serves the UI and owns authentication through
  better-auth;
- an **OLTP Postgres** with `user_table` (better-auth) and `sandbox_registry`;
- a **Sandbox Manager** (Python) that provisions one agent sandbox per user;
- the existing **Agent Sandbox** images (Node + `/workspace` + `/data` SQLite).

The manager is the "on-demand starter" the README already calls for ("Scaling a
container to zero would work only with the proxy resolving a live address").

## 3. Target architecture (`pitas.png`)

```
                                  Users
                                    │ https
                                    ▼
                        ┌───────────────────────────┐
                        │  Web Client               │  [container: sveltekit]
                        │  serve static + better-auth│
                        └───────┬───────────────┬───┘
              JDBC (read/write) │               │ https
                                ▼               ▼
                    ┌───────────────────┐   ┌──────────────────────────┐
                    │  OLTP             │   │  Caddy reverse_proxy     │
                    │  [postgres]       │   │  handle user requests    │
                    │  tables:          │   │  and route to the agents │
                    │   - user_table    │   └───────┬──────────┬───────┘
                    │   - sandbox_      │           │ http     │ json/https
                    │     registry      │           ▼          ▼
                    └───────▲───────────┘   ┌────────────────┐  ┌────────────────────┐
                            │               │ Sandbox Manager│  │  Agent Sandbox     │
              JDBC (read/   │               │ [container:    │  │  [container: node] │
               write): pull │               │  python]       │  │  docker containers │
               registry w/  │               │ check sandbox, │──┤  with workspace    │
               user FK,     │               │ check status,  │  │  + SQLite          │
               add rows     └───────────────┤ provide it     │  │                    │
                                            └───────┬────────┘  └─────────┬──────────┘
                                                    │ docker-cli          │
                                                    └────────────────────▶│
                                                                        ┌──┴──┬──┴──┐
                                                                       ws  SQLite  …  (one pair per user)
```

Reading the diagram, and the reading this RFC adopts:

| Edge | Protocol | Meaning |
|---|---|---|
| Users → Web Client | https | UI + auth (better-auth) |
| Web Client → OLTP | JDBC r/w | better-auth tables; UI reads/writes `sandbox_registry` status |
| Web Client → Caddy | https | the browser's API calls go through Caddy |
| Caddy → Sandbox Manager | http | **control plane**: resolve `user → sandbox`, start it |
| Caddy → Agent Sandbox | json/https | **data plane**: the proxied user request (`/prompt`, `/files`, …) |
| Manager → Docker | docker-cli | `docker create/start/stop/restart/inspect` for the agent containers |
| Manager ↔ OLTP | JDBC r/w | read `sandbox_registry` by user FK; insert/update rows |

The response to a user travels **in-band, back along the edge the request came in
on**: `Agent Sandbox → Caddy → Web Client → User`. The manager never sees the
agent's answer; it only consumes `/health`, `/status` and `/resolve` metadata.

## 4. Relationship to RFC 0002

| RFC 0002 | RFC 0003 |
|---|---|
| `sandbox-gw` in Node | `sandbox-manager` in Python |
| control queue in SQLite inside the gateway | `sandbox_registry` in the shared OLTP Postgres |
| L1 eviction via `docker stop` | unchanged (this is the default eviction) |
| L2 gVisor checkpoint/restore | unchanged, optional, same feature flag and findings |
| anonymous containers keyed by route | per-user containers keyed by `user_id` |

RFC 0002's benchmark tables (`bench/`) remain the capacity model. This RFC does not
re-measure them.

## 5. `sandbox_manager.py` — the script

This is the whole service. It is copied verbatim into
`sandbox-manager/sandbox_manager.py`; the `Dockerfile` installs it plus `psycopg`
and the `docker` CLI, and mounts `/var/run/docker.sock`.

```python
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
AGENT_MEMORY    = os.getenv("AGENT_MEMORY", "512m")
AGENT_CPUS      = os.getenv("AGENT_CPUS", "1.0")
AGENT_SECRETS   = os.getenv("AGENT_SECRETS_DIR")  # host dir -> /run/secrets:ro
STOP_AFTER_S    = int(os.getenv("STOP_AFTER_S", "600"))
LISTEN_ADDR     = os.getenv("LISTEN_ADDR", "0.0.0.0")
LISTEN_PORT     = int(os.getenv("LISTEN_PORT", "8090"))
READY_TIMEOUT_S = int(os.getenv("READY_TIMEOUT_S", "60"))
EVICT_TICK_S    = int(os.getenv("EVICT_TICK_S", "15"))
RECONCILE_S     = int(os.getenv("RECONCILE_S", "60"))
UNHEALTHY_LIMIT = int(os.getenv("UNHEALTHY_LIMIT", "3"))
MANAGER_TOKEN     = os.getenv("MANAGER_TOKEN")  # shared secret; all endpoints but /healthz
MANAGER_CONTAINER = os.getenv("MANAGER_CONTAINER", "sandbox-manager")  # for network connect
CADDY_CONTAINER   = os.getenv("CADDY_CONTAINER")  # compose container_name of caddy
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
    morsel = cookie.get(AUTH_COOKIE_NAME)
    if morsel is None:
        return None
    with db() as conn:
        row = conn.execute(
            'SELECT "userId" FROM "session" '
            'WHERE "token" = %s AND "expiresAt" > now()',
            (morsel.value,),
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
    if AGENT_SECRETS:
        # Docker secrets are files at /run/secrets; a host dir re-creates that
        # contract for containers created outside compose.
        args += ["-v", f"{AGENT_SECRETS}:/run/secrets:ro"]
    args.append(AGENT_IMAGE)
    return args


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
        docker("network", "create", "--label", "pi-sandbox-manager=1", net, check=False)
        # The manager and Caddy must reach the agent on its private network;
        # both need stable container names (compose `container_name:`).
        for guest in (MANAGER_CONTAINER, CADDY_CONTAINER):
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
        if row["status"] == "running":
            registry_set(user_id, "idle_paused")
        idle_for = time.time() - row["last_seen_at"].timestamp()
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
```

## 6. Data model — `sandbox_registry`

The script's `SCHEMA` is the source of truth. In production the migration adds
the foreign key to the identity table once better-auth's table name is fixed
(§9, item 1):

```sql
CREATE TABLE sandbox_registry (
  user_id        text        PRIMARY KEY REFERENCES user_table(id) ON DELETE CASCADE,
  container_name text        NOT NULL,          -- "u<slug>"
  container_id   text,                          -- docker id, null until created
  workspace_vol  text        NOT NULL,          -- "pi-ws-<slug>"
  data_vol       text        NOT NULL,          -- "pi-data-<slug>"
  endpoint       text,                          -- "u<slug>:8080"
  status         text        NOT NULL
                 CHECK (status IN ('creating','running','idle_paused','stopped','checkpointed','error')),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
```

Invariants:

1. **One sandbox per user.** `user_id` is the primary key; `try_claim` uses
   `pg_advisory_xact_lock(hashtext(user_id))`, so concurrent resolves for the
   same user serialise and only one container is created.
2. **The row is the durable record; Docker is the source of truth for liveness.**
   `reconcile_tick` repairs drift (row says `running`, container gone).
3. **Only the manager writes lifecycle columns.** The Web Client may insert the
   `creating` row at signup and otherwise reads, keeping one writer per field.
4. **`last_seen_at` is the activity clock.** The manager is on the control path of
   every request (`/resolve`), so it updates on each solve; once requests stop, the
   clock freezes and `STOP_AFTER_S` later the sandbox is stopped.
5. **`user_id` is server-derived on the browser path.** `GET /resolve` derives it
   from the validated better-auth session cookie and 403s any mismatch with the
   requested id; `POST /resolve` (token-gated Web Client) is the one
   trusted-caller exception.

## 7. Behaviour reference

| Concern | Function | Notes |
|---|---|---|
| Schema bootstrap | `migrate` | `CREATE TABLE IF NOT EXISTS`; production migration adds the FK |
| Claim a user | `try_claim` | advisory lock + insert `creating`; returns whether we won |
| Create/start | `provision` | per-user network → volumes → `docker create` → `start` → `/health` → `running` |
| Resolve | `resolve` | none → claim+provision; container gone → reprovision; `running` → probe; else start+wait; always `touch` |
| Idle → stop (L1) | `eviction_tick` | agent `paused:true` and idle ≥ `STOP_AFTER_S` → `docker stop` → `stopped` |
| Drift + watchdog | `reconcile_tick` | missing container → `stopped`; unhealthy `N` ticks → `docker restart` |
| Status | `GET /status` | registry row merged with live `docker inspect` |
| Metrics | `GET /metrics` | counts by status + current unhealthy map |
| Health | `GET /healthz` | liveness for the manager itself |

### 7.1 HTTP API (internal; every endpoint but `/healthz` requires the
`X-Manager-Token` shared secret — the manager sits on networks agent
containers can reach)

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | liveness (the only unauthenticated endpoint) |
| GET | `/resolve?user_id=` | browser path (Caddy `forward_auth` subrequest): session cookie is authoritative, query id cross-checked; same response/header as POST |
| POST | `/resolve` | `{user_id}` → `{endpoint, status, container_name, cold_start_ms}` and header `X-Sandbox-Endpoint` (trusted Web Client only) |
| POST | `/pause` | `{user_id}` → stop now (deterministic; tests and admin) |
| GET | `/status?user_id=` | registry row + live Docker state |
| GET | `/metrics` | aggregate counters |

### 7.2 State machine

```
                resolve (no row)                start ok + healthy
  (no row) ───────────────────────▶ creating ───────────────────────▶ running
     ▲                                      ▲                            │
     │ signup insert (web client)           │ create + volumes           │ agent /status paused=true
     │                                      │                            │ and idle >= STOP_AFTER_S
     │                                  reconcile                        ▼
     │                                  (repair)                     stopped ──resolve──▶ running
     │                                                               │  docker start; agent
     │                                       idle >= CKPT_AFTER_S     │  resumes from SQLite
     └─────────── docker rm ◀──────────── checkpointed  (L2, optional, runsc image on disk)

  running & unhealthy for N probes ──watchdog──▶ restart (docker restart)
  explicit /pause ──▶ stopped   (never auto-resurrects)
```

`idle_paused` is the manager's *observation* of the agent's in-process L0 pause.
The manager never stops a container while the agent reports `inFlight > 0`
(`/status`); L0 is the first barrier, L1 the second — the invariant RFC 0002
relies on.

## 8. Caddy routing

`caddy/Caddyfile` gains a dynamic route for user traffic. On `https://…/u/<id>/*`,
Caddy must (a) ask the manager to resolve/start the sandbox and (b) proxy to the
returned endpoint. Every mechanism below is verified against the Caddy docs and
the v2.8 source (the currently pinned `caddy:2.8-alpine` supports all of it):

```caddyfile
@u path_regexp u ^/u/([^/]+)/(.*)$
handle @u {
    # GHSA-7r4p-vjf4-gxv4 defense: a client-supplied X-Sandbox-Endpoint must
    # never survive to the reverse_proxy dial (see §11).
    header -X-Sandbox-Endpoint
    # The agent expects /prompt, not /u/<id>/prompt.
    rewrite * /{re.u.2}
    forward_auth sandbox-manager:8090 {
        # The subrequest is a GET clone of the original request: cookies are
        # included, the body is NOT consumed, so POST bodies replay intact to
        # the agent. The original query string is appended (caddy #6795); the
        # manager takes the first user_id, i.e. the one set here.
        uri /resolve?user_id={re.u.1}
        header_up X-Manager-Token {env.MANAGER_TOKEN}
        copy_headers X-Sandbox-Endpoint
    }
    # Placeholder upstreams are documented as valid when the address is
    # scheme-less and includes the port — the manager returns "u<slug>:8080".
    reverse_proxy {http.request.header.X-Sandbox-Endpoint}
}
```

Design notes, all checked against live sources:

- **No `method POST`.** The draft sketch overrode the subrequest method; that is
  exactly what must not be done. `forward_auth` defaults to a GET subrequest
  precisely "so that the incoming request's body is not consumed" (docs,
  expanded form). A POST override would stream the browser's body into
  `/resolve`, consume it, and leave the agent with an empty body — the draft's
  "open risk" is resolved by deleting the override, not by buffering.
- **`/resolve` answers GET.** The manager implements it in `do_GET`, taking
  `user_id` from the query string (§5).
- **Authentication happens inside the subrequest.** The clone carries the
  browser's `Cookie` header; the manager validates the better-auth session
  against the OLTP and derives `user_id` itself (`user_from_session`). The
  path id is cross-checked, never trusted: `/u/<other-id>/…` with someone
  else's or no session is a 403/401 that Caddy relays to the browser.
  Without this, the route is a pure IDOR.
- **The dynamic upstream is official.** Placeholders are allowed in
  `reverse_proxy` upstream addresses when the value has no scheme and includes
  the port (docs, "Upstream addresses"; caddy #6254). Caddy counts it as one
  "dynamically static" upstream — no LB/health-check semantics needed here.
- **Caddy pin.** `forward_auth` + `copy_headers` is vulnerable to client-header
  injection on Caddy 2.10.0–2.11.1 (GHSA-7r4p-vjf4-gxv4: if the auth response
  omits a copied header, the client's value passes through — here an SSRF dial
  into the Docker network). Pin `caddy:>=2.11.2` and keep the
  `header -X-Sandbox-Endpoint` strip regardless; on 2.8 the old code blanks
  the header (fails closed), so the strip is belt-and-braces.
- **Compose prerequisite.** `docker network connect` needs stable names: give
  the caddy and sandbox-manager services explicit `container_name:`s (they
  are attached to each per-user network at provision time, §5 `provision`).

Fallback, unchanged in spirit: if reading better-auth's session table proves
awkward (§9, item 1), the Web Client — which authenticates users anyway —
calls `POST /resolve` itself and proxies to the returned endpoint, and the
route above is dropped.

## 9. Assumptions and open questions

Surfaced explicitly, because `pitas.png` is a sketch and the answers change the
implementation:

1. **`user_table` shape.** The diagram names `user_table`; better-auth's default is
   `user`. The FK type/name must match whatever better-auth emits (text id vs
   uuid). The script keeps `user_id text` without the FK so it runs before that
   decision; the production migration adds it.
2. **Who resolves, Caddy or the Web Client — decided.** Caddy `forward_auth` it
   is (§8): the subrequest is a GET clone that carries the session cookie and
   never touches the body, and the manager validates the session against the
   OLTP directly. The Web-Client fallback stays documented for the case where
   the better-auth session schema is inconvenient to read.
3. **Secret delivery to per-user agents.** Compose mounts secrets per service;
   dynamically created containers cannot. The script mounts `AGENT_SECRETS_DIR`
   read-only at `/run/secrets` when set. Confirm that is the intended key path and
   contain the privilege in the manager.
4. **Non-UUID user ids — decided.** `slug` now always appends a hash of the full
   id, so truncation of the readable prefix can never alias two users onto the
   same container/volumes (a shared-prefix collision would otherwise hand one
   user another's sandbox). Any better-auth id format is safe; UUIDs merely
   stay prettier.
5. **Container user.** The script does not pass `--user`, because the current
   agent image creates `/workspace` and `/data` as root and a fresh named volume
   inherits that ownership. Moving to uid 1000 requires chowning the volumes (or
   an image change); `no-new-privileges` is kept regardless.
6. **Multi-host.** Single Docker host, as in RFC 0002. The registry would need a
   `host` column before the manager becomes a fleet scheduler. Out of scope.

## 10. Non-goals

- **Not a code-execution sandbox.** The manager never runs user work; agent tools
  run inside the agent (`agent/agent.ts` → `CodingTools`). It uses only lifecycle
  plus `/health`/`/status`/`/pause`.
- **Not a replacement for pi-durable durability.** L1 eviction is safe only
  because the agent's SQLite is the checkpoint (README; RFC 0002 §7).
- **No new database.** The manager uses the OLTP Postgres the Web Client already
  needs; it adds one table.
- **No warm pool of anonymous containers.** Each container is bound to one user by
  its volumes, so pre-warming is meaningless; signup-time provisioning to
  `stopped` gives the first request a cheap `docker start` instead.
- **No change to `agent/`.** The agent source is untouched.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Docker socket in the manager = effectively root on the host | Isolated service on the internal network, no published ports, only Caddy/Web Client reach it |
| Registry ↔ Docker drift | `reconcile_tick` on a timer; the row is repaired, never trusted as liveness truth |
| Double provisioning under concurrent resolves | `PRIMARY KEY(user_id)` + `pg_advisory_xact_lock` in `try_claim` |
| First-request cold start (~2–7 s) | Provision at signup to `stopped`; first request is a `start` (~440 ms, RFC 0002) |
| Eviction during a turn | Stop only when the agent reports `paused:true` with `inFlight=0` (L0 barrier) |
| Caddy `forward_auth` body replay / dynamic upstream | Resolved: the default GET subrequest never consumes the request body (Caddy docs); placeholder upstreams work scheme-less with a port — the manager returns `u<slug>:8080` |
| Unauthenticated `/u/*` would be cross-user access (IDOR) | `GET /resolve` derives `user_id` from the validated better-auth session cookie and 403s path-id mismatches (§8); M3 has a negative test |
| GHSA-7r4p-vjf4-gxv4: `copy_headers` passes a client-supplied header through when the auth response omits it (Caddy 2.10.0–2.11.1) | Pin `caddy:>=2.11.2`; strip `X-Sandbox-Endpoint` at route entry (§8) — an injected value would be an SSRF dial into the Docker network |
| The manager sits on networks agent containers (which run user code) can reach | `X-Manager-Token` on every endpoint but `/healthz`; one bridge network per sandbox so agents cannot dial each other (§5 `network_name`); default Docker address pools allow only a few dozen bridges — size `default-address-pools` for the bench scale of 40 |
| Registry row whose container vanished → permanent 503 | `resolve()` reprovisions when `docker_running()` is `None` instead of raising; failed resolves mark the row `error` |
| `docker` CLI version skew | Pin the CLI version in the image; the script only uses create/start/stop/restart/inspect/volume |

## 12. Milestones and verification

Each milestone has a check that does not require a real LLM (the faux provider
suffices, as in `verify.sh`).

1. **M1 — registry + resolve + L1.** `sandbox_manager.py` deployed, `migrate` run,
   agent image available locally (`AGENT_IMAGE`).
   *Verify:* `POST /resolve` for a fresh user returns an endpoint and the row
   becomes `running`; the SQLite file appears in `pi-data-<slug>`; a second
   `/resolve` returns the same `container_id`; after `STOP_AFTER_S` the container
   is `stopped` with RAM at 0; the next `/resolve` resumes with the **same
   `conversationId` and `entries`** (the RFC 0002/`verify.sh` invariant); two
   user_ids sharing a 32-char cleaned prefix resolve to **distinct** containers
   and volumes (slug hash suffix).
2. **M2 — reconcile + metrics.** Kill a container out from under the registry and
   make another fail `/health`.
   *Verify:* the missing one becomes `stopped`; the unhealthy one is
   `docker restart`ed after `UNHEALTHY_LIMIT` ticks and never a registry-`stopped`
   one; `/metrics` counts match the table.
3. **M3 — edge integration.** Caddy `forward_auth` (or the Web-Client fallback)
   plus the SvelteKit Web Client and better-auth.
   *Verify:* login → first `/prompt` provisions and answers; dashboard shows
   `running`; idle → `stopped`; `sandbox_registry` never holds two rows for one
   `user_id`. Negative tests, all required to pass: user A's session against
   `/u/<B>/…` → 403; no session → 401; a request with a spoofed
   `X-Sandbox-Endpoint` never dials it (strip + Caddy ≥ 2.11.2); agent A cannot
   reach agent B's `:8080` (per-user network); any manager call without
   `X-Manager-Token` → 401.
4. **M4 (optional) — L2 gVisor.** Reuse RFC 0002's `runsc` checkpoint/restore and
   its network-endpoint caveat verbatim; feature-flagged off by default.
5. **Regression gate.** `verify.sh` extended, not rewritten: the static `/a1`
   route may remain as a smoke test while the per-user path is added.
