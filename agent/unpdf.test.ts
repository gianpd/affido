// Guards for the second baked runtime library (RFC 0009 D3): `unpdf`, the
// PDF text-extraction toolbox the model reaches through NODE_PATH. The
// package bundles a serverless build of Mozilla's PDF.js, so the security
// surface we actually ship is that engine. Two invariants:
//
// 1. The bundled PDF.js version is pinned by assertion. unpdf has zero
//    transitive dependencies, so a pin bump changes exactly one engine —
//    this test is the deliberate review point for that change. The floor
//    that matters historically is 4.2.67 (CVE-2024-4367, arbitrary JS
//    execution from a malicious PDF; fixed there and absent from this
//    serverless build, which contains no eval/new Function at all).
// 2. The bundle actually runs on this Node major and extracts text, so an
//    engine upgrade that breaks serverless compatibility fails here, not
//    inside a user's sandbox at prompt time.

import assert from "node:assert/strict";
import test from "node:test";
import { extractText, getDocumentProxy, getResolvedPDFJS } from "unpdf";

/** The PDF.js version bundled by the pinned unpdf. Bump on a deliberate upgrade. */
const BUNDLED_PDFJS_VERSION = "6.4.299";

test("unpdf bundles exactly the reviewed PDF.js version", async () => {
	const { version } = await getResolvedPDFJS();
	assert.equal(version, BUNDLED_PDFJS_VERSION);
});

test("the bundled PDF.js engine is above the CVE-2024-4367 fix floor", async () => {
	const { version } = await getResolvedPDFJS();
	const [major = 0, minor = 0] = version.split(".").map(Number);
	assert.ok(major > 4 || (major === 4 && minor >= 2), `PDF.js ${version} is below 4.2.67`);
});

test("extractText reads text out of a minimal PDF", async () => {
	// Smallest PDF.js-compatible one-page PDF: Helvetica text at a fixed position.
	const pdf = Buffer.from(
		"%PDF-1.4\n" +
			"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
			"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
			"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R" +
			"/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
			"4 0 obj<</Length 59>>stream\nBT /F1 24 Tf 72 720 Td (Hello Affido) Tj ET\nendstream endobj\n" +
			"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
			"trailer<</Root 1 0 R>>",
		"latin1",
	);
	const proxy = await getDocumentProxy(new Uint8Array(pdf));
	const { text, totalPages } = await extractText(proxy, { mergePages: true });
	assert.equal(totalPages, 1);
	assert.equal(text.trim(), "Hello Affido");
});
