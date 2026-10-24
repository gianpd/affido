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
import ipaddress
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
# `off` (default): per-user networks are created without NAT egress, so a
# sandbox can talk to its guests (caddy, manager, web) on its own subnet and
# nothing else. `open` keeps the plain-bridge behaviour (internet egress) for
# deployments whose model provider is reached over the internet (openrouter).
AGENT_EGRESS    = os.getenv("AGENT_EGRESS", "off")
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

    The helper is this manager's own image (id via MANAGER_CONTAINER),
    short-lived, and only ever runs scripts this module wrote: no user input
    reaches it (bridge names derive from docker network ids).
    """
    if not MANAGER_CONTAINER:
        raise RuntimeError("HOSTWALL needs MANAGER_CONTAINER (compose container name)")
    image = docker("inspect", "-f", "{{.Image}}", MANAGER_CONTAINER).strip()
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
    guest_names = {MANAGER_CONTAINER, CADDY_CONTAINER, WEB_CONTAINER} - {None, ""}
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
        if self.rejected_sandbox_peer():
            return self.send(403, {"error": "sandbox peers cannot call the manager"})
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


def main() -> None:
    migrate()
    start_loops()
    server = ThreadingHTTPServer((LISTEN_ADDR, LISTEN_PORT), Handler)
    log.info(
        "sandbox-manager on %s:%s (image=%s stop_after=%ss egress=%s token=%s)",
        LISTEN_ADDR, LISTEN_PORT, AGENT_IMAGE, STOP_AFTER_S, AGENT_EGRESS,
        "on" if MANAGER_TOKEN else "OFF",
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
