// REVALIDATE_SPEC §6 — `pushedAt` is an ISO string at the source so the cached value survives
// JSON.stringify/JSON.parse; formatPushedAt must therefore accept that string and pin the
// footer's fixed UTC format (the a11y baseline depends on it).
import test from "node:test";
import assert from "node:assert/strict";

import { formatPushedAt, staleRoundFrom, todayUtc } from "@/lib/queries/release";

test("formatPushedAt parses an ISO string and renders the fixed UTC format", () => {
  assert.equal(formatPushedAt("2026-09-19T03:20:00.000Z"), "19 Sep 2026, 03:20 UTC");
});

test("formatPushedAt is UTC regardless of the offset in the input", () => {
  assert.equal(formatPushedAt("2026-01-01T00:05:00+02:00"), "31 Dec 2025, 22:05 UTC");
});

test("formatPushedAt pads hours and minutes but not the day", () => {
  assert.equal(formatPushedAt("2026-03-07T09:04:00.000Z"), "7 Mar 2026, 09:04 UTC");
});

test("todayUtc is the ISO date part", () => {
  assert.equal(todayUtc(new Date("2026-09-22T23:59:59Z")), "2026-09-22");
});

test("staleRoundFrom flags the latest past round only when it is not loaded", () => {
  const rows = [
    { year: 2026, round: 1, eventName: "A", eventDate: "2026-03-01", loaded: true },
    { year: 2026, round: 2, eventName: "B", eventDate: "2026-03-15", loaded: false },
    { year: 2026, round: 3, eventName: "C", eventDate: "2026-04-01", loaded: false },
  ];
  assert.deepEqual(staleRoundFrom(rows, "2026-03-20"), {
    year: 2026, round: 2, eventName: "B", eventDate: "2026-03-15",
  });
  assert.equal(staleRoundFrom(rows, "2026-03-15"), null);
  assert.equal(staleRoundFrom(rows, "2026-03-10"), null);
});
