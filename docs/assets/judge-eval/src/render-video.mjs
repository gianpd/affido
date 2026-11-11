import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire("/home/jaco/develops/RESEARCH/affido/frontend/package.json");
const { chromium } = require("playwright");

const here = new URL(".", import.meta.url).pathname;
const pageUrl = "file://" + resolve(here, "index.html");
const outDir = resolve(here, "..", "out");
await mkdir(outDir, { recursive: true });
const mixPath = resolve(here, "..", "audio", "mix.wav");
if (!existsSync(mixPath)) {
  throw new Error("missing audio/mix.wav: run `python3 src/mix-audio.py` first");
}
const videoPath = resolve(here, "..", "..", "judge-eval.mp4");
const posterPath = resolve(here, "..", "..", "judge-eval-poster.png");
const FPS = 30;

const browser = await chromium.launch({ args: ["--font-render-hinting=none"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(pageUrl, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);

// Warm the font atlas and the grid before the first captured frame.
for (const t of [70, 100, 150, 17, 3]) {
  await page.evaluate((tt) => window.renderAt(tt), t);
  await page.waitForTimeout(50);
}

const total = await page.evaluate(() => window.videoTotal);
const frames = Math.ceil(total * FPS);
console.log("frames", frames, "total", total);

const ff = spawn("ffmpeg", [
  "-y",
  "-f", "image2pipe", "-framerate", String(FPS), "-vcodec", "png", "-i", "-",
  "-i", mixPath,
  "-map", "0:v:0", "-map", "1:a:0",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-tune", "animation",
  "-pix_fmt", "yuv420p", "-r", String(FPS), "-g", "60",
  "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-af", "volume=-1.0dB",
  "-shortest", "-movflags", "+faststart",
  "-metadata", "title=The citation judge",
  "-metadata", "comment=afFido citation control - agent/judge-eval",
  videoPath,
], { stdio: ["pipe", "ignore", "pipe"] });

let ffErr = "";
ff.stderr.on("data", (d) => { ffErr += d.toString(); });
ff.stdin.on("error", (e) => { ffErr += "\nstdin: " + e.message; });
const started = Date.now();

for (let i = 0; i < frames; i++) {
  const t = i / FPS;
  await page.evaluate((tt) => window.renderAt(tt), t);
  const buf = await page.screenshot({ type: "png" });
  if (!ff.stdin.write(buf)) await once(ff.stdin, "drain");
  if (i % 150 === 0) {
    const sec = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`frame ${i}/${frames}  t=${t.toFixed(2)}  ${sec}s`);
  }
}
ff.stdin.end();
const [code] = await once(ff, "close");
if (code !== 0) {
  console.error(ffErr.slice(-4000));
  throw new Error("ffmpeg exited " + code);
}
console.log("video", videoPath);

await page.evaluate((tt) => window.renderAt(tt), 10.6);
await page.waitForTimeout(80);
await page.screenshot({ path: posterPath });
console.log("poster", posterPath);

await browser.close();
