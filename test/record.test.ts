import assert from "node:assert/strict";
import test from "node:test";

import { parseAtRecord } from "../src/record.ts";

const valid = {
  version: 1,
  nextId: 4,
  jobs: [
    { id: 3, dueAt: Date.parse("2026-10-28T16:35:00-07:00"), prompt: "continue" },
    { id: 1, dueAt: Date.parse("2026-10-29T09:00:00-07:00"), prompt: "check CI\nthen report" },
  ],
};

test("reads a version 1 snapshot as an independent copy", () => {
  const data = structuredClone(valid);
  const record = parseAtRecord({ ...data, future: true, jobs: data.jobs.map((job) => ({ ...job, note: "x" })) });
  assert.deepEqual(record, valid);
  record?.jobs.pop();
  assert.equal(data.jobs.length, 2);
});

test("rejects snapshots that cannot be restored safely", () => {
  const job = valid.jobs[0]!;
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["array", [valid]],
    ["future version", { ...valid, version: 2 }],
    ["zero next id", { ...valid, nextId: 0, jobs: [] }],
    ["fractional next id", { ...valid, nextId: 4.5 }],
    ["jobs not an array", { ...valid, jobs: {} }],
    ["job not an object", { ...valid, jobs: ["continue"] }],
    ["duplicate id", { ...valid, jobs: [job, { ...job, prompt: "again" }] }],
    ["id at next id", { ...valid, jobs: [{ ...job, id: 4 }] }],
    ["zero id", { ...valid, jobs: [{ ...job, id: 0 }] }],
    ["non-numeric due time", { ...valid, jobs: [{ ...job, dueAt: "4:35pm" }] }],
    ["unrepresentable due time", { ...valid, jobs: [{ ...job, dueAt: 1e20 }] }],
    ["empty prompt", { ...valid, jobs: [{ ...job, prompt: "" }] }],
    ["non-string prompt", { ...valid, jobs: [{ ...job, prompt: 7 }] }],
  ];
  for (const [label, value] of cases) assert.equal(parseAtRecord(value), undefined, label);
});

test("accepts an empty snapshot that records cancelled or sent jobs", () => {
  assert.deepEqual(parseAtRecord({ version: 1, nextId: 7, jobs: [] }), { version: 1, nextId: 7, jobs: [] });
});
