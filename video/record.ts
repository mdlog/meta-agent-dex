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

const TERMINAL_HTML = fs.readFileSync(path.join(VIDEO_DIR, "terminal.html"), "utf8");
const CARDS_HTML = fs.readFileSync(path.join(VIDEO_DIR, "cards.html"), "utf8");

/**
 * Terminal shots and the end card sit in a full-screen iframe over the page
 * that is already loaded, so cutting back to the app is a DOM removal rather
 * than a navigation that has to re-read the chain.
 */
async function overlay(page: Page, html: string, render: unknown) {
  await page.evaluate(
    async ({ html, render }) => {
      document.getElementById("__overlay")?.remove();
      const cursor = document.getElementById("__cursor");
      if (cursor) cursor.style.display = "none";
      const f = document.createElement("iframe");
      f.id = "__overlay";
      f.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:2147483646;background:#0D1118;";
      f.srcdoc = html;
      document.documentElement.appendChild(f);
      await new Promise((r) => (f.onload = r));
      await (f.contentWindow as unknown as { render: (o: unknown) => Promise<void> }).render(render);
    },
    { html, render },
  );
}

async function clearOverlay(page: Page) {
  await page.evaluate(() => {
    document.getElementById("__overlay")?.remove();
    const cursor = document.getElementById("__cursor");
    if (cursor) cursor.style.display = "";
  });
}

/**
 * The Shannon explorer takes ~12 s to render a transaction in headless Chromium,
 * far longer than the beat can wait, so the shot is a screenshot of the real
 * explorer page for the tape's newest transaction, captured off-camera at the
 * start of the beat and shown as an overlay when the narration reaches it.
 */
async function captureExplorer(browser: import("playwright").Browser, take: { base: string; explorer: string; agent: { slug: string } }) {
  const profile = (await fetch(`${take.base}/api/agents/${take.agent.slug}`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json())) as { trades: { txHash: string }[] };
  const tx = profile.trades.find((t) => t.txHash)?.txHash;
  if (!tx) return null;
  const url = `${take.explorer}/tx/${tx}`;
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  const shot = path.join(OUT_DIR, "explorer.png");
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.getByText(tx.slice(0, 10)).first().waitFor({ timeout: 40_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: shot });
    return { tx, url, shot };
  } catch (e) {
    console.warn(`  explorer capture failed (${e instanceof Error ? e.message.split("\n")[0] : e}); holding on the tape instead`);
    return null;
  } finally {
    await ctx.close();
  }
}

/** A cold SSR page reads the chain (≈1–3 s); hitting it once first makes the on-camera load fast. */
async function warm(base: string, paths: string[]) {
  for (const p of paths) {
    await fetch(base + p, { signal: AbortSignal.timeout(30_000) }).then((r) => r.arrayBuffer()).catch(() => {});
  }
}

/** Wait for the page to settle, then refuse the states the runbook says never to film. */
async function settled(page: Page) {
  // "load" plus a short settle: these pages poll, so networkidle would wait
  // its whole timeout on every navigation and push every anchored action late.
  await page.waitForLoadState("load", { timeout: NAV_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(800);
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

    // Off-camera preparation first: warm the server and capture the explorer
    // before the recording context exists, so none of it lands in the clip.
    if (!PROBE) await warm(take.base, beat.actions.flatMap((a) => (a.kind === "goto" ? [a.path] : [])));
    const explorerShot = !PROBE && beat.actions.some((a) => a.kind === "explorer") ? await captureExplorer(browser, take) : null;

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
    let currentRoute = "";
    const setRoute = (route: string) => routes.push({ atS: Number(elapsedS().toFixed(2)), route });
    const wait = (ms: number) => (PROBE ? Promise.resolve() : page.waitForTimeout(ms));
    const loc = (sel: string) => page.locator(sel).first();
    // A client-rendered page whose API call failed once shows nothing until its
    // next poll; a reload is what a person would do, so do it once, on camera.
    const ready = async (sel: string) => {
      try {
        await loc(sel).waitFor({ timeout: 15000 });
      } catch {
        console.warn(`  ${sel} not visible after 15s — reloading once`);
        await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        await settled(page);
        await loc(sel).waitFor({ timeout: 20000 });
      }
    };

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
            if (page.url() === "about:blank") {
              await page.goto("file://" + path.join(VIDEO_DIR, "cards.html"));
              await page.evaluate((n) => (window as unknown as { render: (o: { card: string }) => Promise<void> }).render({ card: n }), a.name);
            } else {
              await overlay(page, CARDS_HTML, { card: a.name });
            }
            await wait(a.ms);
            break;
          case "goto":
            await page.goto(take.base + a.path, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
            await settled(page);
            currentRoute = a.route;
            setRoute(a.route);
            await page.mouse.move(960, 540);
            break;
          case "wait":
            await wait(a.ms);
            break;
          case "hover":
            await ready(a.selector);
            await loc(a.selector).scrollIntoViewIfNeeded();
            await loc(a.selector).hover({ steps: PROBE ? 1 : 25 });
            await wait(a.ms ?? 1500);
            break;
          case "click":
            await ready(a.selector);
            await loc(a.selector).hover({ steps: PROBE ? 1 : 20 });
            await wait(400);
            await loc(a.selector).click();
            await settled(page);
            currentRoute = a.route;
            setRoute(a.route);
            await wait(1200);
            break;
          case "scrollTo":
            await ready(a.selector);
            await loc(a.selector).evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
            await wait(a.ms ?? 1500);
            break;
          case "explorer": {
            const link = explorerShot ? page.locator(`table a[href*="${explorerShot.tx}"]`).first() : loc(a.selector);
            const target = (await link.count()) > 0 ? link : loc(a.selector);
            await ready(a.selector);
            await target.scrollIntoViewIfNeeded();
            await target.hover({ steps: PROBE ? 1 : 20 });
            await wait(700);
            if (explorerShot) {
              const png = fs.readFileSync(explorerShot.shot).toString("base64");
              await page.evaluate((src) => {
                document.getElementById("__overlay")?.remove();
                const cursor = document.getElementById("__cursor");
                if (cursor) cursor.style.display = "none";
                const img = document.createElement("img");
                img.id = "__overlay";
                img.src = src;
                img.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483646;object-fit:cover;";
                document.documentElement.appendChild(img);
              }, `data:image/png;base64,${png}`);
              const u = new URL(explorerShot.url);
              setRoute(u.host + u.pathname.replace(/(0x[0-9a-f]{8})[0-9a-f]+/i, "$1…"));
            }
            await wait(a.ms);
            break;
          }
          case "terminal":
            setRoute("");
            await overlay(page, TERMINAL_HTML, terminalData(a.panes, PROBE ? 0 : 350));
            await wait(a.ms);
            await clearOverlay(page);
            setRoute(currentRoute);
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
