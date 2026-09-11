import { test } from "node:test";
import assert from "node:assert/strict";
import { choose, caseFor, fmtUsdc, type Candidate } from "../select.ts";

const c = (o: Partial<Candidate>): Candidate => ({ slug: "a", name: "A", sessionNumber: 1, marketId: "0x1", question: "q", bookNonEmpty: false, trades: 0, ...o });

test("a quoted book beats more trades; otherwise most trades", () => {
  assert.equal(choose([c({ slug: "many", trades: 30 }), c({ slug: "quoted", trades: 2, bookNonEmpty: true })]).slug, "quoted");
  assert.equal(choose([c({ slug: "few", trades: 3 }), c({ slug: "many", trades: 30 })]).slug, "many");
  assert.throws(() => choose([]), /no filmable agent/);
});

test("case A on a quoted book, C on a recent order error, else B", () => {
  const now = Date.parse("2026-09-11T12:00:00Z");
  const recentErr = `2026-09-11T11:58:30.000Z error order     market=x reason="Missing or invalid parameters."`;
  const oldErr = `2026-09-11T10:00:00.000Z error order     market=x reason="Missing or invalid parameters."`;
  const refuse = `2026-09-11T11:59:00.000Z warn  refuse    market=x thesis=backer reason="record is losing"`;
  assert.equal(caseFor(true, [recentErr], now), "A");
  assert.equal(caseFor(false, [recentErr, refuse], now), "C");
  assert.equal(caseFor(false, [oldErr, refuse], now), "B");
});

test("fmtUsdc renders 6-decimal integers with two decimals", () => {
  assert.equal(fmtUsdc("225641000"), "225.64");
  assert.equal(fmtUsdc("441328007"), "441.33");
  assert.equal(fmtUsdc("10000000"), "10.00");
});
