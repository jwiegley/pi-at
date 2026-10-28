import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_COMMANDS, assertDeliverable, parseAtRequest, resolveDueAt } from "../src/parse.ts";

// Clock expectations below are written in Pacific time, including both 2026 DST transitions.
process.env.TZ = "America/Los_Angeles";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("parses delays in every supported unit spelling", () => {
  const cases: Array<[string, number]> = [
    ["4h", 4 * HOUR],
    ["30m", 30 * MINUTE],
    ["45s", 45 * SECOND],
    ["2d", 2 * DAY],
    ["10sec", 10 * SECOND],
    ["3secs", 3 * SECOND],
    ["1second", SECOND],
    ["5seconds", 5 * SECOND],
    ["15min", 15 * MINUTE],
    ["15mins", 15 * MINUTE],
    ["1minute", MINUTE],
    ["20minutes", 20 * MINUTE],
    ["1hr", HOUR],
    ["2hrs", 2 * HOUR],
    ["1hour", HOUR],
    ["3hours", 3 * HOUR],
    ["1day", DAY],
    ["2days", 2 * DAY],
    ["2HRS", 2 * HOUR],
  ];
  for (const [spec, ms] of cases) {
    assert.deepEqual(parseAtRequest(`${spec} ping`), { when: { kind: "delay", ms }, prompt: "ping" }, spec);
  }
});

test("adds compound, fractional, and space-separated delay parts", () => {
  const cases: Array<[string, number, string]> = [
    ["1h30m ping", 90 * MINUTE, "ping"],
    ["1h 30m ping", 90 * MINUTE, "ping"],
    ["90 minutes ping", 90 * MINUTE, "ping"],
    ["1 hour 30 minutes ping", 90 * MINUTE, "ping"],
    ["1d2h3m4s ping", DAY + 2 * HOUR + 3 * MINUTE + 4 * SECOND, "ping"],
    ["1.5h ping", 90 * MINUTE, "ping"],
    ["1.25s ping", 1_250, "ping"],
    ["0m30s ping", 30 * SECOND, "ping"],
    ["2h 5 tests are failing", 2 * HOUR, "5 tests are failing"],
    ["2h 3d-printer status", 2 * HOUR, "3d-printer status"],
  ];
  for (const [args, ms, prompt] of cases) {
    assert.deepEqual(parseAtRequest(args), { when: { kind: "delay", ms }, prompt }, args);
  }
});

test("parses 12-hour, 24-hour, and named clock times", () => {
  const cases: Array<[string, number, number, number]> = [
    ["4:35pm", 16, 35, 0],
    ["4:35 pm", 16, 35, 0],
    ["4:35PM", 16, 35, 0],
    ["4:35 P.M.", 16, 35, 0],
    ["4:35a.m.", 4, 35, 0],
    ["4pm", 16, 0, 0],
    ["4 pm", 16, 0, 0],
    ["9am", 9, 0, 0],
    ["12am", 0, 0, 0],
    ["12:30am", 0, 30, 0],
    ["12pm", 12, 0, 0],
    ["11:59:30pm", 23, 59, 30],
    ["16:35", 16, 35, 0],
    ["04:35", 4, 35, 0],
    ["0:30", 0, 30, 0],
    ["00:00", 0, 0, 0],
    ["12:30", 12, 30, 0],
    ["23:59:59", 23, 59, 59],
    ["noon", 12, 0, 0],
    ["Midnight", 0, 0, 0],
  ];
  for (const [spec, hour, minute, second] of cases) {
    assert.deepEqual(
      parseAtRequest(`${spec} go`),
      { when: { kind: "clock", hour, minute, second }, prompt: "go" },
      spec,
    );
  }
});

test("keeps the prompt verbatim apart from surrounding whitespace", () => {
  assert.deepEqual(parseAtRequest("  4h   first line\n  second line  \n"), {
    when: { kind: "delay", ms: 4 * HOUR },
    prompt: "first line\n  second line",
  });
  assert.equal(parseAtRequest("4:35pm\n/review   the diff").prompt, "/review   the diff");
});

