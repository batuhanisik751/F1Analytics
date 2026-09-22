// H2H_SPEC §7 — the head-to-head copy guard.
//
//   1. Every fan-facing string is pinned BYTE-FOR-BYTE.
//   2. No template holds a digit, a driver name or a month: every such value is a slot. The one
//      spelled percentile label "5th–95th" (spec §3) is not a data number and is masked first.
//   3. Forbidden words are absent. 4. `fill()` refuses to render an unfilled slot.
import test from "node:test";
import assert from "node:assert/strict";

import { H2H_COPY, C_H2H_2, C_H2H_7, C_H2H_8, REASONS, fill } from "@/lib/driver/h2hCaptions";

test("every head-to-head string is byte-for-byte", () => {
  assert.deepEqual(H2H_COPY, {
    C_H2H_1:
      "In {year} {a} and {b} started the same race {shared} times. Each line below counts only the races where both have that number, so the denominators differ. These lines compare car and driver together; they do not say who is the better driver.",
    C_H2H_2: "{a} ahead in {wins} of {counted} shared races, same car not implied.",
    C_H2H_2Q:
      "Qualifying position, not grid: the team-mate card above counts grid position, which moves with penalties.",
    C_H2H_3: "{a} {pointsA}, {b} {pointsB} points in the {shared} races both started.",
    C_H2H_4:
      "With the car taken out, the model puts {a} {absDelta} pp of a lap {fasterOrSlower} than {b}, 5th–95th {lo} to {hi}, across every season it has seen ({nA} races for {a}, {nB} for {b}). It is not a {year} number: the model is fitted once across seasons, never per season.",
    C_H2H_5:
      "The two answers are allowed to disagree: the first counts qualifying, finishes and pace in whatever car each drove; the second tries to take the car out. Neither is subtracted from the other.",
    C_H2H_6: "{a} and {b} shared a car in {nSharedRaces} races, so this gap is measured, not assumed.",
    C_H2H_7: "The model's side cannot be called here: {reason}.",
    REASON_ASSUMED: "the gap is assumed, not measured",
    REASON_ZERO: "the 5th–95th range includes zero",
    REASON_NO_ROW: "no stored contrast for this pair",
    C_H2H_8: "{year} ledger: {ledgerCall}. Car removed: {modelCall}.",
    LEDGER_CALL_LEADER: "{leader} ahead on pace in {n} of {d} shared races",
    LEDGER_CALL_LEVEL: "level on pace, {n} each of {d} shared races",
    LEDGER_CALL_NONE: "no shared race has a pace estimate for both",
    MODEL_CALL_LEADER: "{leader} quicker over every season the model has seen",
    MODEL_CALL_NONE: "cannot be called",
    C_CONTRAST_2:
      "These two drivers have never shared a car, and no chain of team moves connects them. This gap is what the model assumes, not what it measured.",
  });
  assert.deepEqual([...REASONS], [
    "the gap is assumed, not measured",
    "the 5th–95th range includes zero",
    "no stored contrast for this pair",
  ]);
});

test("no template holds a digit, a driver name or a month", () => {
  const names = /antonelli|russell|hamilton|norris|leclerc|verstappen|piastri/i;
  const months =
    /\b(january|february|march|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec)\b/i;
  for (const [id, copy] of Object.entries(H2H_COPY)) {
    assert.doesNotMatch(copy.replace(/5th–95th/g, ""), /\d/, `${id} holds a literal number`);
    assert.doesNotMatch(copy, names, `${id} holds a driver name`);
    assert.doesNotMatch(copy, months, `${id} holds a date`);
  }
});

test("forbidden words are absent from every template", () => {
  const forbidden = /\b(live|real-time|up to date|updated every hour)\b/i;
  for (const [id, copy] of Object.entries(H2H_COPY)) {
    assert.doesNotMatch(copy, forbidden, `${id} holds a forbidden word`);
  }
});

test("§8: the caveat is inside every counted line; the answers are not subtracted", () => {
  assert.match(C_H2H_2, /same car not implied\.$/);
  assert.match(H2H_COPY.C_H2H_1, /do not say who is the better driver\.$/);
  assert.match(H2H_COPY.C_H2H_4, /not a \{year\} number/);
  assert.match(H2H_COPY.C_H2H_5, /Neither is subtracted from the other\./);
});

test("fill() renders every slot and throws on a missing one", () => {
  assert.equal(fill(C_H2H_2, { a: "A", wins: 8, counted: 13 }), "A ahead in 8 of 13 shared races, same car not implied.");
  assert.equal(fill(C_H2H_7, { reason: REASONS[0] }), "The model's side cannot be called here: the gap is assumed, not measured.");
  assert.equal(
    fill(C_H2H_8, { year: 2026, ledgerCall: "level on pace, 3 each of 6 shared races", modelCall: "cannot be called" }),
    "2026 ledger: level on pace, 3 each of 6 shared races. Car removed: cannot be called.",
  );
  assert.throws(() => fill(C_H2H_2, { a: "A", wins: 8 }), /\{counted\} was not supplied/);
  assert.throws(() => fill(C_H2H_8, { year: 2026, ledgerCall: "x", modelCall: null }), /\{modelCall\}/);
  assert.throws(() => fill(C_H2H_2, { a: "A", wins: Number.NaN, counted: 3 }), /\{wins\}/);
});
