import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire("/home/jaco/develops/RESEARCH/affido/frontend/package.json");
const { chromium } = require("playwright");

const here = new URL(".", import.meta.url).pathname;
const pageUrl = "file://" + resolve(here, "index.html");
const out = resolve(here, "..", "out", "stills");
await mkdir(out, { recursive: true });

const times = process.argv.slice(2).map(Number);
const browser = await chromium.launch({ args: ["--font-render-hinting=none"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("console", (m) => console.log("page:", m.type(), m.text()));
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(pageUrl, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);

for (const t of times) {
  await page.evaluate((tt) => window.renderAt(tt), t);
  await page.waitForTimeout(30);
  const file = resolve(out, `t-${String(t).replace(".", "_").padStart(6, "0")}.png`);
  await page.screenshot({ path: file });
  console.log(file);
}
await browser.close();
