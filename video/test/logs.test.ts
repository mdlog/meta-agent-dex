import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLine, pickWindow, pickByKinds, guard } from "../logs.ts";

const LOG = [
  "2026-09-11T14:23:05.522Z info  scan      live=27 tradable=10 nav=65.318796 budget=55.318796 session_ends_in_s=4195",
  '2026-09-11T14:23:09.336Z info  signal    market=ETH-5m@14:25 strategy=momentum p=0.369 rule="up +3.8pt/30s" side=BUY_YES price=0.385 qty=38.961 cost=14.999985',
  "2026-09-11T14:23:11.249Z info  sent      market=ETH-5m@14:25 side=BUY_YES tx=0x41fa06cfc9ef69afc64c8c31628d9f1f4e538677569fe5b55f52b2cc5f376996",
  "2026-09-11T14:23:11.629Z info  filled    market=ETH-5m@14:25 side=BUY_YES cash_delta=-12.701286 gas_used=490215 tx=0x41fa06cfc9ef69afc64c8c31628d9f1f4e538677569fe5b55f52b2cc5f376996",
  "2026-09-11T14:24:11.574Z warn  nofill    market=ETH-5m@14:25 side=BUY_YES gas_used=109233 tx=0xb815d5d5047b20dc0891ffecbaf489963e3c36739c899a0099870f6b6df29dfa",
].join("\n");

test("parseLine splits timestamp, level, kind and the rest", () => {
  const l = parseLine(LOG.split("\n")[1])!;
  assert.equal(l.ts, "2026-09-11T14:23:09.336Z");
  assert.equal(l.level, "info");
  assert.equal(l.kind, "signal");
  assert.match(l.rest, /^market=ETH-5m@14:25 strategy=momentum/);
  assert.equal(parseLine("garbage"), null);
});

test("pickWindow ends at the last `filled` and keeps the lines before it", () => {
  const w = pickWindow(LOG, "filled", 3);
  assert.deepEqual(w.map((l) => l.kind), ["signal", "sent", "filled"]);
});

test("pickByKinds keeps only the listed kinds, most recent last", () => {
  assert.deepEqual(pickByKinds(LOG, ["scan", "nofill"], 5).map((l) => l.kind), ["scan", "nofill"]);
  assert.deepEqual(pickByKinds(LOG, ["scan", "nofill"], 1).map((l) => l.kind), ["nofill"]);
});

test("guard passes tx= hashes and refuses a bare 64-hex value", () => {
  assert.equal(guard(pickWindow(LOG, "filled", 4)).length, 4);
  const bad = parseLine("2026-09-11T14:23:11.249Z info  boot      key=0x41fa06cfc9ef69afc64c8c31628d9f1f4e538677569fe5b55f52b2cc5f376996")!;
  assert.throws(() => guard([bad]), /refusing to render/);
});
