/** Custom session entry type holding a snapshot of the pending jobs. */
export const RECORD_TYPE = "pi-at/jobs";

export type AtJob = { id: number; dueAt: number; prompt: string };

/** The complete pending set after a change; the latest record in the session file wins. */
export type AtRecord = { version: 1; nextId: number; jobs: AtJob[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function parseJob(value: unknown, nextId: number): AtJob | undefined {
  if (!isObject(value)) return undefined;
  const { id, dueAt, prompt } = value;
  if (!isPositiveInteger(id) || id >= nextId) return undefined;
  if (typeof dueAt !== "number" || Number.isNaN(new Date(dueAt).getTime())) return undefined;
  if (typeof prompt !== "string" || prompt.length === 0) return undefined;
  return { id, dueAt, prompt };
}

/** Validate a stored snapshot; undefined means it cannot be restored safely. */
export function parseAtRecord(value: unknown): AtRecord | undefined {
  if (!isObject(value) || value.version !== 1) return undefined;
  const { nextId, jobs } = value;
  if (!isPositiveInteger(nextId) || !Array.isArray(jobs)) return undefined;

  const parsed: AtJob[] = [];
  const ids = new Set<number>();
  for (const entry of jobs) {
    const job = parseJob(entry, nextId);
    if (job === undefined || ids.has(job.id)) return undefined;
    ids.add(job.id);
    parsed.push(job);
  }
  return { version: 1, nextId, jobs: parsed };
}
