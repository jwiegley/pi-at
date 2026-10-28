import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { formatDuration, formatWhen, preview } from "./src/format.ts";
import { AtInputError, USAGE, assertDeliverable, parseAtRequest, resolveDueAt } from "./src/parse.ts";
import { RECORD_TYPE, parseAtRecord, type AtJob, type AtRecord } from "./src/record.ts";

export const STATUS_KEY = "pi-at";
/** Longest timer wait. Each wake re-reads the wall clock, so sleep or a clock change delays a prompt by at most this. */
export const MAX_WAIT_MS = 30_000;
/** How long a sent prompt may take to start its run before Pi's idle state is trusted again. */
export const DISPATCH_GRACE_MS = 5_000;
/** How often a due prompt re-checks whether Pi has become idle. */
const BUSY_RETRY_MS = 1_000;

export type AtClock = {
  now(): number;
  /** Call `callback` after `delayMs`; the returned function cancels it. */
  schedule(callback: () => void, delayMs: number): () => void;
};

const systemClock: AtClock = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    // A pending prompt never keeps Pi running by itself.
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export type PiAtOptions = { clock?: AtClock };

type Session = {
  ctx: ExtensionContext;
  jobs: Map<number, AtJob>;
  nextId: number;
  status: string | undefined;
  cancelTimer: (() => void) | undefined;
  /** When the last prompt was handed to Pi, until its run starts. */
  dispatchedAt: number | undefined;
};

type Completion = { value: string; label: string; description: string };

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restoreToEditor(ui: ExtensionUIContext, text: string): void {
  const draft = ui.getEditorText();
  ui.setEditorText(draft.length === 0 ? text : `${text}\n\n${draft}`);
}

type SessionHistory = ExtensionContext["sessionManager"] & {
  /** Indexed lookup added by the jwiegley/pi fork, which also deprecates reading the whole history. */
  getLatestCustomEntry?(customType: string, options: { scope: "all" }): SessionEntry | undefined;
};

/** The newest snapshot anywhere in the session file: prompts belong to the session, not to a branch. */
function latestRecordEntry(sessionManager: SessionHistory): SessionEntry | undefined {
  if (sessionManager.getLatestCustomEntry !== undefined) {
    return sessionManager.getLatestCustomEntry(RECORD_TYPE, { scope: "all" });
  }
  const entries = sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === "custom" && entry.customType === RECORD_TYPE) return entry;
  }
  return undefined;
}

function sortedJobs(session: Session): AtJob[] {
  return [...session.jobs.values()].sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
}

