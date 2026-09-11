/**
 * Drives the live app through the six beats and records one clip per beat.
 * Waits are driven by the narration: an action with `at` does not start until
 * the TTS reaches that phrase, and every beat is held to its segment length so
 * build.py never has to freeze a frame.
 *
 *   --probe        run every action with no waits and no video; list selectors that fail
 *   --only=<id>    record a single beat and merge it into clips/index.json
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { beats, readTake, OUT_DIR, VIDEO_DIR, type TerminalPane } from "./script.ts";
import { guard, pickByKinds, pickWindow } from "./logs.ts";

const PROBE = process.argv.includes("--probe");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const LOGS = path.join(VIDEO_DIR, "..", ".data", "logs");
const CLIPS = path.join(OUT_DIR, "clips");
const RAW = path.join(OUT_DIR, "raw");
const NAV_TIMEOUT = 20_000;

type AudioRow = { id: string; words: string; delayMs: number; segmentS: number };
type Word = { start: number; end: number; text: string };
type RouteMark = { atS: number; route: string };

// A visible pointer: headless Chromium draws none, and a hover nobody can see
// is not a demonstration.
const CURSOR = `
  (() => {
    const make = () => {
      if (document.getElementById("__cursor")) return;
      const c = document.createElement("div");
      c.id = "__cursor";
      c.style.cssText = "position:fixed;left:-100px;top:-100px;width:22px;height:22px;border:3px solid #61D8E8;border-radius:50%;box-shadow:0 0 0 2px rgba(13,17,24,.85);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);transition:transform .12s ease;";
      document.documentElement.appendChild(c);
      document.addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
      document.addEventListener("mousedown", () => { c.style.transform = "translate(-50%,-50%) scale(.6)"; }, true);
      document.addEventListener("mouseup", () => { c.style.transform = "translate(-50%,-50%)"; }, true);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", make); else make();
  })();`;

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Seconds from narration start at which `phrase` begins, per the TTS word boundaries. */
export function phraseStart(words: Word[], phrase: string): number {
  const target = norm(phrase).split(" ");
  const toks = words.map((w) => norm(w.text));
  for (let i = 0; i + target.length <= toks.length; i++) {
    if (target.every((t, k) => toks[i + k] === t)) return words[i].start;
  }
  throw new Error(`phrase not found in narration: "${phrase}"`);
}

function terminalData(panes: TerminalPane[], intervalMs: number) {
  return {
    intervalMs,
    panes: panes.map((p) => {
      const text = fs.readFileSync(path.join(LOGS, p.log), "utf8");
      const lines = p.mode === "window" ? pickWindow(text, "filled", p.lines) : pickByKinds(text, p.kinds, p.lines);
      return { title: p.title, lines: guard(lines) };
    }),
  };
}

/** Wait for the page to settle, then refuse the states the runbook says never to film. */
async function settled(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT }).catch(() => {});
  const bad = await page.evaluate(() => {
    const t = document.body.innerText;
    if (t.includes("SIMULATED DATA")) return "SIMULATED DATA";
    if (t.includes("could not load")) return "could not load";
    if (/This page could not be found|404/.test(document.title)) return "404";
    return null;
  });
  if (bad) throw new Error(`not filmable: page shows "${bad}" at ${page.url()}`);
}

