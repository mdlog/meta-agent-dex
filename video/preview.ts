/** Screenshots the terminal shots and the two cards so a human can look before the take. */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { OUT_DIR, VIDEO_DIR, readTake } from "./script.ts";
import { guard, pickByKinds, pickWindow } from "./logs.ts";

const LOGS = path.join(VIDEO_DIR, "..", ".data", "logs");
const take = readTake();
const dir = path.join(OUT_DIR, "preview");
fs.mkdirSync(dir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

const runner = fs.readFileSync(path.join(LOGS, `runner-${take.agent.slug}.log`), "utf8");
await page.goto("file://" + path.join(VIDEO_DIR, "terminal.html"));
await page.evaluate((data) => (window as any).render(data), {
  intervalMs: 0,
  panes: [{ title: `AGENT_SLUG=${take.agent.slug} node --experimental-strip-types bots/runner.ts`, lines: guard(pickWindow(runner, "filled", 8)) }],
});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(dir, "terminal-runner.png") });

const kinds = { A: ["view", "intent", "resting", "filled"], B: ["view", "refuse", "hold"], C: ["view", "intent", "error"] }[take.case];
await page.evaluate((data) => (window as any).render(data), {
  intervalMs: 0,
  panes: ["backer", "skeptic"].map((t) => ({
    title: `AGENT_THESIS=${t} npm run speculator`,
    lines: guard(pickByKinds(fs.readFileSync(path.join(LOGS, `speculator-${t}.log`), "utf8"), kinds, 6)),
  })),
});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(dir, "terminal-speculators.png") });

for (const name of ["title", "end"] as const) {
  await page.goto("file://" + path.join(VIDEO_DIR, "cards.html"));
  await page.evaluate((n) => (window as any).render({ card: n }), name);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `card-${name}.png`) });
}
await browser.close();
console.log("previews in", dir);
