import { test } from "node:test";
import assert from "node:assert/strict";
import { beats, narrationFor, type Take } from "../script.ts";

const take: Take = {
  base: "http://localhost:3009", explorer: "https://shannon-explorer.somnia.network", case: "A",
  agent: { slug: "kestrel-7", name: "Kestrel 7" },
  openSession: 32, openMarketId: "0xopen", openQuestion: "Will agent Kestrel 7 close session #32 with a higher NAV?",
  settledSession: 30, settledMarketId: "0xsettled",
  navT0: "225.64", navT1: "441.33", answer: "YES", paid: "Up",
};

test("six beats, every variable resolved, no braces left", () => {
  const b = beats(take);
  assert.equal(b.length, 6);
  for (const beat of b) assert.doesNotMatch(beat.narration, /[{}]/, beat.id);
  assert.match(b[2].narration, /will Kestrel 7 close session 32/);
  assert.match(b[4].narration, /opened at 225\.64 and closed at 441\.33; the oracle answered YES, and DreamDEX paid the Up side/);
});

test("beat 3 narration follows the case", () => {
  assert.match(beats({ ...take, case: "A" })[2].narration, /What is on this book came from/);
  assert.match(beats({ ...take, case: "B" })[2].narration, /made it refuse/);
  assert.match(beats({ ...take, case: "C" })[2].narration, /the send was rejected/);
});

test("terminal panes name real log files and the case's kinds", () => {
  const b = beats({ ...take, case: "B" });
  const term2 = b[1].actions.find((a) => a.kind === "terminal");
  assert.ok(term2 && term2.kind === "terminal");
  assert.equal(term2.panes[0].log, "runner-kestrel-7.log");
  const term3 = b[2].actions.find((a) => a.kind === "terminal");
  assert.ok(term3 && term3.kind === "terminal");
  assert.deepEqual(term3.panes.map((p) => p.log), ["speculator-backer.log", "speculator-skeptic.log"]);
  assert.deepEqual(term3.panes[0].kinds, ["view", "refuse", "hold"]);
});

test("narrationFor carries delay and minimum visual length", () => {
  const n = narrationFor(take);
  assert.equal(n[0].delayMs, 500);
  assert.ok(n.every((x) => x.minVisualMs >= 8000));
});