export function createPiAt(options: PiAtOptions = {}): (pi: ExtensionAPI) => void {
  const clock = options.clock ?? systemClock;

  return (pi: ExtensionAPI): void => {
    let session: Session | undefined;

    const persist = (s: Session): void => {
      const record: AtRecord = { version: 1, nextId: s.nextId, jobs: sortedJobs(s) };
      pi.appendEntry(RECORD_TYPE, record);
    };

    /** Show the next due prompt in the footer and wake when it is due. */
    const refresh = (s: Session): void => {
      s.cancelTimer?.();
      s.cancelTimer = undefined;
      const now = clock.now();
      const [next, ...rest] = sortedJobs(s);
      const status =
        next === undefined ? undefined : `◷ at ${formatWhen(next.dueAt, now)}${rest.length > 0 ? ` +${rest.length}` : ""}`;
      if (status !== s.status) {
        s.status = status;
        s.ctx.ui.setStatus(STATUS_KEY, status);
      }
      if (next === undefined) return;
      const wait = next.dueAt - now;
      s.cancelTimer = clock.schedule(() => {
        s.cancelTimer = undefined;
        pump(s);
      }, Math.min(wait > 0 ? wait : BUSY_RETRY_MS, MAX_WAIT_MS));
    };

    const dispatch = (s: Session, job: AtJob, now: number): void => {
      // Record the send first: a prompt is delivered at most once, even if Pi stops right after.
      s.jobs.delete(job.id);
      persist(s);
      s.dispatchedAt = now;
      // Announce first: an extension command runs inside sendUserMessage(), and Pi's TUI replaces
      // consecutive notices, so the command's own output must come after this one.
      s.ctx.ui.notify(`Sending scheduled prompt #${job.id}: ${preview(job.prompt)}`, "info");
      try {
        pi.sendUserMessage(job.prompt, { deliverAs: "followUp", expandPromptTemplates: true });
      } catch (error) {
        s.dispatchedAt = undefined;
        restoreToEditor(s.ctx.ui, job.prompt);
        s.ctx.ui.notify(
          `Scheduled prompt #${job.id} was not sent (${describeError(error)}); its text is in the editor`,
          "error",
        );
      }
    };

    /**
     * Send the earliest due prompt once Pi is idle. One at a time: Pi stays idle until a sent
     * prompt's run starts, so a second prompt sent meanwhile would race the first.
     */
    const pump = (s: Session): void => {
      if (session !== s) return;
      const now = clock.now();
      const [next] = sortedJobs(s);
      const starting = s.dispatchedAt !== undefined && now - s.dispatchedAt < DISPATCH_GRACE_MS;
      if (next !== undefined && next.dueAt <= now && !starting && s.ctx.isIdle()) dispatch(s, next, now);
      refresh(s);
    };

    const stop = (): Session | undefined => {
      const s = session;
      session = undefined;
      s?.cancelTimer?.();
      return s;
    };

    const schedule = (s: Session, ui: ExtensionUIContext, args: string): void => {
      const request = parseAtRequest(args);
      assertDeliverable(request.prompt, new Set(pi.getCommands().map(({ name }) => name)));
      const now = clock.now();
      const dueAt = resolveDueAt(request.when, now);
      const job: AtJob = { id: s.nextId, dueAt, prompt: request.prompt };
      s.nextId += 1;
      s.jobs.set(job.id, job);
      persist(s);
      ui.notify(
        `Scheduled #${job.id} for ${formatWhen(dueAt, now)} (in ${formatDuration(dueAt - now)}): ${preview(job.prompt)}`,
        "info",
      );
      refresh(s);
    };

    const list = (s: Session, ui: ExtensionUIContext): void => {
      const jobs = sortedJobs(s);
      if (jobs.length === 0) {
        ui.notify(`No scheduled prompts.\n${USAGE}`, "info");
        return;
      }
      const now = clock.now();
      const rows = jobs.map((job) => {
        const wait = job.dueAt <= now ? "due; waiting for Pi to be idle" : `in ${formatDuration(job.dueAt - now)}`;
        return `#${job.id}  ${formatWhen(job.dueAt, now)} (${wait})  ${preview(job.prompt)}`;
      });
      ui.notify(["Scheduled prompts:", ...rows].join("\n"), "info");
    };

    const cancel = (s: Session, ui: ExtensionUIContext, words: string[]): void => {
      const jobs = sortedJobs(s);
      if (jobs.length === 0) {
        ui.notify("No scheduled prompts to cancel", "info");
        return;
      }
      if (words.length === 0) {
        throw new AtInputError(`Usage: /at cancel <id...|all> (scheduled: ${jobs.map(({ id }) => `#${id}`).join(", ")})`);
      }
      const ids =
        words.length === 1 && words[0]!.toLowerCase() === "all"
          ? jobs.map(({ id }) => id)
          : words.map((word) => {
              const digits = /^#?(\d+)$/.exec(word)?.[1];
              if (digits === undefined) throw new AtInputError(`Not a scheduled prompt id: "${word}"`);
              const id = Number(digits);
              if (!s.jobs.has(id)) throw new AtInputError(`No scheduled prompt #${id}`);
              return id;
            });
      const cancelled = [...new Set(ids)];
      for (const id of cancelled) s.jobs.delete(id);
      persist(s);
      ui.notify(
        cancelled.length === 1 ? `Cancelled scheduled prompt #${cancelled[0]}` : `Cancelled ${cancelled.length} scheduled prompts`,
        "info",
      );
      refresh(s);
    };

    const completions = (s: Session, prefix: string): Completion[] | null => {
      const typed = prefix.toLowerCase();
      let items: Completion[];
      if (/^\S*$/.test(prefix)) {
        items = [
          ...(s.jobs.size > 0 ? [{ value: "cancel ", label: "cancel", description: "Cancel scheduled prompts" }] : []),
          { value: "list", label: "list", description: "List scheduled prompts" },
        ].filter(({ label }) => label.startsWith(typed));
      } else if (/^cancel\s/.test(typed)) {
        const now = clock.now();
        const target = typed.replace(/^cancel\s+/, "cancel ");
        items = [
          ...sortedJobs(s).map((job) => ({
            value: `cancel ${job.id}`,
            label: `#${job.id}`,
            description: `${formatWhen(job.dueAt, now)}  ${preview(job.prompt, 40)}`,
          })),
          { value: "cancel all", label: "all", description: "Cancel every scheduled prompt" },
        ].filter(({ value }) => value.startsWith(target));
      } else {
        items = [];
      }
      return items.length > 0 ? items : null;
    };

    pi.registerCommand("at", {
      description: "Send a prompt later: /at 4h <prompt>, /at 4:35pm <prompt>; /at lists, /at cancel <id|all>",
      getArgumentCompletions: (prefix) => (session === undefined ? null : completions(session, prefix)),
      handler: async (args, ctx) => {
        if (ctx.mode === "print" || ctx.mode === "json") {
          throw new Error(
            `/at needs interactive or RPC mode: Pi exits in ${ctx.mode} mode before a scheduled prompt could be sent`,
          );
        }
        const s = session;
        if (s === undefined) throw new Error("/at is unavailable until the session has started");
        const trimmed = args.trim();
        const [word = "", ...rest] = trimmed.split(/\s+/);
        try {
          if (trimmed === "" || trimmed.toLowerCase() === "list") list(s, ctx.ui);
          else if (word.toLowerCase() === "cancel") cancel(s, ctx.ui, rest);
          else schedule(s, ctx.ui, trimmed);
        } catch (error) {
          if (!(error instanceof AtInputError)) throw error;
          ctx.ui.notify(error.message, "error");
        }
      },
    });

    pi.on("session_start", (event, ctx) => {
      stop();
      // These modes run one prompt and exit, so leave the session's prompts for an interactive run.
      if (ctx.mode === "print" || ctx.mode === "json") return;

      const s: Session = { ctx, jobs: new Map(), nextId: 1, status: undefined, cancelTimer: undefined, dispatchedAt: undefined };
      session = s;
      const entry = latestRecordEntry(ctx.sessionManager);
      if (entry !== undefined) {
        const record = entry.type === "custom" ? parseAtRecord(entry.data) : undefined;
        if (record === undefined) {
          ctx.ui.notify("Ignored an unreadable pi-at record; no scheduled prompts were restored", "warning");
        } else {
          s.nextId = record.nextId;
          for (const job of record.jobs) s.jobs.set(job.id, job);
        }
      }

      // Prompts that fell due during a reload are still wanted. Any others fell due while the
      // session was closed; sending them unannounced could surprise, so hand them back instead.
      const now = clock.now();
      const missed = event.reason === "reload" ? [] : sortedJobs(s).filter((job) => job.dueAt <= now);
      if (missed.length > 0) {
        for (const job of missed) s.jobs.delete(job.id);
        persist(s);
        restoreToEditor(ctx.ui, missed.map(({ prompt }) => prompt).join("\n\n"));
        const header =
          `Missed ${plural(missed.length, "scheduled prompt")} while this session was closed; ` +
          `${missed.length === 1 ? "its" : "their"} text is in the editor:`;
        const rows = missed.map((job) => `#${job.id} due ${formatWhen(job.dueAt, now)}: ${preview(job.prompt)}`);
        ctx.ui.notify([header, ...rows].join("\n"), "warning");
      }

      const [next] = sortedJobs(s);
      if (next !== undefined) {
        ctx.ui.notify(`Restored ${plural(s.jobs.size, "scheduled prompt")}; next at ${formatWhen(next.dueAt, now)}`, "info");
      }
      pump(s);
    });

    pi.on("session_shutdown", (event, ctx) => {
      const s = stop();
      if (s === undefined) return;
      if (s.jobs.size > 0 && (event.reason === "new" || event.reason === "resume" || event.reason === "fork")) {
        ctx.ui.notify(`Paused ${plural(s.jobs.size, "scheduled prompt")} until this session is resumed`, "info");
      }
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });

    pi.on("agent_start", () => {
      if (session !== undefined) session.dispatchedAt = undefined;
    });

    pi.on("agent_settled", () => {
      if (session !== undefined) pump(session);
    });
  };
}

export default createPiAt();
