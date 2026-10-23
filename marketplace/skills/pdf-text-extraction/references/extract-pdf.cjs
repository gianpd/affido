#!/usr/bin/env node
// Extract text from one PDF through the preinstalled unpdf (PDF.js engine).
//
// Run it with a PLAIN `node` invocation from any directory:
//
//   node extract-pdf.cjs <file.pdf>               "PAGES <n>" + merged text
//   node extract-pdf.cjs <file.pdf> --pages 2-4   merged text of pages 2..4 only
//   node extract-pdf.cjs <file.pdf> --json        { totalPages, pages: [...] }
//   node extract-pdf.cjs <file.pdf> --items       positioned items (JSON)
//   node extract-pdf.cjs <file.pdf> --meta        document metadata (JSON)
//
// NODE_PATH is already /app/node_modules in this container. Do not set or
// override it, and do not convert this to ESM `import`: ESM resolution
// ignores NODE_PATH and the import will fail with ERR_MODULE_NOT_FOUND.

"use strict";

const fs = require("node:fs");
const { extractText, extractTextItems, getDocumentProxy, getMeta } = require("unpdf");

// Bounds for untrusted input: parsing runs on this event loop (serverless
// build, no worker), so input size, page fan-out, and time are all capped.
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_PAGES = 1000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024; // PDF.js maxImageSize (~16 MP)
const TIMEOUT_MS = 120_000;

const usage = () => {
	console.error("usage: node extract-pdf.cjs <file.pdf> [--pages a[-b]|n,n] [--json] [--items] [--meta]");
	process.exit(2);
};

const parsePages = (value, totalPages) => {
	const wanted = [];
	for (const part of value.split(",")) {
		const range = /^(\d+)(?:-(\d+))?$/.exec(part);
		if (range === null) usage();
		const first = Number(range[1]);
		const last = range[2] === undefined ? first : Number(range[2]);
		if (first < 1 || last < first || last > totalPages) usage();
		for (let page = first; page <= last; page += 1) wanted.push(page);
	}
	return wanted;
};

const die = (message) => {
	console.error(`extract-pdf: ${message}`);
	process.exit(1);
};

const withTimeout = async (label, promise) => {
	const timer = setTimeout(() => die(`${label} exceeded ${TIMEOUT_MS} ms`), TIMEOUT_MS);
	timer.unref(); // armed but never the reason the process stays up
	try {
		return await promise;
	} finally {
		clearTimeout(timer);
	}
};

const main = async () => {
	const flags = process.argv.slice(2);
	const file = flags.find((arg) => !arg.startsWith("--"));
	if (file === undefined || flags.includes("--help")) usage();
	const wantJson = flags.includes("--json");
	const wantItems = flags.includes("--items");
	const wantMeta = flags.includes("--meta");
	const pagesFlag = /^--pages=(.*)$/.exec(flags.find((arg) => arg.startsWith("--pages=")) ?? "");
	const pagesValue = pagesFlag === null ? undefined : pagesFlag[1];

	const stats = fs.statSync(file, { throwIfNoEntry: false });
	if (stats === undefined) die(`no such file: ${file}`);
	if (!stats.isFile()) die(`not a file: ${file}`);
	if (stats.size > MAX_INPUT_BYTES) die(`file is ${stats.size} bytes, over the ${MAX_INPUT_BYTES} cap`);

	const bytes = fs.readFileSync(file);
	let pdf;
	try {
		pdf = await withTimeout("opening", getDocumentProxy(new Uint8Array(bytes), { maxImageSize: MAX_IMAGE_BYTES }));
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		const detail = error instanceof Error ? error.message : String(error);
		die(name === "PasswordException" ? `encrypted PDF (${detail}); password-protected files are not supported` : `cannot open (${detail})`);
	}
	if (pdf.numPages > MAX_PAGES) die(`${pdf.numPages} pages, over the ${MAX_PAGES} cap`);

	if (wantMeta) {
		const { info, metadata } = await withTimeout("metadata", getMeta(pdf, { parseDates: true }));
		console.log(JSON.stringify({ file, info, metadata }, null, 2));
		return;
	}
	if (wantItems) {
		const { totalPages, items } = await withTimeout("items", extractTextItems(pdf));
		console.log(JSON.stringify({ file, totalPages, items }, null, 2));
		return;
	}

	const { totalPages, text } = await withTimeout("text", extractText(pdf));
	const pages = Array.isArray(text) ? text : [text];
	if (pagesValue !== undefined) {
		const wanted = new Set(parsePages(pagesValue, totalPages));
		const selected = pages.filter((_, index) => wanted.has(index + 1));
		if (selected.every((page) => page.trim() === "")) {
			console.error("extract-pdf: note: selected pages have no text layer (scanned image PDF?)");
		}
		if (wantJson) console.log(JSON.stringify({ file, totalPages, pages: selected }, null, 2));
		else console.log(`PAGES ${selected.length} of ${totalPages}\n${selected.join("\n\n")}`);
		return;
	}
	if (pages.every((page) => page.trim() === "")) {
		console.error("extract-pdf: note: no text layer — this is a scanned image PDF; no OCR exists in this sandbox");
	}
	if (wantJson) console.log(JSON.stringify({ file, totalPages, pages }, null, 2));
	else console.log(`PAGES ${totalPages}\n${pages.join("\n\n")}`);
};

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
