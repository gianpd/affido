"""Unit tests of the BYOK pieces that need no database and no docker socket:
the KEK scheme (RFC 0012 §5.2 / RFC 0004 §4.7), the fingerprint, and the
custom-baseUrl rules with the TOCTOU-safe validation client (§5.1, §5.6).

Run inside the manager image (verify.sh):
  docker compose run --rm --no-deps --network none --entrypoint python3 \
      sandbox-manager -m unittest test_sandbox_manager
"""

from __future__ import annotations

import base64
import http.server
import json
import os
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
    """The §5.6 upstream: records the Authorization header, serves /v1/models."""

    seen: list[tuple[str, str]] = []

    def log_message(self, fmt: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        _Recorder.seen.append((self.path, self.headers.get("Authorization") or ""))
        status = 200 if self.path == "/v1/models" else 404
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
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
