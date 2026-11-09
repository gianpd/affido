"""Unit tests of the BYOK pieces that need no database and no docker socket:
the KEK scheme (RFC 0012 §5.2 / RFC 0004 §4.7), the fingerprint, and the
custom-baseUrl rules with the TOCTOU-safe validation client (§5.1, §5.6).

Run inside the manager image (verify.sh):
  docker compose run --rm --no-deps --network none --entrypoint python3 \
      sandbox-manager -m unittest test_sandbox_manager
"""

from __future__ import annotations

import base64
import http.client
import http.server
import io
import json
import os
import sys
import tempfile
import threading
import unittest

import sandbox_manager as sm


def setUpModule() -> None:  # one KEK per test run, both encodings exercised
    global _KEYDIR
    _KEYDIR = tempfile.mkdtemp(prefix="kek-")
    raw = bytes(range(32))
    with open(os.path.join(_KEYDIR, "raw"), "wb") as handle:
        handle.write(raw)
    with open(os.path.join(_KEYDIR, "b64"), "wb") as handle:
        handle.write(base64.b64encode(raw))


_KEYDIR = ""


class KekCryptoTest(unittest.TestCase):
    def setUp(self) -> None:
        sm._kek.clear()

    def use(self, name: str) -> None:
        sm.LLM_KEK_FILE = os.path.join(_KEYDIR, name)
        sm._kek.clear()

    def test_round_trip_raw_and_base64(self) -> None:
        for name in ("raw", "b64"):
            with self.subTest(encoding=name):
                self.use(name)
                ciphertext, nonce = sm.encrypt_key("user-a", "openai", "sk-secret")
                self.assertNotIn(b"sk-secret", bytes(ciphertext))
                self.assertEqual(len(nonce), 12)
                self.assertEqual(sm.decrypt_key("user-a", "openai", ciphertext, nonce), "sk-secret")

    def test_aad_swap_rejected(self) -> None:
        self.use("raw")
        ciphertext, nonce = sm.encrypt_key("user-a", "openai", "sk-secret")
        # A row swapped onto another user (or provider) must not decrypt.
        for user, provider in (("user-b", "openai"), ("user-a", "groq")):
            with self.subTest(target=f"{user}/{provider}"):
                with self.assertRaises(sm.ManagerError) as ctx:
                    sm.decrypt_key(user, provider, ciphertext, nonce)
                self.assertEqual(ctx.exception.code, "kek_unavailable")

    def test_wrong_or_missing_kek_fails_closed(self) -> None:
        self.use("raw")
        ciphertext, nonce = sm.encrypt_key("user-a", "openai", "sk-secret")
        with open(os.path.join(_KEYDIR, "other"), "wb") as handle:
            handle.write(os.urandom(32))
        sm.LLM_KEK_FILE = os.path.join(_KEYDIR, "other")
        sm._kek.clear()
        with self.assertRaises(sm.ManagerError) as ctx:
            sm.decrypt_key("user-a", "openai", ciphertext, nonce)
        self.assertEqual(ctx.exception.code, "kek_unavailable")
        sm.LLM_KEK_FILE = os.path.join(_KEYDIR, "missing")
        sm._kek.clear()
        with self.assertRaises(sm.ManagerError) as ctx:
            sm.load_kek()
        self.assertEqual(ctx.exception.code, "kek_unavailable")

    def test_fingerprint_is_12_hex_of_sha256(self) -> None:
        import hashlib

        key = "sk-fingerprint-me"
        self.assertEqual(
            sm.key_fingerprint(key), hashlib.sha256(key.encode()).hexdigest()[:12]
        )
        self.assertEqual(len(sm.key_fingerprint(key)), 12)
        self.assertNotIn(key, sm.key_fingerprint(key))