async function main() {
  const take = readTake();
  const audio: AudioRow[] = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "audio", "index.json"), "utf8"));
  const wordsOf = (id: string): Word[] => {
    const row = audio.find((a) => a.id === id);
    if (!row) throw new Error(`no audio for ${id}; run tts.py first`);
    return JSON.parse(fs.readFileSync(path.join(OUT_DIR, "audio", row.words), "utf8"));
  };
  fs.mkdirSync(CLIPS, { recursive: true });
  fs.mkdirSync(RAW, { recursive: true });

  const browser = await chromium.launch();
  const index: { id: string; clip: string; recordedS: number; routes: RouteMark[] }[] = [];
  const missing: string[] = [];

  for (const beat of beats(take)) {
    if (ONLY && beat.id !== ONLY) continue;
    const row = audio.find((a) => a.id === beat.id)!;
    const words = wordsOf(beat.id);
    const delayS = row.delayMs / 1000;

    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
      reducedMotion: "no-preference",
      ...(PROBE ? {} : { recordVideo: { dir: RAW, size: { width: 1920, height: 1080 } } }),
    });
    await context.addInitScript(CURSOR);
    const page = await context.newPage();
    const t0 = Date.now();
    const elapsedS = () => (Date.now() - t0) / 1000;
    const routes: RouteMark[] = [];
    const setRoute = (route: string) => routes.push({ atS: Number(elapsedS().toFixed(2)), route });
    const wait = (ms: number) => (PROBE ? Promise.resolve() : page.waitForTimeout(ms));
    const loc = (sel: string) => page.locator(sel).first();

    console.log(`\n▶ ${beat.id} (${PROBE ? "probe" : `hold ${row.segmentS}s`})`);
    for (const a of beat.actions) {
      if (a.at && !PROBE) {
        const startS = delayS + phraseStart(words, a.at);
        const dt = startS - elapsedS();
        if (dt > 0) await page.waitForTimeout(dt * 1000);
        else console.warn(`  ${a.kind}: "${a.at}" already passed by ${(-dt).toFixed(1)}s — earlier actions ran long`);
      }
      try {
        switch (a.kind) {
          case "card":
            setRoute("");
            await page.goto("file://" + path.join(VIDEO_DIR, "cards.html"));
            await page.evaluate((n) => (window as unknown as { render: (o: { card: string }) => Promise<void> }).render({ card: n }), a.name);
            await wait(a.ms);
            break;
          case "goto":
            await page.goto(take.base + a.path, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
            await settled(page);
            setRoute(a.route);
            await page.mouse.move(960, 540);
            break;
          case "wait":
            await wait(a.ms);
            break;
          case "hover":
            await loc(a.selector).waitFor({ timeout: 15000 });
            await loc(a.selector).scrollIntoViewIfNeeded();
            await loc(a.selector).hover({ steps: PROBE ? 1 : 25 });
            await wait(a.ms ?? 1500);
            break;
          case "click":
            await loc(a.selector).waitFor({ timeout: 15000 });
            await loc(a.selector).hover({ steps: PROBE ? 1 : 20 });
            await wait(400);
            await loc(a.selector).click();
            await settled(page);
            setRoute(a.route);
            await wait(1200);
            break;
          case "scrollTo":
            await loc(a.selector).waitFor({ timeout: 15000 });
            await loc(a.selector).evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
            await wait(a.ms ?? 1500);
            break;
          case "explorer": {
            const href = await loc(a.selector).getAttribute("href");
            if (!href) throw new Error(`no href on ${a.selector}`);
            await loc(a.selector).scrollIntoViewIfNeeded();
            await loc(a.selector).hover({ steps: PROBE ? 1 : 20 });
            await wait(600);
            if (!PROBE) {
              const ok = await page.goto(href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }).then(() => true).catch(() => false);
              if (ok) {
                const u = new URL(href);
                setRoute(u.host + u.pathname.replace(/(0x[0-9a-f]{8})[0-9a-f]+/i, "$1…"));
              } else {
                console.warn("  explorer did not load in time; holding on the tape instead");
              }
            }
            await wait(a.ms);
            break;
          }
          case "terminal":
            setRoute("");
            await page.goto("file://" + path.join(VIDEO_DIR, "terminal.html"));
            await page.evaluate((d) => (window as unknown as { render: (o: unknown) => Promise<void> }).render(d), terminalData(a.panes, PROBE ? 0 : 350));
            await wait(a.ms);
            break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (PROBE && "selector" in a) {
          missing.push(`${beat.id}: ${a.kind} ${a.selector} — ${msg.split("\n")[0]}`);
          continue;
        }
        await context.close();
        await browser.close();
        throw new Error(`${beat.id} / ${a.kind}: ${msg}`);
      }
    }

    if (PROBE) {
      await context.close();
      continue;
    }
    const holdS = row.segmentS + 0.3 - elapsedS();
    if (holdS > 0) await page.waitForTimeout(holdS * 1000);
    else console.warn(`  actions overran the segment by ${(-holdS).toFixed(1)}s; build.py will trim the tail`);
    const recordedS = elapsedS();
    const video = page.video();
    await context.close();
    const raw = await video!.path();
    const clip = `${beat.id}.webm`;
    fs.renameSync(raw, path.join(CLIPS, clip));
    index.push({ id: beat.id, clip, recordedS: Number(recordedS.toFixed(2)), routes });
    console.log(`  recorded ${recordedS.toFixed(1)}s → ${clip}`);
  }
  await browser.close();

  if (PROBE) {
    if (missing.length) {
      console.error("\nunresolved selectors:\n  " + missing.join("\n  "));
      process.exit(1);
    }
    console.log("\nprobe ok: every selector resolved");
    return;
  }
  const indexPath = path.join(CLIPS, "index.json");
  const prev: typeof index = ONLY && fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : [];
  const merged = [...prev.filter((p) => !index.some((n) => n.id === p.id)), ...index].sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(indexPath, JSON.stringify(merged, null, 1));
  console.log("\nwrote", indexPath);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
