// The classification only fires on the sidecar's two codes: a generic
// model_error (bad key, quota, overflow) must stay unclassified, because the
// UI falls back to the raw settlement detail for those.

import assert from "node:assert/strict";
import test from "node:test";
import { classifyProviderFailure } from "./upstream-failure.ts";

test("a sidecar 502 becomes provider_unreachable with the transport reason", () => {
	const detail =
		'502: {"error":"upstream_unreachable","reason":"dns_failure","message":"pinned upstream did not answer: fetch failed"}';
	assert.deepEqual(classifyProviderFailure(detail, "deepseek"), {
		kind: "provider_unreachable",
		provider: "deepseek",
		reason: "dns_failure",
	});
});

test("a sidecar 504 becomes provider_timeout", () => {
	const detail =
		'504: {"error":"upstream_timeout","reason":"no_response","message":"the pinned upstream sent no response headers within 30s"}';
	assert.deepEqual(classifyProviderFailure(detail, "custom"), {
		kind: "provider_timeout",
		provider: "custom",
		reason: "no_response",
	});
});

test("the reason survives reordered fields and a missing reason is null", () => {
	assert.deepEqual(
		classifyProviderFailure(
			'502: {"error":"upstream_unreachable","message":"x","reason":"tls_failure"}',
			"openai",
		),
		{ kind: "provider_unreachable", provider: "openai", reason: "tls_failure" },
	);
	assert.deepEqual(
		classifyProviderFailure('502: {"error":"upstream_unreachable","message":"x"}', "openai"),
		{ kind: "provider_unreachable", provider: "openai", reason: null },
	);
});

test("other model errors stay unclassified", () => {
	// The provider's own error text may contain the word timeout; only the
	// sidecar's error code is a transport classification.
	assert.equal(classifyProviderFailure("401: Incorrect API key provided", "openai"), null);
	assert.equal(classifyProviderFailure("timeout: provider overloaded", "openai"), null);
	assert.equal(classifyProviderFailure(null, "openai"), null);
});