class _Recorder(http.server.BaseHTTPRequestHandler):
    """The §5.6 upstream: records the Authorization header, serves the
    auth-checked GET endpoints (/v1/models default, /v1/key for entries whose
    /models is public)."""

    seen: list[tuple[str, str]] = []

    def log_message(self, fmt: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        _Recorder.seen.append((self.path, self.headers.get("Authorization") or ""))
        status = 200 if self.path in ("/v1/models", "/v1/key") else 404
        body = json.dumps({"data": [{"id": "e2e-fake-1"}]}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class BaseUrlTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dev_http, sm.PROVIDER_DEV_HTTP = sm.PROVIDER_DEV_HTTP, False

    def tearDown(self) -> None:
        sm.PROVIDER_DEV_HTTP = self._dev_http

    def assert_code(self, code: str, fn, *args: object) -> None:
        with self.assertRaises(sm.ManagerError) as ctx:
            fn(*args)
        self.assertEqual(ctx.exception.code, code)

    def test_scheme_and_shape_rules(self) -> None:
        self.assert_code("invalid_base_url", sm.check_custom_base_url, "http://127.0.0.1:9/v1")
        self.assert_code("invalid_base_url", sm.check_custom_base_url, "ftp://127.0.0.1:9/v1")
        self.assert_code("invalid_base_url", sm.check_custom_base_url, "https://" + "a" * 2100)
        self.assert_code("invalid_base_url", sm.check_custom_base_url, "https://user:pass@127.0.0.1:9/v1")
        self.assert_code("invalid_base_url", sm.check_custom_base_url, "https://127.0.0.1:9/v1?x=1")
        sm.PROVIDER_DEV_HTTP = True
        # Dev flag passes the http scheme (§5.1); this run may be offline
        # (network none), so the outcome is either the pass-through or the
        # DNS failure — never the scheme rejection.
        try:
            sm.check_custom_base_url("http://api.example.com/v1")
        except sm.ManagerError as exc:
            self.assertEqual(exc.code, "invalid_base_url")
            self.assertIn("resolve", str(exc))

    def test_dev_http_allows_the_scheme_not_private_networks(self) -> None:
        # DNS-free proof that the dev flag passes the http scheme: 127.0.0.1
        # resolves (literal), is not global, so the failure is the private-network
        # rule — i.e. the scheme check let it through.
        sm.PROVIDER_DEV_HTTP = True
        with self.assertRaises(sm.ManagerError) as ctx:
            sm.check_custom_base_url("http://127.0.0.1:9/v1")
        self.assertIn("private or docker network", str(ctx.exception))

    def test_private_answers_rejected(self) -> None:
        # localhost resolves to loopback; docker/RFC1918 answers are is_global == False.
        self.assert_code("invalid_base_url", sm.check_custom_base_url, "https://localhost/v1")
        self.assert_code("invalid_base_url", sm.check_custom_base_url, "https://127.0.0.1/v1")
        self.assert_code("invalid_base_url", sm.check_custom_base_url, "https://192.168.1.10/v1")

    def test_validation_dials_the_resolved_address(self) -> None:
        # §5.6: resolve once, check, then connect to the verified address with
        # the hostname in Host. A pinned (operator-supplied) URL may be local;
        # the key must arrive as a Bearer header exactly once.
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            sm.PROVIDER_DEV_HTTP = True
            base_url = f"http://127.0.0.1:{port}/v1"
            sm.validate_upstream(base_url, "sk-validate-me", require_public=False)
            self.assertEqual(_Recorder.seen[-1], ("/v1/models", "Bearer sk-validate-me"))
            self.assert_code(
                "invalid_key", sm.validate_upstream, base_url + "/nope", "sk-x", False
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_validation_uses_the_catalog_validate_path(self) -> None:
        # §5.6: openrouter's /models is public (any key answers 200), so its
        # catalog entry pins /key; the check must dial that suffix, not /models.
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            sm.PROVIDER_DEV_HTTP = True
            base_url = f"http://127.0.0.1:{server.server_address[1]}/v1"
            sm.validate_upstream(base_url, "sk-or-v1-x", require_public=False, path_suffix="/key")
            self.assertEqual(_Recorder.seen[-1], ("/v1/key", "Bearer sk-or-v1-x"))
            # The suffix comes from the operator-built catalog, but the request
            # line is built by concatenation: anything that is not a plain path
            # (CRLF injection, traversal, relative, empty) fails closed pre-dial.
            for bad in ("/a\r\nHost: x", "/../key", "key", "", "/a?x=1"):
                with self.subTest(bad=bad):
                    with self.assertRaises(sm.ManagerError) as ctx:
                        sm.validate_upstream(base_url, "sk-x", require_public=False, path_suffix=bad)
                    self.assertEqual(ctx.exception.code, "invalid_catalog")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_validation_public_required_for_user_urls(self) -> None:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            sm.PROVIDER_DEV_HTTP = True
            self.assert_code(
                "invalid_base_url",
                sm.validate_upstream,
                f"http://localhost:{server.server_address[1]}/v1",
                "sk-x",
                True,
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


class QuietDisconnectTest(unittest.TestCase):
    """ManagerHTTPServer answers routine peer resets with one INFO line
    instead of handle_error's traceback (the docker-logs spam); every other
    error keeps the stdlib traceback on stderr."""

    def test_peer_resets_demoted_real_errors_keep_traceback(self) -> None:
        server = sm.ManagerHTTPServer(("127.0.0.1", 0), _Recorder)
        captured_err = io.StringIO()
        stderr, sys.stderr = sys.stderr, captured_err
        try:
            with self.assertLogs("sandbox-manager", level="INFO") as captured:
                for exc_type in (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                    try:
                        raise exc_type()
                    except OSError:
                        server.handle_error(None, ("10.89.1.4", 49026))
            self.assertEqual(len(captured.output), 3)
            self.assertIn("closed the connection", captured.output[0])
            self.assertEqual(captured_err.getvalue(), "")
            try:
                raise ValueError("boom")
            except ValueError:
                server.handle_error(None, ("10.89.1.4", 49026))
            self.assertIn("Traceback", captured_err.getvalue())
            self.assertIn("boom", captured_err.getvalue())
        finally:
            sys.stderr = stderr
            server.server_close()


class TokenDefaultGuardTest(unittest.TestCase):
    """enforce_token_default fails closed on the well-known compose fallback
    (pentest W1): with it, any unprivileged local process reaches the
    manager's bridge IP and owns every tenant endpoint."""

    def setUp(self) -> None:
        self.saved = (os.environ.get("MANAGER_TOKEN"),
                      os.environ.get("MANAGER_ALLOW_DEFAULT_TOKEN"))
        os.environ.pop("MANAGER_ALLOW_DEFAULT_TOKEN", None)
        sm.MANAGER_ALLOW_DEFAULT_TOKEN = False

    def tearDown(self) -> None:
        token, allow = self.saved
        if token is None: os.environ.pop("MANAGER_TOKEN", None)
        else: os.environ["MANAGER_TOKEN"] = token
        if allow is None: os.environ.pop("MANAGER_ALLOW_DEFAULT_TOKEN", None)
        else: os.environ["MANAGER_ALLOW_DEFAULT_TOKEN"] = allow
        sm.MANAGER_ALLOW_DEFAULT_TOKEN = allow == "1"

    def reload_token(self) -> None:
        sm.MANAGER_TOKEN = os.environ.get("MANAGER_TOKEN")

    def test_default_token_is_fatal(self) -> None:
        os.environ["MANAGER_TOKEN"] = sm.KNOWN_DEFAULT_TOKEN
        self.reload_token()
        with self.assertRaises(SystemExit):
            sm.enforce_token_default()

    def test_empty_token_is_fatal(self) -> None:
        os.environ["MANAGER_TOKEN"] = ""
        self.reload_token()
        with self.assertRaises(SystemExit):
            sm.enforce_token_default()

    def test_random_token_passes(self) -> None:
        os.environ["MANAGER_TOKEN"] = "not-the-default-" + "x" * 24
        self.reload_token()
        sm.enforce_token_default()  # must not raise

    def test_explicit_opt_in_allows_the_default(self) -> None:
        os.environ["MANAGER_TOKEN"] = sm.KNOWN_DEFAULT_TOKEN
        os.environ["MANAGER_ALLOW_DEFAULT_TOKEN"] = "1"
        sm.MANAGER_ALLOW_DEFAULT_TOKEN = True
        self.reload_token()
        sm.enforce_token_default()  # must not raise


class RunscEnforcementTest(unittest.TestCase):
    """enforce_runsc_runtime fails closed at boot when the daemon cannot
    prove the runsc runtime. gVisor is mandatory: the sidecar delivery is
    cleartext HTTP on the per-user bridge, and under runc a compromised agent
    (root, default caps) can ARP-spoof the sidecar and capture the key — a
    boot warning would leave that one ARP poison away."""

    def setUp(self) -> None:
        self.saved = sm.docker

    def tearDown(self) -> None:
        sm.docker = self.saved

    def test_missing_runsc_refuses_to_start(self) -> None:
        sm.docker = lambda *a, **k: "io.containerd.runc.v2 runc "
        with self.assertLogs("sandbox-manager", level="CRITICAL") as captured:
            with self.assertRaises(SystemExit):
                sm.enforce_runsc_runtime()
        self.assertTrue(
            any("mandatory" in line for line in captured.output),
            captured.output,
        )

    def test_installed_runtime_starts_silently(self) -> None:
        sm.docker = lambda *a, **k: "runsc io.containerd.runc.v2 runc "
        with self.assertNoLogs("sandbox-manager", level="WARNING"):
            sm.enforce_runsc_runtime()

    def test_daemon_query_failure_refuses_to_start(self) -> None:
        def _boom(*a: str, **k: object) -> str:
            raise RuntimeError("docker info failed")

        sm.docker = _boom
        with self.assertLogs("sandbox-manager", level="CRITICAL"):
            with self.assertRaises(SystemExit):
                sm.enforce_runsc_runtime()


class CreateArgsTest(unittest.TestCase):
    """Agent containers are created --runtime runsc (gVisor): the isolation
    boundary is the userspace kernel, not just namespaces. runsc is a module
    constant, not an env knob — gVisor is mandatory (the key delivery to the
    sidecar is cleartext HTTP on the shared per-user bridge). Under runsc,
    Docker's embedded DNS is unreachable, so the control-plane guests are
    baked into /etc/hosts and AGENT_DNS covers internet names."""

    def setUp(self) -> None:
        self.saved = sm.AGENT_DNS

    def tearDown(self) -> None:
        sm.AGENT_DNS = self.saved

    def test_runtime_is_pinned_runsc(self) -> None:
        for args in (sm.create_args("user-runtime"), sm.sidecar_create_args("user-runtime")):
            self.assertIn("--runtime", args)
            self.assertEqual(args[args.index("--runtime") + 1], "runsc")
        self.assertEqual(sm.create_args("user-runtime")[-1], sm.AGENT_IMAGE)

    def test_create_args_shape(self) -> None:
        args = sm.create_args("user-runtime")
        name = sm.container_name("user-runtime")
        self.assertIn(name, args)
        for flag in ("--network", "--memory", "--cpus", "--runtime",
                     "--security-opt"):
            self.assertIn(flag, args)
        self.assertIn("no-new-privileges", args)

    def test_phase0_hardening_is_applied(self) -> None:
        # RFC 0013 §6.4: the seccomp deny list (P0.1), core=0 (P0.2) and
        # cap-drop ALL (P0.3: no AF_PACKET, no ARP spoofing of the per-user
        # bridge — under any runtime) are manager-enforced on every created
        # container, not host defaults.
        for args in (sm.create_args("user-hard"), sm.sidecar_create_args("user-hard")):
            self.assertIn(f"seccomp={sm.SECCOMP_PROFILE}", args)
            i = args.index("--ulimit")
            self.assertEqual(args[i + 1], "core=0")
            i = args.index("--cap-drop")
            self.assertEqual(args[i + 1], "ALL")

    def test_create_args_bakes_the_sidecar_url(self) -> None:
        args = sm.create_args("user-sc")
        env = [args[i + 1] for i, f in enumerate(args) if f == "-e"]
        self.assertIn(f"SIDECAR_URL=http://{sm.sidecar_name('user-sc')}:{sm.SIDECAR_PORT}", env)

    def test_create_args_forward_the_citation_judge_flag(self) -> None:
        # RFC 0017 §3 / RFC 0018 §5: the mode override reaches the agent only
        # through create args; unset means the agent default (enforce). The
        # judge model is resolved at runtime from the run's provider, so no
        # model path or backend ever travels here.
        saved = sm.AGENT_CITATION_JUDGE
        saved_budget = (
            sm.AGENT_CITATION_JUDGE_PAIR_TIMEOUT_MS,
            sm.AGENT_CITATION_JUDGE_CONCURRENCY,
            sm.AGENT_CITATION_JUDGE_RUN_BUDGET_MS,
        )
        try:
            sm.AGENT_CITATION_JUDGE = ""
            sm.AGENT_CITATION_JUDGE_PAIR_TIMEOUT_MS = ""
            sm.AGENT_CITATION_JUDGE_CONCURRENCY = ""
            sm.AGENT_CITATION_JUDGE_RUN_BUDGET_MS = ""
            args = sm.create_args("user-j")
            env = [args[i + 1] for i, f in enumerate(args) if f == "-e"]
            self.assertFalse(any(e.startswith("CITATION_JUDGE") for e in env))

            sm.AGENT_CITATION_JUDGE = "warn"
            args = sm.create_args("user-j")
            env = [args[i + 1] for i, f in enumerate(args) if f == "-e"]
            self.assertIn("CITATION_JUDGE=warn", env)
            self.assertFalse(any(e.startswith("CITATION_JUDGE_MODEL_DIR") for e in env))
            self.assertFalse(any(e.startswith("CITATION_JUDGE_BACKEND") for e in env))

            # RFC 0020 §4.3: the derived budget forwards verbatim when set, and
            # nothing travels when unset (the agent's own defaults apply).
            sm.AGENT_CITATION_JUDGE_PAIR_TIMEOUT_MS = "9000"
            sm.AGENT_CITATION_JUDGE_CONCURRENCY = "6"
            sm.AGENT_CITATION_JUDGE_RUN_BUDGET_MS = "45000"
            args = sm.create_args("user-j")
            env = [args[i + 1] for i, f in enumerate(args) if f == "-e"]
            self.assertIn("CITATION_JUDGE_PAIR_TIMEOUT_MS=9000", env)
            self.assertIn("CITATION_JUDGE_CONCURRENCY=6", env)
            self.assertIn("CITATION_JUDGE_RUN_BUDGET_MS=45000", env)
        finally:
            sm.AGENT_CITATION_JUDGE = saved
            (
                sm.AGENT_CITATION_JUDGE_PAIR_TIMEOUT_MS,
                sm.AGENT_CITATION_JUDGE_CONCURRENCY,
                sm.AGENT_CITATION_JUDGE_RUN_BUDGET_MS,
            ) = saved_budget

    def test_create_args_bakes_the_websearch_url(self) -> None:
        # RFC 0016 §5: the web tools resolve the node through this env; the
        # hostname is a baked /etc/hosts entry added at create time.
        args = sm.create_args("user-ws")
        env = [args[i + 1] for i, f in enumerate(args) if f == "-e"]
        self.assertIn(
            f"WEBSEARCH_URL=http://{sm.websearch_name('user-ws')}:{sm.WEBSEARCH_PORT}", env)

    def test_guest_hosts_are_baked_sorted_before_the_image(self) -> None:
        args = sm.create_args("user-runtime",
                              hosts={"caddy": "10.0.0.9", "sandbox-manager": "10.0.0.2"})
        flags = [args[i + 1] for i, f in enumerate(args) if f == "--add-host"]
        self.assertEqual(flags, ["caddy:10.0.0.9", "sandbox-manager:10.0.0.2"])
        self.assertLess(args.index("--add-host"), len(args) - 1)  # not after the image

    def test_dns_flag_follows_agent_dns(self) -> None:
        sm.AGENT_DNS = "9.9.9.9"
        args = sm.create_args("user-runtime")
        self.assertEqual(args[args.index("--dns") + 1], "9.9.9.9")
        sm.AGENT_DNS = ""  # empty: keep Docker's resolv.conf as-is
        args = sm.create_args("user-runtime")
        self.assertNotIn("--dns", args)


class SidecarCreateArgsTest(unittest.TestCase):
    """RFC 0013 §6.3/R10: the sidecar half of the pair — same network, no
    volumes, no published ports, own reduced caps, same runtime and Phase 0
    hardening, and the second entrypoint of the same agent image."""

    def test_sidecar_create_args_shape(self) -> None:
        user = "user-side"
        args = sm.sidecar_create_args(user)
        self.assertEqual(args[0], "create")
        self.assertIn(sm.sidecar_name(user), args)
        self.assertIn(sm.network_name(user), args)
        # Reduced caps, never the agent's (R10).
        self.assertEqual(args[args.index("--memory") + 1], sm.SIDECAR_MEMORY)
        self.assertNotEqual(sm.SIDECAR_MEMORY, sm.AGENT_MEMORY)
        self.assertEqual(args[args.index("--cpus") + 1], sm.SIDECAR_CPUS)
        # No volumes, no published ports: the key arrives via POST /config.
        self.assertNotIn("-v", args)
        self.assertNotIn("-p", args)
        env = [args[i + 1] for i, f in enumerate(args) if f == "-e"]
        self.assertIn(f"PORT={sm.SIDECAR_PORT}", env)
        # The sidecar carries no agent env: no workspace, no session db, no idle
        # clock, and no SIDECAR_URL of its own.
        for entry in env:
            for forbidden in ("WORKSPACE", "SESSION_DB", "AGENT_NAME", "IDLE_MS", "SIDECAR_URL"):
                self.assertFalse(entry.startswith(forbidden + "="), entry)
        # Same image, second entrypoint: the image and its command come last.
        self.assertEqual(args[-4], sm.AGENT_IMAGE)
        self.assertIn("node /app/sidecar.ts", args[-1])

    def test_sidecar_guests_baked_and_dns(self) -> None:
        args = sm.sidecar_create_args(
            "user-side", hosts={"e2e-fake-upstream": "10.0.0.9"})
        flags = [args[i + 1] for i, f in enumerate(args) if f == "--add-host"]
        self.assertIn("e2e-fake-upstream:10.0.0.9", flags)
        self.assertIn("--dns", args)


class DeliverySplitTest(unittest.TestCase):
    """RFC 0013 §6.3: the keyed half of a selection goes to the sidecar, the
    keyless half to the agent; mismatches re-deliver both; fail-closed codes
    (agent_image_old, egress_blocked) keep RFC 0012 §7's discipline. All
    docker/db/network touchpoints are stubbed: this tests the split logic."""

    KEY_ROW = {
        "fingerprint": "abc123def456",
        "base_url": "http://e2e-fake-upstream:8090/v1",
        "ciphertext": b"ct",
        "nonce": b"nonce",
    }

    def setUp(self) -> None:
        self.saved = {
            name: getattr(sm, name)
            for name in (
                "provider_selection_get", "provider_key_get", "agent_get",
                "sidecar_get", "agent_post", "sidecar_post", "catalog_entry",
                "decrypt_key", "AGENT_EGRESS",
            )
        }
        self.agent_status: dict = {}
        self.sidecar_status: dict = {}
        self.agent_posts: list = []
        self.sidecar_posts: list = []
        sm.provider_selection_get = lambda uid: {"provider": "e2e-fake", "model_id": "e2e-fake-1"}
        sm.provider_key_get = lambda uid, provider: dict(self.KEY_ROW)
        sm.agent_get = lambda c, p, timeout=5.0: self.agent_status
        sm.sidecar_get = lambda c, p, timeout=5.0: self.sidecar_status
        sm.agent_post = lambda c, p, payload, timeout=15.0: self.agent_posts.append(payload)
        sm.sidecar_post = lambda c, p, payload, timeout=15.0: self.sidecar_posts.append(payload)
        sm.catalog_entry = lambda provider: {"baseUrl": "https://api.example.com"}
        sm.decrypt_key = lambda uid, provider, ct, nonce: "sk-plaintext"
        sm.AGENT_EGRESS = "open"

    def tearDown(self) -> None:
        for name, value in self.saved.items():
            setattr(sm, name, value)

    def matched_statuses(self) -> None:
        self.sidecar_status = {
            "provider": "e2e-fake", "modelId": "e2e-fake-1",
            "keyFingerprint": self.KEY_ROW["fingerprint"],
            "upstream": self.KEY_ROW["base_url"],
        }
        self.agent_status = {
            "model": {"provider": "e2e-fake", "modelId": "e2e-fake-1"},
            "keyFingerprint": None, "keyVia": "sidecar",
        }

    def test_matching_pair_re_delivers_nothing(self) -> None:
        self.matched_statuses()
        sm.reconcile_provider("u", "agent-c", "agent-c-sidecar")
        self.assertEqual(self.agent_posts, [])
        self.assertEqual(self.sidecar_posts, [])

    def test_sidecar_lost_its_key_re_delivers_both_halves(self) -> None:
        self.matched_statuses()
        self.sidecar_status["keyFingerprint"] = None  # restarted: RAM key gone
        sm.reconcile_provider("u", "agent-c", "agent-c-sidecar")
        self.assertEqual(len(self.sidecar_posts), 1)
        side = self.sidecar_posts[0]
        self.assertEqual(side["apiKey"], "sk-plaintext")
        self.assertEqual(side["baseUrl"], self.KEY_ROW["base_url"])
        self.assertEqual(len(self.agent_posts), 1)
        agent = self.agent_posts[0]
        self.assertEqual(agent["viaSidecar"], True)
        self.assertNotIn("apiKey", agent)  # the split: no key in the agent payload
        self.assertEqual(agent["baseUrl"], self.KEY_ROW["base_url"])  # A3 compat

    def test_old_image_without_keyvia_fails_closed(self) -> None:
        self.matched_statuses()
        del self.agent_status["keyVia"]  # image from before RFC 0013
        with self.assertRaises(sm.ManagerError) as ctx:
            sm.reconcile_provider("u", "agent-c", "agent-c-sidecar")
        self.assertEqual(ctx.exception.code, "agent_image_old")
        self.assertEqual(self.sidecar_posts, [])

    def test_keyed_selection_with_egress_off_fails_closed(self) -> None:
        sm.AGENT_EGRESS = "off"
        self.matched_statuses()
        self.sidecar_status["keyFingerprint"] = None
        with self.assertRaises(sm.ManagerError) as ctx:
            sm.reconcile_provider("u", "agent-c", "agent-c-sidecar")
        self.assertEqual(ctx.exception.code, "egress_blocked")

    def test_faux_clearing_delivers_faux_to_both_halves(self) -> None:
        sm.provider_selection_get = lambda uid: None
        self.agent_status = {"model": {"provider": "e2e-fake", "modelId": "e2e-fake-1"}, "keyFingerprint": None, "keyVia": "sidecar"}
        self.sidecar_status = {"provider": "e2e-fake", "modelId": "e2e-fake-1", "keyFingerprint": "x", "upstream": "u"}
        sm.reconcile_provider("u", "agent-c", "agent-c-sidecar")
        self.assertEqual(self.agent_posts, [sm.FAUX_CONFIG])
        self.assertEqual(self.sidecar_posts, [sm.FAUX_CONFIG])

    def test_keyless_selection_stays_direct_and_never_touches_the_sidecar(self) -> None:
        sm.provider_selection_get = lambda uid: {"provider": "deepseek", "model_id": "m"}
        sm.provider_key_get = lambda uid, provider: None
        self.agent_status = {"model": {"provider": "faux", "modelId": "faux-1"}, "keyFingerprint": None, "keyVia": None}
        sm.reconcile_provider("u", "agent-c", "agent-c-sidecar")
        self.assertEqual(self.agent_posts, [{"provider": "deepseek", "modelId": "m"}])
        self.assertEqual(self.sidecar_posts, [])

    def test_catalog_upstream_is_pinned_from_the_entry(self) -> None:
        sm.provider_key_get = lambda uid, provider: {**self.KEY_ROW, "base_url": None}
        self.sidecar_status = {"provider": "deepseek", "modelId": "m", "keyFingerprint": "other", "upstream": None}
        self.agent_status = {"model": {"provider": "faux", "modelId": "faux-1"}, "keyVia": None}
        sm.reconcile_provider("u", "agent-c", "agent-c-sidecar")
        # delivered; and the match next time requires the entry's baseUrl
        self.assertTrue(self.sidecar_posts)


class WaitHealthySidecarTest(unittest.TestCase):
    """§8: an unanswerable sidecar fails the resolve closed with
    sidecar_unhealthy instead of routing an agent to a dead proxy."""

    def test_unreachable_sidecar_raises_sidecar_unhealthy(self) -> None:
        saved = (sm.READY_TIMEOUT_S, sm.sidecar_get)
        sm.READY_TIMEOUT_S = 0.2
        sm.sidecar_get = lambda c, p, timeout=3.0: (_ for _ in ()).throw(ConnectionError("dead"))
        try:
            with self.assertRaises(sm.ManagerError) as ctx:
                sm.wait_healthy_sidecar("side-c")
            self.assertEqual(ctx.exception.code, "sidecar_unhealthy")
        finally:
            sm.READY_TIMEOUT_S, sm.sidecar_get = saved


class WebsearchCreateArgsTest(unittest.TestCase):
    """RFC 0016 §4: the per-user web-search node — same network as the sandbox,
    no volumes, no published ports, own reduced caps, Phase 0 hardening, and the
    two callers it is allowed to answer (its own subnet) plus the baked search
    service hosts it dials."""

    def test_websearch_create_args_shape(self) -> None:
        user = "user-web"
        args = sm.websearch_create_args(
            user, hosts={"searxng": "10.0.0.8"}, peers=["10.42.0.0/16"])
        self.assertEqual(args[0], "create")
        self.assertIn(sm.websearch_name(user), args)
        self.assertIn(sm.network_name(user), args)
        # Own reduced caps, never the agent's.
        self.assertEqual(args[args.index("--memory") + 1], sm.WEBSEARCH_MEMORY)
        self.assertEqual(args[args.index("--cpus") + 1], sm.WEBSEARCH_CPUS)
        self.assertNotEqual(sm.WEBSEARCH_MEMORY, sm.AGENT_MEMORY)
        # No writable volume, no published port: a fetched page has nowhere to go.
        self.assertNotIn("-v", args)
        self.assertNotIn("-p", args)
        env = [args[i + 1] for i, f in enumerate(args) if f == "-e"]
        self.assertIn(f"PORT={sm.WEBSEARCH_PORT}", env)
        self.assertIn("WEBSEARCH_PEERS=10.42.0.0/16", env)
        self.assertIn(f"SEARXNG_URL={sm.SEARXNG_URL}", env)
        self.assertIn(f"CAMOFOX_URL={sm.CAMOFOX_URL}", env)
        self.assertIn(f"WEBSEARCH_USER={sm.slug(user)}", env)
        for entry in env:
            for forbidden in ("WORKSPACE", "SESSION_DB", "AGENT_NAME", "IDLE_MS",
                              "SIDECAR_URL", "WEBSEARCH_URL"):
                self.assertFalse(entry.startswith(forbidden + "="), entry)
        # Phase 0 hardening and gVisor, like every container this manager creates.
        self.assertIn(f"seccomp={sm.SECCOMP_PROFILE}", args)
        self.assertEqual(args[args.index("--ulimit") + 1], "core=0")
        self.assertEqual(args[args.index("--cap-drop") + 1], "ALL")
        self.assertEqual(args[args.index("--runtime") + 1], "runsc")
        # The search services are baked hosts (no embedded DNS under runsc) and
        # no internet resolver is configured.
        flags = [args[i + 1] for i, f in enumerate(args) if f == "--add-host"]
        self.assertEqual(flags, ["searxng:10.0.0.8"])
        self.assertNotIn("--dns", args)
        # Same image, third entrypoint: the image and its command come last.
        self.assertEqual(args[-4], sm.AGENT_IMAGE)
        self.assertIn("node /app/websearch.ts", args[-1])

    def test_camofox_key_is_optional_and_never_a_volume(self) -> None:
        saved = sm.CAMOFOX_API_KEY
        try:
            sm.CAMOFOX_API_KEY = ""
            self.assertNotIn("CAMOFOX_API_KEY",
                             " ".join(sm.websearch_create_args("u-web-key")))
            sm.CAMOFOX_API_KEY = "shared-key"
            args = sm.websearch_create_args("u-web-key")
            env = [args[i + 1] for i, f in enumerate(args) if f == "-e"]
            self.assertIn("CAMOFOX_API_KEY=shared-key", env)
            self.assertNotIn("-v", args)
        finally:
            sm.CAMOFOX_API_KEY = saved


class WebsearchNetworkTest(unittest.TestCase):
    """RFC 0016 §4: websearch-in is internal (no egress in the node), the
    operator's services own websearch-out. An existing non-internal
    websearch-in fails closed instead of weakening the containment claim."""

    def setUp(self) -> None:
        self.saved = {name: getattr(sm, name) for name in
                      ("docker", "network_exists", "invalidate_peer_cache")}
        self.created: list[tuple] = []

    def tearDown(self) -> None:
        for name, value in self.saved.items():
            setattr(sm, name, value)

    def fake_docker(self, *args: str, **kwargs: object) -> str:
        if "inspect" in args:
            return "true"
        self.created.append(args)
        return ""

    def test_creates_internal_in_and_bridge_out(self) -> None:
        sm.docker = self.fake_docker
        sm.network_exists = lambda name: False
        sm.invalidate_peer_cache = lambda: None
        sm.ensure_websearch_networks()
        by_name = {args[-1]: args for args in self.created}
        self.assertIn(sm.WEBSEARCH_IN, by_name)
        self.assertIn("--internal", by_name[sm.WEBSEARCH_IN])
        self.assertNotIn("--internal", by_name[sm.WEBSEARCH_OUT])

    def test_existing_networks_are_not_recreated(self) -> None:
        sm.docker = self.fake_docker
        sm.network_exists = lambda name: True
        sm.ensure_websearch_networks()
        self.assertEqual(self.created, [])

    def test_non_internal_websearch_in_fails_closed(self) -> None:
        sm.network_exists = lambda name: True
        sm.docker = lambda *args, **kwargs: "false"
        with self.assertRaises(RuntimeError):
            sm.ensure_websearch_networks()


class WebsearchHealthTest(unittest.TestCase):
    def test_unreachable_node_times_out(self) -> None:
        saved = (sm.READY_TIMEOUT_S, sm.websearch_get)
        sm.READY_TIMEOUT_S = 0.2
        sm.websearch_get = lambda c, p, timeout=3.0: (_ for _ in ()).throw(ConnectionError("dead"))
        try:
            with self.assertRaises(TimeoutError):
                sm.wait_healthy_websearch("web-c")
        finally:
            sm.READY_TIMEOUT_S, sm.websearch_get = saved


class WebsearchAuthorisationTest(unittest.TestCase):
    """RFC 0016 §7: the per-user control token that makes a run registration
    unforgeable by a bash child, derived from MANAGER_TOKEN and delivered to
    both the node and the agent on every resolve."""

    def setUp(self) -> None:
        self.saved = (sm.MANAGER_TOKEN, sm.websearch_post, sm.agent_post)
        sm.MANAGER_TOKEN = "manager-secret-for-tests"

    def tearDown(self) -> None:
        sm.MANAGER_TOKEN, sm.websearch_post, sm.agent_post = self.saved

    def test_control_token_is_stable_per_user_and_distinct_across_users(self) -> None:
        first = sm.websearch_control_token("user-a")
        self.assertEqual(len(first), 64)
        self.assertTrue(all(c in "0123456789abcdef" for c in first))
        self.assertEqual(first, sm.websearch_control_token("user-a"))
        self.assertNotEqual(first, sm.websearch_control_token("user-b"))

    def test_delivery_posts_the_same_token_to_node_and_agent(self) -> None:
        node_posts: list = []
        agent_posts: list = []
        sm.websearch_post = lambda c, p, payload, timeout=5.0: node_posts.append((p, payload))
        sm.agent_post = lambda c, p, payload, timeout=15.0: agent_posts.append((p, payload))
        sm.deliver_websearch_control("user-a", "node-a", "agent-a")
        self.assertEqual(node_posts[0][0], "/control")
        self.assertEqual(agent_posts[0][0], "/webconfig")
        self.assertEqual(
            node_posts[0][1]["token"], agent_posts[0][1]["controlToken"])

    def test_missing_manager_token_fails_closed(self) -> None:
        sm.MANAGER_TOKEN = None
        with self.assertRaises(sm.ManagerError) as ctx:
            sm.websearch_control_token("user-a")
        self.assertEqual(ctx.exception.code, "token_unavailable")

    def test_delivery_is_fail_soft_when_the_node_is_down(self) -> None:
        sm.websearch_post = lambda *args, **kwargs: (_ for _ in ()).throw(
            sm.ManagerError("delivery_failed", "node down"))
        sm.agent_post = lambda *args, **kwargs: None
        # No raise: chat and uploads must keep working without the node.
        sm.deliver_websearch_control("user-a", "node-a", "agent-a")


class IdentityCryptoTest(unittest.TestCase):
    """RFC 0023 §4: the password hash and the sealed cookie are better-auth's
    formats, golden-vectored cross-language. A drift here silently breaks
    every account the manager creates."""

    GOLDEN_HASH = (
        "00112233445566778899aabbccddeeff:"
        "f5b22309b28fe412c82a4b2cab57498b8f8a42c849af16cb908974048f61c139"
        "33421858db3a8f111430bdc493c7cef90f61f904061c77206e3820a2e8b11bc2"
    )
    GOLDEN_COOKIE = (
        "better-auth.session_token=TOKENaaaaaaaaaaaaaaaaaaaaaaaaaaaa."
        "Xq2d1kPZRjP0gBzmdZjnv64vU89%2F1WahS6ao%2FekCtfU%3D"
    )

    def setUp(self) -> None:
        self.saved = (sm.ORIGIN, sm.IDENTITY_API_KEY, sm.IDENTITY_API_KEY_PREVIOUS)
        sm.ORIGIN = "http://localhost:5174"

    def tearDown(self) -> None:
        sm.ORIGIN, sm.IDENTITY_API_KEY, sm.IDENTITY_API_KEY_PREVIOUS = self.saved

    def test_golden_scrypt_hash_and_verification(self) -> None:
        self.assertEqual(
            sm.hash_password("correct horse battery staple", "00112233445566778899aabbccddeeff"),
            self.GOLDEN_HASH,
        )
        self.assertTrue(sm.verify_password(self.GOLDEN_HASH, "correct horse battery staple"))
        self.assertFalse(sm.verify_password(self.GOLDEN_HASH, "wrong"))
        self.assertFalse(sm.verify_password("not-a-hash", "correct horse battery staple"))

    def test_password_is_normalized_nfkc_before_hashing(self) -> None:
        # U+FB01 LATIN SMALL LIGATURE FI normalizes to "fi" in both runtimes.
        self.assertEqual(
            sm.hash_password("ﬁ", "00112233445566778899aabbccddeeff"),
            sm.hash_password("fi", "00112233445566778899aabbccddeeff"),
        )

    def test_golden_signed_cookie(self) -> None:
        self.assertEqual(
            sm.sealed_cookie("TOKENaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "test-secret-0123456789abcdef"),
            self.GOLDEN_COOKIE,
        )

    def test_cookie_name_follows_origin_scheme(self) -> None:
        sm.ORIGIN = "https://affido.example"
        self.assertTrue(sm.sealed_cookie("t", "s").startswith("__Secure-better-auth.session_token="))

    def test_key_rotation_accepts_both_and_ignores_short_values(self) -> None:
        sm.IDENTITY_API_KEY = "a" * 32
        sm.IDENTITY_API_KEY_PREVIOUS = "b" * 32
        self.assertTrue(sm.identity_key_ok("a" * 32))
        self.assertTrue(sm.identity_key_ok("b" * 32))
        self.assertFalse(sm.identity_key_ok("c" * 32))
        self.assertFalse(sm.identity_key_ok("é" * 32))  # non-ASCII -> 401, not 500
        sm.IDENTITY_API_KEY = "too-short"
        sm.IDENTITY_API_KEY_PREVIOUS = ""
        self.assertEqual(sm.identity_keys(), ())
        self.assertFalse(sm.identity_key_ok("too-short"))

    def test_email_is_lowercased_and_validated(self) -> None:
        self.assertEqual(sm.identity_email("  Elena@Example.COM "), "elena@example.com")
        for bad in (None, "", "nope", "a@b", "a b@c.d", 42):
            with self.subTest(bad=bad):
                with self.assertRaises(sm.ManagerError) as ctx:
                    sm.identity_email(bad)
                self.assertEqual(ctx.exception.code, "invalid_input")


class IdentitySurfaceHttpTest(unittest.TestCase):
    """RFC 0023 §5-§6: the HTTP contract of the identity routes. The DB write
    functions are stubbed; the e2e suite exercises the real rows. What is
    tested here is the gate order (Origin, key, configuration, rate), the
    405/JSON/no-store answers a doctor relies on, and the response shapes."""

    KEY = "k" * 40

    def setUp(self) -> None:
        names = (
            "IDENTITY_API_KEY", "IDENTITY_API_KEY_PREVIOUS", "BETTER_AUTH_SECRET",
            "ORIGIN", "IDENTITY_LOGIN_PER_MINUTE", "IDENTITY_REGISTER_PER_HOUR",
            "identity_register", "identity_login", "identity_logout",
            "session_identity", "is_sandbox_peer",
        )
        self.saved = {name: getattr(sm, name) for name in names}
        sm.IDENTITY_API_KEY = self.KEY
        sm.IDENTITY_API_KEY_PREVIOUS = ""
        sm.BETTER_AUTH_SECRET = "test-secret-0123456789abcdef"
        sm.ORIGIN = "http://localhost:5174"
        sm.IDENTITY_LOGIN_PER_MINUTE = 2
        sm.IDENTITY_REGISTER_PER_HOUR = 2
        sm.is_sandbox_peer = lambda peer: False
        sm._identity_windows.reset()
        self.calls: list[tuple] = []

        def fake_register(email: str, password: str, name: str, ip: str, ua: str) -> dict:
            self.calls.append(("register", email, password, name, ip, ua))
            return sm.identity_result("u1", email, name, "tok")

        def fake_login(email: str, password: str, ip: str, ua: str) -> dict:
            self.calls.append(("login", email, password, ip, ua))
            if password != "correct horse battery staple":
                raise sm.ManagerError("invalid_credentials", "email or password is incorrect", 401)
            return sm.identity_result("u1", email, "Elena", "tok")

        def fake_logout(handler: object) -> None:
            self.calls.append(("logout",))

        def fake_identity(handler: object) -> dict | None:
            cookie = handler.headers.get("Cookie") or ""
            if "session=good" in cookie:
                return {"user_id": "u1", "email": "elena@example.com", "name": "Elena"}
            if "session=orphan" in cookie:
                return {"user_id": "u2", "email": None, "name": None}
            return None

        sm.identity_register = fake_register
        sm.identity_login = fake_login
        sm.identity_logout = fake_logout
        sm.session_identity = fake_identity
        self.server = sm.ManagerHTTPServer(("127.0.0.1", 0), sm.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        for name, value in self.saved.items():
            setattr(sm, name, value)
        sm._identity_windows.reset()

    def request(
        self, method: str, path: str, body: object | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        conn = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_address[1], timeout=10
        )
        payload = None if body is None else json.dumps(body).encode()
        hdrs = {"Content-Type": "application/json", **(headers or {})}
        conn.request(method, path, body=payload, headers=hdrs)
        response = conn.getresponse()
        data = response.read()
        result = (response.status, dict(response.getheaders()), data)
        conn.close()
        return result

    def json(self, data: bytes) -> dict:
        return json.loads(data or b"{}")

    def test_get_on_the_three_routes_is_405_json_no_store(self) -> None:
        for path in ("/identity/register", "/identity/login", "/identity/logout"):
            with self.subTest(path=path):
                status, headers, data = self.request("GET", path)
                self.assertEqual(status, 405)
                self.assertEqual(headers.get("Allow"), "POST")
                self.assertEqual(headers.get("Cache-Control"), "no-store")
                self.assertEqual(self.json(data)["code"], "method_not_allowed")

    def test_unknown_identity_path_is_404_and_errors_are_no_store(self) -> None:
        status, headers, data = self.request("POST", "/identity/nope", body={})
        self.assertEqual(status, 404)
        self.assertEqual(headers.get("Cache-Control"), "no-store")

    def test_wrong_key_and_origin_write_nothing(self) -> None:
        status, _, data = self.request(
            "POST", "/identity/register",
            body={"email": "a@b.co", "password": "password1", "name": "A"},
            headers={"X-Identity-Key": "wrong"},
        )
        self.assertEqual(status, 401)
        self.assertEqual(self.json(data)["code"], "unauthorized")
        status, _, data = self.request(
            "POST", "/identity/register",
            body={"email": "a@b.co", "password": "password1", "name": "A"},
            headers={"X-Identity-Key": self.KEY, "Origin": "http://localhost:5174"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(self.json(data)["code"], "forbidden_origin")
        self.assertEqual(self.calls, [])

    def test_register_login_logout_contract(self) -> None:
        status, headers, data = self.request(
            "POST", "/identity/register",
            body={"email": " Elena@Example.COM ", "password": "correct horse battery staple", "name": " Elena "},
            headers={"X-Identity-Key": self.KEY},
        )
        self.assertEqual(status, 201)
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        body = self.json(data)
        self.assertEqual(body["user"], {"id": "u1", "email": "elena@example.com", "name": "Elena"})
        self.assertTrue(body["session"]["cookie"].startswith("better-auth.session_token="))
        self.assertEqual(self.calls[0][1:4], ("elena@example.com", "correct horse battery staple", "Elena"))

        status, _, data = self.request(
            "POST", "/identity/login",
            body={"email": "elena@example.com", "password": "correct horse battery staple"},
            headers={"X-Identity-Key": self.KEY},
        )
        self.assertEqual(status, 200)
        self.assertTrue(self.json(data)["session"]["cookie"])

        status, headers, data = self.request(
            "POST", "/identity/logout", body={},
            headers={"X-Identity-Key": self.KEY, "Cookie": "better-auth.session_token=tok.sig"},
        )
        self.assertEqual(status, 204)
        self.assertEqual(data, b"")
        self.assertEqual(headers.get("Cache-Control"), "no-store")

    def test_invalid_input_and_bad_credentials(self) -> None:
        status, _, data = self.request(
            "POST", "/identity/register",
            body={"email": "elena@example.com", "password": "short", "name": "Elena"},
            headers={"X-Identity-Key": self.KEY},
        )
        self.assertEqual(status, 400)
        self.assertEqual(self.json(data)["code"], "invalid_input")
        status, _, data = self.request(
            "POST", "/identity/login",
            body={"email": "elena@example.com", "password": "not-the-password"},
            headers={"X-Identity-Key": self.KEY},
        )
        self.assertEqual(status, 401)
        self.assertEqual(self.json(data)["code"], "invalid_credentials")

    def test_oversized_body_is_400_and_closes(self) -> None:
        status, headers, data = self.request(
            "POST", "/identity/register",
            body={"email": "x" * 20000, "password": "password12", "name": "A"},
            headers={"X-Identity-Key": self.KEY},
        )
        self.assertEqual(status, 400)
        self.assertEqual(headers.get("Connection"), "close")
        self.assertEqual(self.json(data)["code"], "invalid_input")
        self.assertEqual(self.calls, [])

    def test_missing_secret_answers_identity_unavailable(self) -> None:
        sm.BETTER_AUTH_SECRET = ""
        status, _, data = self.request(
            "POST", "/identity/login",
            body={"email": "elena@example.com", "password": "password12"},
            headers={"X-Identity-Key": self.KEY},
        )
        self.assertEqual(status, 503)
        self.assertEqual(self.json(data)["code"], "identity_unavailable")

    def test_rate_limit_is_per_route_and_ip(self) -> None:
        body = {"email": "elena@example.com", "password": "not-the-password"}
        for _ in range(2):
            status, _, _ = self.request(
                "POST", "/identity/login", body=body,
                headers={"X-Identity-Key": self.KEY},
            )
            self.assertEqual(status, 401)
        status, headers, data = self.request(
            "POST", "/identity/login", body=body,
            headers={"X-Identity-Key": self.KEY},
        )
        self.assertEqual(status, 429)
        self.assertEqual(self.json(data)["code"], "rate_limited")
        self.assertIn("Retry-After", headers)

    def test_whoami_adds_email_and_name_and_is_no_store(self) -> None:
        status, headers, data = self.request(
            "GET", "/whoami", headers={"Cookie": "session=good"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        self.assertEqual(
            self.json(data),
            {"user_id": "u1", "email": "elena@example.com", "name": "Elena"},
        )
        status, headers, data = self.request("GET", "/whoami")
        self.assertEqual(status, 401)
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        # A session row without a user row keeps working (e2e seeds them).
        status, _, data = self.request("GET", "/whoami", headers={"Cookie": "session=orphan"})
        self.assertEqual(status, 200)
        self.assertEqual(self.json(data), {"user_id": "u2"})

    def test_client_ip_uses_the_last_forwarded_hop(self) -> None:
        class Fake:
            client_address = ("10.0.0.5", 1234)
            headers = {"X-Forwarded-For": "203.0.113.9, 198.51.100.7"}

        self.assertEqual(sm.client_ip(Fake()), "198.51.100.7")  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
