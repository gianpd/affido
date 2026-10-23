// =============================================================================
// logo-palette.js — Bounded, pure-Node PNG palette extractor (sandbox edition)
// =============================================================================
// Usage: node logo-palette.js <logo.png>
//
// Prints the dominant non-white / non-black colors of the image with their
// weight, ready to be assigned to the 8 style tokens (see SKILL.md, Method A).
//
// Pure Node: only the `fs` and `zlib` core modules. Bounds: refuses files over
// 4 MiB or over 2,000,000 pixels; supports 8-bit non-interlaced PNGs of color
// type 0 (gray), 2 (RGB), 4 (gray+alpha), 6 (RGBA). Anything else reports
// "unsupported" so the caller falls back to hex codes or a preset.
// =============================================================================

'use strict';

const fs = require('fs');
const zlib = require('zlib');

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 2_000_000;
const ALPHA_THRESHOLD = 128; // pixels below 50% opacity are ignored
const NEAR_WHITE = 240;
const NEAR_BLACK = 16;
const BUCKET = 16; // merge anti-aliasing noise: round each channel to a bucket

const fail = (message) => {
	console.error(`logo-palette: ${message}`);
	process.exit(1);
};

const file = process.argv[2];
if (file === undefined) fail('usage: node logo-palette.js <logo.png>');

let buffer;
try {
	buffer = fs.readFileSync(file);
} catch (error) {
	fail(`cannot read ${file}: ${error.message}`);
}
if (buffer.length > MAX_FILE_BYTES) fail(`file exceeds ${MAX_FILE_BYTES} bytes`);
if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
	fail('not a PNG (wrong signature)');
}

// ---- Parse chunks: IHDR first, then concatenate every IDAT. ----
let width = 0;
let height = 0;
let bitDepth = 0;
let colorType = -1;
let interlace = -1;
const idat = [];
for (let offset = 8; offset + 8 <= buffer.length; ) {
	const length = buffer.readUInt32BE(offset);
	const type = buffer.toString('latin1', offset + 4, offset + 8);
	const data = buffer.subarray(offset + 8, offset + 8 + length);
	if (type === 'IHDR') {
		width = data.readUInt32BE(0);
		height = data.readUInt32BE(4);
		bitDepth = data[8];
		colorType = data[9];
		interlace = data[12];
	} else if (type === 'IDAT') {
		idat.push(data);
	} else if (type === 'IEND') {
		break;
	}
	offset += 12 + length; // length + type + data + CRC
}
if (width === 0) fail('no IHDR chunk found');
if (bitDepth !== 8) fail(`unsupported bit depth ${bitDepth} (only 8-bit images)`);
if (interlace !== 0) fail('interlaced PNGs are not supported');
const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
if (channels === undefined) fail(`unsupported color type ${colorType}`);
if (width * height > MAX_PIXELS) fail(`image exceeds ${MAX_PIXELS} pixels (${width}x${height})`);

// ---- Inflate and unfilter the scanlines. ----
let raw;
try {
	raw = zlib.inflateSync(Buffer.concat(idat));
} catch (error) {
	fail(`cannot inflate image data: ${error.message}`);
}
const bytesPerPixel = channels; // 8-bit depth: one byte per channel
const stride = width * bytesPerPixel;
const pixels = Buffer.alloc(height * stride);
const paeth = (a, b, c) => {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
for (let y = 0; y < height; y++) {
	const filter = raw[y * (stride + 1)];
	const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
	const out = pixels.subarray(y * stride, (y + 1) * stride);
	const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
	for (let x = 0; x < stride; x++) {
		const left = x >= bytesPerPixel ? out[x - bytesPerPixel] : 0;
		const up = prior !== null ? prior[x] : 0;
		const upperLeft = prior !== null && x >= bytesPerPixel ? prior[x - bytesPerPixel] : 0;
		let value = line[x];
		if (filter === 1) value = (value + left) & 0xff;
		else if (filter === 2) value = (value + up) & 0xff;
		else if (filter === 3) value = (value + ((left + up) >> 1)) & 0xff;
		else if (filter === 4) value = (value + paeth(left, up, upperLeft)) & 0xff;
		else if (filter !== 0) fail(`unknown filter type ${filter} on line ${y}`);
		out[x] = value;
	}
}

// ---- Count colors: opaque, non-white, non-black, bucketed. ----
const buckets = new Map();
let counted = 0;
for (let index = 0; index < width * height; index++) {
	const base = index * bytesPerPixel;
	let r;
	let g;
	let b;
	let a = 255;
	if (colorType === 0) {
		r = g = b = pixels[base];
	} else if (colorType === 2) {
		r = pixels[base];
		g = pixels[base + 1];
		b = pixels[base + 2];
	} else if (colorType === 4) {
		r = g = b = pixels[base];
		a = pixels[base + 1];
	} else {
		r = pixels[base];
		g = pixels[base + 1];
		b = pixels[base + 2];
		a = pixels[base + 3];
	}
	if (a < ALPHA_THRESHOLD) continue;
	if (r >= NEAR_WHITE && g >= NEAR_WHITE && b >= NEAR_WHITE) continue;
	if (r <= NEAR_BLACK && g <= NEAR_BLACK && b <= NEAR_BLACK) continue;
	counted++;
	const key = `${r >> 4}-${g >> 4}-${b >> 4}`; // BUCKET-16: merge anti-aliasing noise
	const entry = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
	entry.r += r;
	entry.g += g;
	entry.b += b;
	entry.n += 1;
	buckets.set(key, entry);
}
if (counted === 0) {
	fail('no colored pixels: the image is white/black/transparent only — ask for hex codes');
}

// ---- Report the top buckets as averaged hex colors. ----
const top = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 5);
const hex = (value) => value.toString(16).padStart(2, '0').toUpperCase();
top.forEach((entry, index) => {
	const share = ((entry.n / counted) * 100).toFixed(1);
	console.log(`${index + 1}. #${hex(Math.round(entry.r / entry.n))}${hex(Math.round(entry.g / entry.n))}${hex(Math.round(entry.b / entry.n))} — ${share}%`);
});
