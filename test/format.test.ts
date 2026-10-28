import assert from "node:assert/strict";
import test from "node:test";

import { formatClock, formatDuration, formatWhen, preview } from "../src/format.ts";

process.env.TZ = "America/Los_Angeles";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("formats durations to the second below an hour and to the minute above", () => {
  const cases: Array<[number, string]> = [
    [0, "0s"],
    [400, "1s"],
    [45_000, "45s"],
    [MINUTE, "1m"],
    [4 * MINUTE + 30_000, "4m 30s"],
    [HOUR, "1h"],
    [HOUR + 30 * MINUTE, "1h 30m"],
    [3 * HOUR + 12 * MINUTE + 47_000, "3h 12m"],
    [DAY + HOUR + MINUTE + 1_000, "1d 1h 1m"],
    [DAY + 5 * MINUTE, "1d 5m"],
    [2 * DAY, "2d"],
  ];
  for (const [ms, expected] of cases) assert.equal(formatDuration(ms), expected, String(ms));
});

test("formats local clock times on a 12-hour clock", () => {
  const cases: Array<[string, string]> = [
    ["2026-10-28T16:35:00-07:00", "4:35pm"],
    ["2026-10-28T00:00:00-07:00", "12:00am"],
    ["2026-10-28T12:00:00-07:00", "12:00pm"],
    ["2026-10-28T09:05:30-07:00", "9:05:30am"],
    ["2026-10-28T23:59:59.999-07:00", "11:59:59pm"],
  ];
  for (const [instant, expected] of cases) assert.equal(formatClock(Date.parse(instant)), expected, instant);
});

test("qualifies due times by calendar day relative to now", () => {
  const now = Date.parse("2026-10-28T13:00:00-07:00");
  const cases: Array<[string, string, string]> = [
    ["2026-10-28T13:00:00-07:00", "2026-10-28T16:35:00-07:00", "4:35pm"],
    ["2026-10-28T13:00:00-07:00", "2026-10-29T09:00:00-07:00", "tomorrow 9:00am"],
    ["2026-10-28T13:00:00-07:00", "2026-10-27T16:35:00-07:00", "yesterday 4:35pm"],
    ["2026-10-28T13:00:00-07:00", "2026-10-30T16:35:00-07:00", "Fri Oct 30 4:35pm"],
    ["2026-12-28T13:00:00-08:00", "2027-01-01T16:35:00-08:00", "Fri Jan 1 2027 4:35pm"],
    // Calendar days, not 24-hour periods, across the 25-hour fall-back day.
    ["2026-10-31T23:30:00-07:00", "2026-11-01T23:00:00-08:00", "tomorrow 11:00pm"],
    ["2026-11-01T00:30:00-07:00", "2026-11-01T23:30:00-08:00", "11:30pm"],
  ];
  for (const [nowText, dueText, expected] of cases) {
    assert.equal(formatWhen(Date.parse(dueText), Date.parse(nowText)), expected, `${nowText} -> ${dueText}`);
  }
  assert.equal(formatWhen(now, now), "1:00pm");
});

test("previews prompts on one line within a width", () => {
  assert.equal(preview("line one\n  line two\tend"), "line one line two end");
  assert.equal(preview("a".repeat(60)), "a".repeat(60));
  assert.equal(preview("a".repeat(61)), `${"a".repeat(59)}…`);
  assert.equal(preview("abcdef", 4), "abc…");
});
