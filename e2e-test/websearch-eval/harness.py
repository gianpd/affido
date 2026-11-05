#!/usr/bin/env python3
"""Experimental harness for the affido web-search service (RFC 0016).

One run stores every observation on disk under runs/<run-id>/:

  manifest.json       environment fingerprint (images, networks, versions)
  connectivity.json   real-time reachability, measured from host, node, agent
  references/         independent host fetch + Camofox ceiling for every gold URL
  attempts.jsonl      one scored attempt per search (and its read, for URL cases)
  raw/<id>.json       full HTTP bodies of each attempt
  prompt-smoke.json   /prompt through Caddy with web:"allowed" (faux provider)

The scored calls are issued from INSIDE the sandbox agent container with the
exact headers of agent/web-tools.ts postNode(). Run registration is done from
the manager container, which owns MANAGER_TOKEN. No secret is printed.

Usage:
  python3 harness.py run --repeats 3 [--run-id NAME]
  python3 harness.py discover             # pre-gold style probe, no scoring
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html.parser
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
COMPOSE = ["docker", "compose", "-f", str(ROOT / "docker-compose.yml")]
BASE = "http://localhost:18080"
GOLD = HERE / "gold.json"
PROBE = HERE / "probe.mjs"
RUNS = HERE / "runs"

CAMOFOX_HOST = "http://127.0.0.1:9377"
SEARXNG_HOST = "http://127.0.0.1:8080"
USER_AGENT = "Mozilla/5.0 (compatible; affido-weval/1.0)"


def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def sh(args: list[str], stdin: bytes | None = None, timeout: int = 180, check: bool = True) -> str:
    cp = subprocess.run(args, input=stdin, capture_output=True, cwd=ROOT, timeout=timeout)
    if check and cp.returncode != 0:
        raise RuntimeError(f"{' '.join(args[:6])} failed ({cp.returncode}): {cp.stderr.decode('utf8', 'replace')[:600]}")
    return cp.stdout.decode("utf8", "replace").strip()


def psql(sql: str) -> str:
    return sh([*COMPOSE, "exec", "-T", "oltp", "psql", "-U", "pi", "-d", "pi", "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql])


def compose_exec(service: str, script: str, *args: str) -> str:
    return sh([*COMPOSE, "exec", "-T", service, "python3", "-", *args], stdin=script.encode(), timeout=180)


def docker_exec(container: str, args: list[str], stdin: bytes | None = None, timeout: int = 180) -> str:
    return sh(["docker", "exec", "-i", container, *args], stdin=stdin, timeout=timeout)


def http_json(method: str, url: str, payload: dict | None = None, headers: dict | None = None, timeout: int = 30) -> tuple[int, str, float]:
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json", **(headers or {})})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf8", "replace"), round((time.monotonic() - started) * 1000)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf8", "replace"), round((time.monotonic() - started) * 1000)
    except Exception as exc:  # noqa: BLE001 - a failed reachability probe is data, not an abort
        return 0, str(exc), round((time.monotonic() - started) * 1000)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode())


def env_value(name: str) -> str:
    path = ROOT / ".env"
    if not path.exists():
        return ""
    for line in path.read_text().splitlines():
        if line.strip().startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


# ── sandbox provisioning (through Caddy, like the rest of e2e-test) ─────────

def provision(user: str, token: str) -> str:
    psql('CREATE TABLE IF NOT EXISTS "session" ("id" text PRIMARY KEY, "userId" text NOT NULL, "token" text NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL)')
    psql(
        'INSERT INTO "session" ("id","userId","token","expiresAt") '
        f"VALUES ('sess-{user}','{user}','{token}', now() + interval '4 hours') "
        'ON CONFLICT ("id") DO UPDATE SET "token"=EXCLUDED."token", "expiresAt"=EXCLUDED."expiresAt"'
    )
    status, body, _ = http_json("GET", f"{BASE}/u/{user}/status", headers={"Cookie": f"better-auth.session_token={token}"}, timeout=180)
    if status != 200:
        raise RuntimeError(f"provisioning failed: {status} {body[:400]}")
    container = psql(f"SELECT container_name FROM sandbox_registry WHERE user_id = '{user}'")
    if not container:
        raise RuntimeError("no sandbox registered for the evaluation user")
    return container


def keepalive(user: str, token: str, stop: threading.Event) -> threading.Thread:
    def loop() -> None:
        while not stop.wait(25):
            try:
                http_json("GET", f"{BASE}/u/{user}/health", headers={"Cookie": f"better-auth.session_token={token}"}, timeout=15)
            except Exception:  # noqa: BLE001
                pass
    thread = threading.Thread(target=loop, daemon=True, name="weval-keepalive")
    thread.start()
    return thread


# ── run registration (inside the manager, where MANAGER_TOKEN lives) ────────

REGISTER = r'''
import hashlib, hmac, json, os, sys, urllib.error, urllib.request
base, user = sys.argv[1], sys.argv[2]
run_ids = json.loads(sys.argv[3])
control = hmac.new(os.environ["MANAGER_TOKEN"].encode(), b"websearch:" + user.encode(), hashlib.sha256).hexdigest()
def call(path, payload, headers):
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode(), method="POST",
                                 headers={"content-type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf8", "replace")[:300]
status, _ = call("/control", {"token": control}, {"x-control-token": control})
runs = {}
for rid in run_ids:
    st, body = call("/runs", {"web": True}, {"x-control-token": control, "x-run-id": rid})
    runs[rid] = {"status": st, "token": body.get("runToken") if isinstance(body, dict) else None}
print(json.dumps({"control_status": status, "runs": runs}))
'''


def register_runs(node_url: str, user: str, run_ids: list[str]) -> dict[str, str]:
    raw = compose_exec("sandbox-manager", REGISTER, node_url, user, json.dumps(run_ids))
    parsed = json.loads(raw)
    if parsed.get("control_status") != 200:
        raise RuntimeError(f"control delivery refused: {parsed.get('control_status')}")
    tokens: dict[str, str] = {}
    for rid, entry in parsed["runs"].items():
        if entry["status"] != 200 or not isinstance(entry["token"], str) or entry["token"] == "":
            raise RuntimeError(f"run {rid} was not registered: status {entry['status']}")
        tokens[rid] = entry["token"]
    return tokens


# ── in-container probe ──────────────────────────────────────────────────────

def probe(container: str, job: dict, timeout: int = 1800) -> list[dict]:
    source = PROBE.read_text().replace("__WEBEVAL_JOB__", json.dumps(job))
    raw = docker_exec(container, ["node", "--input-type=module", "-"], stdin=source.encode(), timeout=timeout)
    lines = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            lines.append(json.loads(line))
        except json.JSONDecodeError:
            lines.append({"type": "unparsed", "raw": line[:300]})
    return lines


# ── independent references ─────────────────────────────────────────────────

class TextExtractor(html.parser.HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "head", "template"}

    def __init__(self) -> None:
        super().__init__()
        self.hidden = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.SKIP:
            self.hidden += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP and self.hidden:
            self.hidden -= 1

    def handle_data(self, data: str) -> None:
        if not self.hidden and data.strip():
            self.parts.append(data.strip())


def collapse(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().lower()


def fetch_reference(url: str, html_path: Path, text_path: Path) -> dict:
    status = sh(["curl", "-sSL", "--max-time", "45", "-A", USER_AGENT, "-o", str(html_path), "-w", "%{http_code}", url], timeout=60, check=False)
    raw = html_path.read_bytes() if html_path.exists() else b""
    markup = raw.decode("utf8", "replace")
    parser = TextExtractor()
    parser.feed(markup)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(parser.parts))
    text_path.write_text(text)
    return {"url": url, "curl_exit_or_http": status, "html_chars": len(markup), "text_chars": len(text), "html_sha256": sha256_bytes(raw), "text_sha256": sha256_text(text), "fetched_at": utcnow()}


CAMOFOX_EXPRESSION = "JSON.stringify({title: document.title, text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 60000)})"


def camofox_request(method: str, path: str, payload: dict | None, key: str, timeout: int = 60) -> tuple[int, dict | str]:
    request = urllib.request.Request(
        CAMOFOX_HOST + path,
        data=None if payload is None else json.dumps(payload).encode(),
        method=method,
        headers={"content-type": "application/json", **({"authorization": "Bearer " + key} if key else {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf8", "replace")[:300]
    except Exception as exc:  # noqa: BLE001
        return 0, str(exc)


def fetch_ceiling_once(url: str, key: str) -> tuple[str, str, str]:
    status, opened = camofox_request("POST", "/tabs", {"userId": "weval-ceiling", "sessionKey": "reference", "url": url}, key)
    tab = opened.get("tabId") if isinstance(opened, dict) else None
    text, title, note = "", "", ""
    if not isinstance(tab, str):
        return "", "", f"open status {status}: {str(opened)[:200]}"
    try:
        for attempt in range(3):
            if attempt:
                time.sleep(0.25)
            status_ev, evaluated = camofox_request(
                "POST", f"/tabs/{tab}/evaluate", {"userId": "weval-ceiling", "expression": CAMOFOX_EXPRESSION}, key
            )
            raw = evaluated.get("result", "") if isinstance(evaluated, dict) else ""
            if isinstance(raw, str) and raw:
                try:
                    page = json.loads(raw)
                    text = page.get("text") or ""
                    title = page.get("title") or ""
                    if text:
                        break
                except json.JSONDecodeError:
                    pass
            note = f"evaluate status {status_ev}: {str(evaluated)[:150]}"
    finally:
        camofox_request("DELETE", f"/tabs/{tab}?userId=weval-ceiling", None, key)
    return text, title, note


def fetch_ceiling(url: str, path: Path, key: str) -> dict:
    """Full visible page text from the same upstream browser, without the
    node's 6000-char cap: the ceiling the tool is measured against. One retry
    absorbs the browser's transient tab-create failures; both attempts are
    recorded so the reference itself stays auditable."""
    started = time.monotonic()
    attempts = []
    text, title, note = "", "", ""
    for attempt in range(2):
        if attempt:
            time.sleep(1.0)
        text, title, note = fetch_ceiling_once(url, key)
        attempts.append({"attempt": attempt + 1, "chars": len(text), "note": note})
        if text:
            break
    path.write_text(text)
    return {
        "url": url,
        "chars": len(text),
        "title": title,
        "note": note,
        "attempts": attempts,
        "sha256": sha256_text(text),
        "ms": round((time.monotonic() - started) * 1000),
        "fetched_at": utcnow(),
    }


def camofox_tab_probe(key: str) -> dict:
    """Functional readiness of the browser, beyond /health: open a tab,
    evaluate one expression, close the tab."""
    started = time.monotonic()
    status, opened = camofox_request("POST", "/tabs", {"userId": "weval-readiness", "sessionKey": "readiness", "url": "https://www.example.com/"}, key)
    tab = opened.get("tabId") if isinstance(opened, dict) else None
    result = {"open_status": status, "evaluate_status": 0, "title": None, "close_status": 0}
    if isinstance(tab, str):
        ev_status, evaluated = camofox_request("POST", f"/tabs/{tab}/evaluate", {"userId": "weval-readiness", "expression": "document.title"}, key)
        result["evaluate_status"] = ev_status
        result["title"] = evaluated.get("result") if isinstance(evaluated, dict) else str(evaluated)[:100]
        close_status, _ = camofox_request("DELETE", f"/tabs/{tab}?userId=weval-readiness", None, key)
        result["close_status"] = close_status
    result["ms"] = round((time.monotonic() - started) * 1000)
    result["measured_at"] = utcnow()
    return result


def references(gold: dict, run_dir: Path) -> dict:
    ref_dir = run_dir / "references"
    ref_dir.mkdir(parents=True, exist_ok=True)
    key = env_value("CAMOFOX_API_KEY")
    out = {"camofox_key_present": bool(key), "urls": {}, "markers": {}}
    for item in gold["urls"]:
        uid = item["id"]
        meta = fetch_reference(item["url"], ref_dir / f"{uid}.html", ref_dir / f"{uid}.txt")
        ceiling = fetch_ceiling(item["url"], ref_dir / f"{uid}.camofox.txt", key)
        text = (ref_dir / f"{uid}.txt").read_text()
        offsets = {m: collapse(text).find(collapse(m)) for m in item["head_markers"] + item["deep_markers"]}
        full = (ref_dir / f"{uid}.camofox.txt").read_text()
        ceiling_offsets = {m: collapse(full).find(collapse(m)) for m in item["deep_markers"]}
        out["urls"][uid] = {"html": meta, "ceiling": ceiling}
        out["markers"][uid] = {
            "reference_offsets": offsets,
            "invalid_markers": [m for m, offset in offsets.items() if offset < 0],
            "ceiling_offsets": ceiling_offsets,
            "deep_markers_beyond_cap": {m: (offset > 6000) for m, offset in ceiling_offsets.items()},
        }
        print(f"  reference {uid}: html={meta['html_chars']} text={meta['text_chars']} ceiling={ceiling['chars']} invalid_markers={out['markers'][uid]['invalid_markers']}")
    (ref_dir / "meta.json").write_text(json.dumps(out, indent=2))
    return out


# ── real-time reachability ──────────────────────────────────────────────────

def network_snapshot(name: str) -> dict:
    internal = sh(["docker", "network", "inspect", "-f", "{{.Internal}}", name], check=False)
    containers = sh(["docker", "network", "inspect", "-f", "{{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}", name], check=False)
    return {"name": name, "internal": internal, "containers": containers.split()}


def connectivity(gold: dict, agent: str, node: str, node_url: str, run_dir: Path) -> dict:
    host: dict = {}
    http_status, http_body, http_ms = http_json("GET", SEARXNG_HOST + "/search?" + urllib.parse.urlencode({"q": gold["queries"][0]["query"], "format": "json"}), timeout=30)
    try:
        parsed = json.loads(http_body)
        host["searxng_published"] = {
            "status": http_status,
            "ms": http_ms,
            "results": len(parsed.get("results", [])),
            "unresponsive_engines": parsed.get("unresponsive_engines", []),
            "engines": [entry.get("engine") for entry in parsed.get("results", [])[:5]],
        }
    except json.JSONDecodeError:
        host["searxng_published"] = {"status": http_status, "ms": http_ms, "body": http_body[:200], "unresponsive_engines": []}
    status, body, ms = http_json("GET", CAMOFOX_HOST + "/health", timeout=15)
    host["camofox_published"] = {"status": status, "ms": ms, "body": body[:300]}
    status, body, _ = http_json("GET", CAMOFOX_HOST + "/openapi.json", timeout=15)
    try:
        host["camofox_version"] = json.loads(body)["info"]["version"]
    except (json.JSONDecodeError, KeyError):
        host["camofox_version"] = "unknown"
    for name in ("searxng", "camofox-browser"):
        host[name] = {
            "state": sh(["docker", "inspect", "-f", "{{.State.Status}}", name], check=False),
            "image": sh(["docker", "inspect", "-f", "{{.Image}}", name], check=False),
            "networks": sh(["docker", "inspect", "-f", "{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}", name], check=False),
        }
    host["camofox_tab_probe"] = camofox_tab_probe(env_value("CAMOFOX_API_KEY"))
    host["websearch_in"] = network_snapshot("websearch-in")
    host["websearch_out"] = network_snapshot("websearch-out")

    node_hosts = docker_exec(node, ["cat", "/etc/hosts"])
    node_env = docker_exec(node, ["sh", "-c", 'env | grep -E "^(SEARXNG_URL|CAMOFOX_URL|WEBSEARCH_PEERS|PORT)="'])
    env_map = dict(line.split("=", 1) for line in node_env.splitlines() if "=" in line)
    targets = []
    for line in node_hosts.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        ip, hostname = parts[0], parts[1]
        if hostname == "searxng":
            targets.append({"name": "searxng", "host": hostname, "ip": ip, "port": 8080, "url": f"http://{ip}:8080/search?q=connectivity&format=json"})
        elif hostname == "camofox-browser":
            targets.append({"name": "camofox", "host": hostname, "ip": ip, "port": 9377, "url": f"http://{ip}:9377/health"})

    upstream_job = {
        "mode": "upstream",
        "searxngUrl": env_map.get("SEARXNG_URL", "http://searxng:8080"),
        "camofoxUrl": env_map.get("CAMOFOX_URL", "http://camofox-browser:9377"),
        "probeQuery": "affido connectivity probe",
    }
    upstream_lines = probe(node, {"mode": "upstream", **upstream_job}, timeout=180)
    agent_job = {"mode": "connectivity", "nodePort": 8082, "targets": targets}
    agent_lines = probe(agent, agent_job, timeout=180)

    result = {
        "measured_at": utcnow(),
        "host": host,
        "node": {"hosts": node_hosts, "env": {k: v for k, v in env_map.items() if "KEY" not in k}, "probe": upstream_lines},
        "agent": {"probe": agent_lines},
        "targets": targets,
    }
    (run_dir / "connectivity.json").write_text(json.dumps(result, indent=2))
    return result


# ── scored cases ────────────────────────────────────────────────────────────

def build_cases(gold: dict, run_id: str, repeats: int) -> list[dict]:
    cases: list[dict] = []
    for repetition in range(1, repeats + 1):
        for query in gold["queries"]:
            cases.append({
                "id": f"q-{query['id']}-r{repetition}",
                "kind": "query",
                "queryId": query["id"],
                "urlId": None,
                "repetition": repetition,
                "query": query["query"],
                "lang": query.get("lang"),
                "max": 8,
                "runId": f"{run_id}-q-{query['id']}-r{repetition}",
                "goldUrl": None,
            })
        for item in gold["urls"]:
            cases.append({
                "id": f"u-{item['id']}-r{repetition}",
                "kind": "url",
                "queryId": item["query_id"],
                "urlId": item["id"],
                "repetition": repetition,
                "query": item["target_query"],
                "lang": item.get("lang"),
                "max": 8,
                "maxReads": 3,
                "runId": f"{run_id}-u-{item['id']}-r{repetition}",
                "goldUrl": item["url"],
            })
    return cases


def run_cases(gold: dict, run_id: str, repeats: int, agent: str, node_url: str, user: str, run_dir: Path) -> dict:
    cases = build_cases(gold, run_id, repeats)
    tokens = register_runs(node_url, user, [case["runId"] for case in cases])
    for case in cases:
        case["runToken"] = tokens[case["runId"]]
    raw_dir = run_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    lines = probe(agent, {"mode": "cases", "nodeBase": node_url, "cases": cases, "readFirstOnMiss": True}, timeout=1800)
    attempts: list[dict] = []
    for line in lines:
        if line.get("type") != "case":
            continue
        raw_path = raw_dir / f"{line['id']}.json"
        raw_path.write_text(json.dumps(line, indent=2))
        search = line.get("search") or {}
        search_body = search.get("body")
        if isinstance(search_body, dict) and isinstance(search_body.get("results"), list):
            results = search_body["results"]
        elif isinstance(search_body, list):
            results = search_body
        else:
            results = []
        def summarise(entry: dict, index: int) -> dict:
            response = entry.get("response") if isinstance(entry, dict) else None
            response = response if isinstance(response, dict) else {}
            body = response.get("body") if isinstance(response.get("body"), dict) else {}
            page = body.get("page") if isinstance(body.get("page"), dict) else body
            diagnostics = body.get("diagnostics") if isinstance(body.get("diagnostics"), dict) else {}
            text = page.get("text") if isinstance(page.get("text"), str) else ""
            return {
                "index": index,
                "sourceId": entry.get("sourceId"),
                "domain": entry.get("domain"),
                "isGold": entry.get("isGold", False),
                "status": response.get("status"),
                "ms": response.get("ms"),
                "error": response.get("error"),
                "reported_error": page.get("error") or body.get("error"),
                "untrusted": page.get("untrusted"),
                "url": page.get("url"),
                "title": page.get("title"),
                "reported_sha256": page.get("sha256"),
                "truncated": page.get("truncated"),
                "totalChars": page.get("totalChars"),
                "window": diagnostics.get("window"),
                "text_chars": len(text),
                "text_sha256": sha256_text(text),
            }

        reads = line.get("reads") if isinstance(line.get("reads"), list) else []
        read_summaries = [summarise(entry, index) for index, entry in enumerate(reads)]
        primary = next((entry for entry in read_summaries if entry["isGold"]), None)
        if primary is None and read_summaries:
            primary = read_summaries[0]
        attempts.append({
            "id": line["id"],
            "kind": line["kind"],
            "queryId": line["queryId"],
            "urlId": line["urlId"],
            "repetition": line["repetition"],
            "query": line["query"],
            "goldUrl": line["goldUrl"],
            "search": {"status": search.get("status"), "ms": search.get("ms"), "error": search.get("error"), "count": len(results)},
            "results": [
                {"sourceId": r.get("sourceId"), "url": r.get("url"), "title": r.get("title"), "domain": r.get("domain"), "snippet": r.get("snippet")}
                for r in results if isinstance(r, dict)
            ],
            "reads": read_summaries,
            "read": primary,
            "fallback": line.get("fallback", False),
            "matchedUrl": line.get("matchedUrl"),
            "goldReached": line.get("goldReached", False),
            "raw_path": str(raw_path.relative_to(run_dir)),
        })
    with (run_dir / "attempts.jsonl").open("w") as handle:
        for attempt in attempts:
            handle.write(json.dumps(attempt) + "\n")
    return {"expected": len(cases), "observed": len(attempts), "done": any(line.get("type") == "done" for line in lines)}


def prompt_smoke(run_id: str, user: str, token: str, run_dir: Path) -> dict:
    out = []
    for index in range(1, 4):
        request_id = f"{run_id}-prompt-{index}"
        status, body, ms = http_json(
            "POST",
            f"{BASE}/u/{user}/prompt",
            {"prompt": "search the web for the renewal date", "requestId": request_id, "web": "allowed"},
            headers={"Cookie": f"better-auth.session_token={token}"},
            timeout=180,
        )
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"raw": body[:500]}
        out.append({
            "requestId": request_id,
            "status": status,
            "ms": ms,
            "webMode": parsed.get("webMode"),
            "runStatus": parsed.get("status"),
            "answer": parsed.get("answer"),
            "tool_chain_ok": isinstance(parsed.get("answer"), str) and "Read the page:" in parsed["answer"],
        })
        print(f"  prompt smoke {index}: http={status} runStatus={out[-1]['runStatus']} chain_ok={out[-1]['tool_chain_ok']}")
    result = {"measured_at": utcnow(), "attempts": out}
    (run_dir / "prompt-smoke.json").write_text(json.dumps(result, indent=2))
    return result


# ── manifest ────────────────────────────────────────────────────────────────

def manifest(run_id: str, user: str, agent: str, node: str, node_url: str, repeats: int, started: str, counts: dict, run_dir: Path) -> dict:
    manager_env = sh([*COMPOSE, "exec", "-T", "sandbox-manager", "printenv"], check=False)
    interesting = {}
    for line in manager_env.splitlines():
        if "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name in {"AGENT_EGRESS", "AGENT_IMAGE", "WEBSEARCH_IN", "WEBSEARCH_OUT", "SEARXNG_URL", "CAMOFOX_URL", "WEBSEARCH_MEMORY", "WEBSEARCH_CPUS", "AGENT_IDLE_MS", "STOP_AFTER_S"}:
            interesting[name] = value
    result = {
        "run_id": run_id,
        "started_at": started,
        "finished_at": utcnow(),
        "repeats": repeats,
        "gold_sha256": sha256_bytes(GOLD.read_bytes()),
        "git_sha": sh(["git", "rev-parse", "HEAD"], check=False),
        "user_id": user,
        "agent_container": agent,
        "node_container": node,
        "node_url": node_url,
        "agent_node_version": docker_exec(agent, ["node", "--version"]),
        "node_node_version": docker_exec(node, ["node", "--version"]),
        "agent_image": sh(["docker", "inspect", "-f", "{{.Image}}", agent], check=False),
        "docker_version": sh(["docker", "version", "--format", "{{.Server.Version}}"], check=False),
        "host_env_AGENT_EGRESS": env_value("AGENT_EGRESS") or "off (default)",
        "manager_env": interesting,
        "HTTP_entrypoint": BASE,
        "counts": counts,
    }
    (run_dir / "manifest.json").write_text(json.dumps(result, indent=2))
    return result


# ── optional discovery (no scoring) ─────────────────────────────────────────

def discover(run_dir: Path, gold: dict) -> None:
    """Pre-gold style probe: what the live index returns, and whether the
    upstream browser can extract each URL. Not used for scoring."""
    out = {"measured_at": utcnow(), "queries": [], "urls": []}
    for query in gold["queries"]:
        status, body, ms = http_json("GET", SEARXNG_HOST + "/search?" + urllib.parse.urlencode({"q": query["query"], "format": "json"}), timeout=30)
        try:
            results = json.loads(body).get("results", [])
        except json.JSONDecodeError:
            results = []
        out["queries"].append({"query": query["query"], "status": status, "ms": ms, "count": len(results), "urls": [r.get("url") for r in results[:10]]})
    key = env_value("CAMOFOX_API_KEY")
    for item in gold["urls"]:
        status, opened = camofox_request("POST", "/tabs", {"userId": "weval-discover", "sessionKey": "discovery", "url": item["url"]}, key)
        tab = opened.get("tabId") if isinstance(opened, dict) else None
        text = ""
        if isinstance(tab, str):
            for attempt in range(3):
                if attempt:
                    time.sleep(0.25)
                _, evaluated = camofox_request("POST", f"/tabs/{tab}/evaluate", {"userId": "weval-discover", "expression": CAMOFOX_EXPRESSION}, key)
                raw = evaluated.get("result", "") if isinstance(evaluated, dict) else ""
                if isinstance(raw, str) and raw:
                    try:
                        text = json.loads(raw).get("text") or ""
                        if text:
                            break
                    except json.JSONDecodeError:
                        pass
            camofox_request("DELETE", f"/tabs/{tab}?userId=weval-discover", None, key)
        out["urls"].append({"url": item["url"], "open_status": status, "chars": len(text)})
    (run_dir / "discovery.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


# ── entrypoint ──────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["run", "discover"])
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--run-id", default=dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    args = parser.parse_args()
    gold = json.loads(GOLD.read_text())
    run_dir = RUNS / args.run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    if args.command == "discover":
        discover(run_dir, gold)
        return

    started = utcnow()
    user = f"weval-{args.run_id}"
    token = f"tok-{user}"
    print(f"[{started}] run {args.run_id}: provisioning {user}")
    agent = provision(user, token)
    node = f"{agent}-websearch"
    node_url = f"http://{node}:8082"
    stop = threading.Event()
    keepalive(user, token, stop)
    counts: dict = {}
    try:
        print("== independent references (host HTML + Camofox full text ceiling) ==")
        references(gold, run_dir)
        print("== real-time reachability ==")
        connectivity(gold, agent, node, node_url, run_dir)
        print("== scored tool-contract cases (from inside the agent container) ==")
        counts["cases"] = run_cases(gold, args.run_id, args.repeats, agent, node_url, user, run_dir)
        print("== /prompt smoke through Caddy (faux model, web allowed) ==")
        counts["prompt"] = {"attempts": len(prompt_smoke(args.run_id, user, token, run_dir)["attempts"])}
    finally:
        stop.set()
    info = manifest(args.run_id, user, agent, node, node_url, args.repeats, started, counts, run_dir)
    print(f"done: {run_dir} (expected {counts.get('cases', {}).get('expected')} cases, observed {counts.get('cases', {}).get('observed')})")
    print(f"agent={info['agent_container']} node={info['node_container']}")


if __name__ == "__main__":
    main()
