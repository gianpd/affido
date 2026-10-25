"""Trusted-caller probe for the e2e suites: talks to the manager API from its
own network namespace with X-Manager-Token, exactly like the SvelteKit app in
trusted-manager mode (RFC 0003 / RFC 0012 §5.3). Piped to the container as

    docker compose exec -T sandbox-manager python3 - GET /path < manager-call.py

Puts "method path [json-body]" on argv; prints the status line, then the body.
"""

import json
import os
import sys
import urllib.error
import urllib.request

METHOD, PATH = sys.argv[1], sys.argv[2]
BODY = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
REQUEST = urllib.request.Request(
    "http://localhost:8090" + PATH,
    method=METHOD,
    data=json.dumps(BODY).encode() if BODY is not None else None,
    headers={"X-Manager-Token": os.environ.get("MANAGER_TOKEN", ""), "Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(REQUEST, timeout=60) as response:
        print(response.status)
        print(response.read().decode())
except urllib.error.HTTPError as exc:
    print(exc.code)
    print(exc.read().decode())
