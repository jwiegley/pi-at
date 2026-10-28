import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { formatDuration, formatWhen, preview } from "./src/format.ts";
import { AtInputError, USAGE, assertDeliverable, parseAtRequest, resolveDueAt } from "./src/parse.ts";
import { RECORD_TYPE, parseAtRecord, type AtJob, type AtRecord } from "./src/record.ts";

export const STATUS_KEY = "pi-at";
/** Longest timer wait. Each wake re-reads the wall clock, so sleep or a clock change delays a prompt by at most this. */
export const MAX_WAIT_MS = 30_000;
/** How long a sent prompt may leave Pi idle before it counts as rejected; Pi starts runs far sooner. */
export const DISPATCH_GRACE_MS = 5_000;
/** How often a due or starting prompt re-checks Pi's state. */
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
  /** Written into every record, so the copies a fork or clone inherits are recognizably foreign. */
  id: string;
  jobs: Map<number, AtJob>;
  nextId: number;
  status: string | undefined;
  cancelTimer: (() => void) | undefined;
  /** A sent prompt whose run has not started; Pi can still reject it. */
  sending: { job: AtJob; at: number } | undefined;
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

/** The newest record anywhere in the session file: prompts belong to the session, not to a branch. */
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
      const record: AtRecord = { version: 1, sessionId: s.id, nextId: s.nextId, jobs: sortedJobs(s) };
      pi.appendEntry(RECORD_TYPE, record);
    };

    /** Return unsent prompts to the user: into the editor in the TUI, in full elsewhere. */
    const handBack = (s: Session, jobs: AtJob[], reason: string, type: "warning" | "error" = "warning"): void => {
      const now = clock.now();
      const its = jobs.length === 1 ? "its" : "their";
      if (s.ctx.mode === "tui") {
        restoreToEditor(s.ctx.ui, jobs.map(({ prompt }) => prompt).join("\n\n"));
        const rows = jobs.map((job) => `#${job.id} due ${formatWhen(job.dueAt, now)}: ${preview(job.prompt)}`);
        s.ctx.ui.notify([`${reason}; ${its} text is in the editor:`, ...rows].join("\n"), type);
      } else {
        // An RPC client cannot report its editor's contents, so setting them could destroy a draft.
        const rows = jobs.map((job) => `#${job.id} due ${formatWhen(job.dueAt, now)}:\n${job.prompt}`);
        s.ctx.ui.notify([`${reason}; ${its} text follows:`, ...rows].join("\n"), type);
      }
    };

    /** Show the next due prompt in the footer and wake when there is something to do. */
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
      if (next === undefined && s.sending === undefined) return;
      const wait = next === undefined ? Number.POSITIVE_INFINITY : next.dueAt - now;
      const delay = s.sending !== undefined || wait <= 0 ? BUSY_RETRY_MS : Math.min(wait, MAX_WAIT_MS);
      s.cancelTimer = clock.schedule(() => wake(s), delay);
    };

    const stop = (): Session | undefined => {
      const s = session;
      session = undefined;
      s?.cancelTimer?.();
      return s;
    };

    const wake = (s: Session): void => {
      s.cancelTimer = undefined;
      try {
        pump(s);
      } catch (error) {
        // A timer callback that throws would take Pi down; stop this session's prompts instead.
        if (session === s) stop();
        try {
          s.ctx.ui.setStatus(STATUS_KEY, undefined);
          s.ctx.ui.notify(`Scheduled prompts stopped: ${describeError(error)}; /reload restarts them`, "error");
        } catch {
          // The session's UI is already gone.
        }
      }
    };

    /** Extension commands run inside sendUserMessage(); anything else proves itself by starting a run. */
    const isExtensionCommand = (prompt: string): boolean => {
      const name = /^\/(\S+)/.exec(prompt)?.[1];
      return name !== undefined && pi.getCommands().some((command) => command.source === "extension" && command.name === name);
    };

    const dispatch = (s: Session, job: AtJob, now: number): void => {
      // Record the send first: a prompt is delivered at most once, even if Pi stops right after.
      s.jobs.delete(job.id);
      persist(s);
      // Announce first: an extension command runs inside sendUserMessage(), and Pi's TUI replaces
      // consecutive notices, so the command's own output must come after this one.
      s.ctx.ui.notify(`Sending scheduled prompt #${job.id}: ${preview(job.prompt)}`, "info");
      if (!isExtensionCommand(job.prompt)) s.sending = { job, at: now };
      try {
        pi.sendUserMessage(job.prompt, { deliverAs: "followUp", expandPromptTemplates: true });
      } catch (error) {
        s.sending = undefined;
        handBack(s, [job], `1 scheduled prompt was not sent (${describeError(error)})`, "error");
      }
    };

    /**
     * Send the earliest due prompt once Pi is idle, one at a time: Pi reports idle until a sent
     * prompt's run starts, and it rejects a prompt (no model, expired login) only by reporting an
     * error, so a sent prompt that leaves Pi idle past the grace period is handed back.
     */
    const pump = (s: Session): void => {
      if (session !== s) return;
      const now = clock.now();
      if (s.sending !== undefined && now - s.sending.at >= DISPATCH_GRACE_MS && s.ctx.isIdle()) {
        const { job } = s.sending;
        s.sending = undefined;
        handBack(s, [job], "1 scheduled prompt did not start");
      }
      const [next] = sortedJobs(s);
      if (s.sending === undefined && next !== undefined && next.dueAt <= now && s.ctx.isIdle()) dispatch(s, next, now);
      refresh(s);
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
        if (s === undefined) throw new Error("/at is not running in this session; /reload restarts it");
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

      const s: Session = {
        ctx,
        id: ctx.sessionManager.getSessionId(),
        jobs: new Map(),
        nextId: 1,
        status: undefined,
        cancelTimer: undefined,
        sending: undefined,
      };
      session = s;
      const entry = latestRecordEntry(ctx.sessionManager);
      if (entry !== undefined) {
        const record = entry.type === "custom" ? parseAtRecord(entry.data) : undefined;
        if (record === undefined) {
          ctx.ui.notify("Ignored an unreadable pi-at record; no scheduled prompts were restored", "warning");
        } else if (record.sessionId === s.id) {
          // Otherwise this is a fork or clone holding its parent's records; those prompts stay there.
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
        handBack(s, missed, `Missed ${plural(missed.length, "scheduled prompt")} while this session was closed`);
      }

      const [next] = sortedJobs(s);
      if (next !== undefined) {
        ctx.ui.notify(`Restored ${plural(s.jobs.size, "scheduled prompt")}; next at ${formatWhen(next.dueAt, now)}`, "info");
      }
      pump(s);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      if (stop() !== undefined) ctx.ui.setStatus(STATUS_KEY, undefined);
    });

    pi.on("agent_start", () => {
      if (session === undefined || session.sending === undefined) return;
      session.sending = undefined;
      refresh(session);
    });

    pi.on("agent_settled", (event) => {
      const s = session;
      if (s === undefined) return;
      if (event.aborted) {
        // As Pi does with its own queue, prompts that waited on a run the user stopped go back to them.
        const now = clock.now();
        const due = sortedJobs(s).filter((job) => job.dueAt <= now);
        if (due.length > 0) {
          for (const job of due) s.jobs.delete(job.id);
          persist(s);
          handBack(s, due, `Held ${plural(due.length, "due scheduled prompt")} because the run was stopped`);
        }
      }
      pump(s);
    });
  };
}

export default createPiAt();