test("rejects missing, ambiguous, and malformed times with a specific reason", () => {
  const cases: Array<[string, RegExp]> = [
    ["", /^Usage: \/at <time> <prompt>/],
    ["4h", /^Missing prompt after "4h"/],
    ["4h   \n ", /^Missing prompt after "4h"/],
    ["4:35 pm", /^Missing prompt after "4:35 pm"/],
    ["5 do it", /^"5" needs a unit or am\/pm/],
    ["4:35 go", /^Ambiguous time "4:35"/],
    ["10:30 go", /^Ambiguous time "10:30"/],
    ["13:00pm go", /^Invalid time "13:00pm"/],
    ["0am go", /^Invalid time "0am"/],
    ["24:00 go", /^Invalid time "24:00"/],
    ["4:60pm go", /^Invalid time "4:60pm"/],
    ["16:35:60 go", /^Invalid time "16:35:60"/],
    ["0h go", /^Delay must be greater than zero/],
    ["0 minutes go", /^Delay must be greater than zero/],
    ["4:5pm go", /^Unrecognized time "4:5pm"/],
    ["tomorrow go", /^Unrecognized time "tomorrow"/],
    ["1e3h go", /^Unrecognized time "1e3h"/],
    ["4x go", /^Unrecognized time "4x"/],
    ["-4h go", /^Unrecognized time "-4h"/],
    ["1h30 go", /^Unrecognized time "1h30"/],
  ];
  for (const [args, message] of cases) {
    assert.throws(() => parseAtRequest(args), { name: "AtInputError", message }, JSON.stringify(args));
  }
});

test("resolves a delay from the current instant", () => {
  const now = Date.parse("2026-10-28T13:00:00.250-07:00");
  assert.equal(resolveDueAt({ kind: "delay", ms: 4 * HOUR }, now), Date.parse("2026-10-28T17:00:00.250-07:00"));
});

test("resolves a clock time to its next local occurrence", () => {
  const cases: Array<[string, { hour: number; minute: number; second: number }, string]> = [
    ["2026-10-28T13:00:00-07:00", { hour: 16, minute: 35, second: 0 }, "2026-10-28T16:35:00-07:00"],
    ["2026-10-28T17:00:00-07:00", { hour: 16, minute: 35, second: 0 }, "2026-10-29T16:35:00-07:00"],
    // A time equal to now is in the past by the time anything could be sent.
    ["2026-10-28T16:35:00-07:00", { hour: 16, minute: 35, second: 0 }, "2026-10-29T16:35:00-07:00"],
    ["2026-10-28T23:00:00-07:00", { hour: 0, minute: 0, second: 0 }, "2026-10-29T00:00:00-07:00"],
    // Wall-clock time survives the fall-back transition on 2026-11-01 (25-hour day).
    ["2026-10-31T17:00:00-07:00", { hour: 16, minute: 35, second: 0 }, "2026-11-01T16:35:00-08:00"],
    // 2:30am does not exist on 2026-03-08; the next valid instant is 3:30am PDT.
    ["2026-03-07T20:00:00-08:00", { hour: 2, minute: 30, second: 0 }, "2026-03-08T03:30:00-07:00"],
    // Once today's skipped 2:30am has passed, tomorrow's 2:30am exists and is the answer.
    ["2026-03-08T04:00:00-07:00", { hour: 2, minute: 30, second: 0 }, "2026-03-09T02:30:00-07:00"],
  ];
  for (const [nowText, clock, expected] of cases) {
    assert.equal(
      new Date(resolveDueAt({ kind: "clock", ...clock }, Date.parse(nowText))).toISOString(),
      new Date(expected).toISOString(),
      `${nowText} -> ${expected}`,
    );
  }
});

test("rejects delays beyond the representable date range", () => {
  assert.throws(() => resolveDueAt({ kind: "delay", ms: 1e20 }, Date.now()), {
    name: "AtInputError",
    message: /^Time is too far in the future/,
  });
});

test("refuses prompts that Pi would not run as typed", () => {
  const commands = new Set(["review", "skill:tidy", "at"]);
  for (const prompt of ["/compact", "/compact keep the API notes", "/new", "/reload", "/model gpt"]) {
    assert.throws(() => assertDeliverable(prompt, commands), { name: "AtInputError", message: /is a built-in Pi command/ }, prompt);
  }
  for (const prompt of ["!make test", "!!make test"]) {
    assert.throws(() => assertDeliverable(prompt, commands), { name: "AtInputError", message: /^Shell commands/ }, prompt);
  }
  for (const prompt of ["/review the diff", "/skill:tidy", "/at 1h again", "/usr/bin/env is odd", "explain /compact"]) {
    assert.doesNotThrow(() => assertDeliverable(prompt, commands), prompt);
  }
  // A registered extension command with a built-in's name is what sendUserMessage dispatches.
  assert.doesNotThrow(() => assertDeliverable("/compact", new Set(["compact"])));
});

test("guards exactly the built-in commands of the Pi version under test", async () => {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { BUILTIN_SLASH_COMMANDS } = (await import(new URL("./core/slash-commands.js", entry).href)) as {
    BUILTIN_SLASH_COMMANDS: ReadonlyArray<{ name: string }>;
  };
  assert.deepEqual([...BUILTIN_COMMANDS].sort(), BUILTIN_SLASH_COMMANDS.map(({ name }) => name).sort());
});
