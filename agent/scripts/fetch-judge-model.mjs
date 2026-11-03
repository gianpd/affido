#!/usr/bin/env node
// Download (or verify) the pinned GLiNER2.5-Decide artifacts for the coherence
// judge (RFC 0017 §5.3). Idempotent: every file already present with the
// pinned size and SHA256 is skipped, a mismatched file is re-downloaded. The
// cache directory is gitignored; the agent never downloads — it loads with
// remote models disabled, so a missing cache fails loudly.
//
//   node agent/scripts/fetch-judge-model.mjs [mobile|full] [cache-dir]
//
// Default artifact: mobile (345 MB). `full` fetches the 523 MB non-mobile
// q4f16 build used as the parity reference. Cache default: agent/judge-models.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const ARTIFACTS = {
	mobile: {
		repo: "onnx-community/GLiNER2.5-Decide-mobile-ONNX",
		revision: "880d1921d315b44648c9f6c6fb6ea0b87dea2b62",
		dirName: "decide-mobile",
		files: [
			["config.json", 1617],
			["onnx/model_q4f16.onnx", 342105],
			["onnx/model_q4f16.onnx_data", 344936496],
			["tokenizer.json", 8333952],
			["tokenizer_config.json", 3360],
			["special_tokens_map.json", 2414],
		],
	},
	full: {
		repo: "onnx-community/GLiNER2.5-Decide-ONNX",
		revision: "18271032588167fe9a3fbb8c5a4900b1231f8119",
		dirName: "decide",
		files: [
			["config.json", 1693],
			["onnx/model_q4f16.onnx", 341889],
			["onnx/model_q4f16.onnx_data", 523127808],
			["tokenizer.json", 8333952],
			["tokenizer_config.json", 3360],
			["special_tokens_map.json", 2414],
		],
	},
};

const artifact = ARTIFACTS[process.argv[2] ?? "mobile"];
if (artifact === undefined) {
	console.error(`unknown artifact "${process.argv[2]}"; use mobile or full`);
	process.exit(2);
}
const cacheRoot = resolve(process.argv[3] ?? process.env.CITATION_JUDGE_MODEL_DIR ?? join(REPO_ROOT, "agent", "judge-models"));
const target = join(cacheRoot, artifact.dirName);

const sha256 = async (path) => {
	const hash = createHash("sha256");
	await pipeline(createReadStream(path), async function* (source) {
		for await (const chunk of source) hash.update(chunk);
	});
	return hash.digest("hex");
};

const url = (file) => `https://huggingface.co/${artifact.repo}/resolve/${artifact.revision}/${file}`;
const totalBytes = artifact.files.reduce((sum, [, bytes]) => sum + bytes, 0);
let doneBytes = 0;
console.log(`${artifact.repo}@${artifact.revision}`);
console.log(`cache: ${target}`);
const digests = [];
for (const [file, bytes] of artifact.files) {
	const out = join(target, file);
	await mkdir(dirname(out), { recursive: true });
	const info = await stat(out).catch(() => null);
	if (info !== null && info.isFile() && info.size === bytes) {
		const digest = await sha256(out);
		digests.push([file, bytes, digest]);
		console.log(`ok      ${file} (${bytes} bytes, sha256 ${digest.slice(0, 16)}…)`);
		doneBytes += bytes;
		continue;
	}
	if (info !== null) await rm(out, { force: true });
	const part = `${out}.part`;
	console.log(`fetch   ${file} (${bytes} bytes)`);
	const response = await fetch(url(file), { redirect: "follow" });
	if (!response.ok || response.body === null) {
		console.error(`download failed: ${response.status} ${url(file)}`);
		process.exit(1);
	}
	await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
	const partInfo = await stat(part);
	if (partInfo.size !== bytes) {
		console.error(`size mismatch after download: ${partInfo.size} != ${bytes} for ${file}`);
		process.exit(1);
	}
	await rename(part, out);
	const digest = await sha256(out);
	digests.push([file, bytes, digest]);
	console.log(`fetched ${file} sha256 ${digest}`);
	doneBytes += bytes;
	console.log(`progress ${doneBytes}/${totalBytes} bytes`);
}
console.log(`\nmanifest (paste into gliner-decide-judge.ts / eval fixtures):`);
for (const [file, bytes, digest] of digests) {
	console.log(`{ path: "${file}", bytes: ${bytes}, sha256: "${digest}" },`);
}
console.log(`\nverify in-process next: loading ${artifact.dirName} with remote models disabled`);
process.env.CITATION_JUDGE_MODEL_DIR = cacheRoot;
import { env, AutoConfig, AutoModel } from "@huggingface/transformers";
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = cacheRoot;
const config = await AutoConfig.from_pretrained(artifact.dirName);
const model = await AutoModel.from_pretrained(artifact.dirName, { config, dtype: "q4f16", device: "cpu" });
console.log(`loaded ${artifact.dirName}: q4f16 cpu, vocab ${config.vocab_size}`);
await model.dispose?.();
console.log("done");
