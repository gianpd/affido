#!/usr/bin/env python3
"""RFC 0016 e2e probe: exercise the web-search node through its HTTP contract.

Runs inside the sandbox-manager container, the only other peer on the per-user
network besides the agent. Prints one JSON object; websearch.sh asserts it.

    docker compose exec -T sandbox-manager python3 - <url> <user-id> <run-id> \
        < websearch-probe.py
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import urllib.error
import urllib.request

base = sys.argv[1].rstrip("/")
user_id = sys.argv[2]
run = sys.argv[3]

# The same derivation the manager uses (sandbox_manager.websearch_control_token):
# MANAGER_TOKEN is in this container's env, and the user id scopes the token.
control = hmac.new(
    os.environ["MANAGER_TOKEN"].encode(), b"websearch:" + user_id.encode(), hashlib.sha256
).hexdigest()


def call(
    method: str,
    path: str,
    payload: dict | None = None,
    run_id: str | None = None,
    run_token: str | None = None,
) -> tuple[int, object]:
    data = None if payload is None else json.dumps(payload).encode()
    headers = {"content-type": "application/json", "x-control-token": control}
    if run_id is not None:
        headers["x-run-id"] = run_id
    if run_token is not None:
        headers["x-run-token"] = run_token
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        body = exc.read()
        try:
            parsed = json.loads(body or b"{}")
        except ValueError:
            parsed = {"raw": body.decode("utf-8", "replace")[:200]}
        return exc.code, parsed


def register(run_id: str, web: bool) -> str:
    status, body = call("POST", "/runs", {"web": web}, run_id=run_id)
    if status != 200 or not isinstance(body, dict):
        raise SystemExit(f"run registration failed for {run_id}: {status} {body}")
    token = body.get("runToken")
    if not isinstance(token, str):
        raise SystemExit(f"run registration returned no token for {run_id}: {body}")
    return token


out: dict = {}

# 1. The manager delivered the control token; the same one is idempotent.
status, body = call("POST", "/control", {"token": control})
out["control"] = {"status": status}
status, body = call("POST", "/control", {"token": "0" * 64})
out["control_mismatch"] = {"status": status, "error": (body or {}).get("error") if isinstance(body, dict) else None}

# 2. An unregistered run and an explicitly unauthorised run are both refused.
status, body = call("POST", "/search", {"query": "contratto"}, run_id="run-never-registered")
out["unregistered"] = {"status": status, "error": (body or {}).get("error") if isinstance(body, dict) else None}
off_token = register(f"{run}-off", False)
status, body = call("POST", "/search", {"query": "contratto"}, run_id=f"{run}-off", run_token=off_token)
out["web_off"] = {"status": status, "error": (body or {}).get("error") if isinstance(body, dict) else None}

# 3. Authorised run: search, read, duplicate read, non-http/private filtering.
token = register(run, True)
status, first = call("POST", "/search", {"query": "contratto rinnovo"}, run_id=run, run_token=token)
results = first if isinstance(first, list) else []
out["search"] = {
    "status": status,
    "results": len(results),
    "sourceId": (results[0] or {}).get("sourceId") if results else None,
    "domain": (results[0] or {}).get("domain") if results else None,
    "leaksUrl": any("example.com" in str((r or {}).get("sourceId", "")) for r in results),
}
source = out["search"]["sourceId"]

if isinstance(source, str):
    status, page = call("POST", "/read", {"sourceId": source}, run_id=run, run_token=token)
    out["read"] = {
        "status": status,
        "untrusted": page.get("untrusted") if isinstance(page, dict) else None,
        "url": page.get("url") if isinstance(page, dict) else None,
        "chars": len(page.get("text") or "") if isinstance(page, dict) else 0,
        "hasText": "renews" in (page.get("text") or "") if isinstance(page, dict) else False,
    }
    status, body = call("POST", "/read", {"sourceId": source}, run_id=run, run_token=token)
    out["already_read"] = {"status": status, "error": body.get("error") if isinstance(body, dict) else None}
else:
    out["read"] = {"status": 0}

# 4. The model never names a URL; ids are per-run.
status, body = call("POST", "/read", {"url": "https://example.com/x"}, run_id=run, run_token=token)
out["url_argument"] = {"status": status, "error": body.get("error") if isinstance(body, dict) else None}
status, body = call("POST", "/read", {"sourceId": "web_other_run_3"}, run_id=run, run_token=token)
out["unknown_source"] = {"status": status, "error": body.get("error") if isinstance(body, dict) else None}

# 5. Query length cap.
status, body = call("POST", "/search", {"query": "x" * 300}, run_id=run, run_token=token)
out["query_too_long"] = {"status": status, "error": body.get("error") if isinstance(body, dict) else None}

# 6. Four searches per run, then budget_exhausted.
budget = register(f"{run}-budget", True)
statuses = []
for _ in range(5):
    status, body = call("POST", "/search", {"query": "budget"}, run_id=f"{run}-budget", run_token=budget)
    statuses.append({"status": status, "error": body.get("error") if isinstance(body, dict) else None})
out["searches"] = statuses

print(json.dumps(out))
