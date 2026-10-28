/** A user-facing problem with `/at` input; anything else thrown is a bug. */
export class AtInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtInputError";
  }
}

export type When =
  | { kind: "delay"; ms: number }
  | { kind: "clock"; hour: number; minute: number; second: number };

export type AtRequest = { when: When; prompt: string };

export const USAGE = [
  "Usage: /at <time> <prompt>",
  "  /at 4h <prompt>        send after a delay: 90s, 30m, 1h30m, 1.5h, 2d",
  "  /at 4:35pm <prompt>    send at the next 4:35pm (also 16:35, noon, midnight)",
  "  /at                    list scheduled prompts",
  "  /at cancel <id|all>    cancel scheduled prompts",
].join("\n");

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS = new Map<string, number>([
  ["s", SECOND], ["sec", SECOND], ["secs", SECOND], ["second", SECOND], ["seconds", SECOND],
  ["m", MINUTE], ["min", MINUTE], ["mins", MINUTE], ["minute", MINUTE], ["minutes", MINUTE],
  ["h", HOUR], ["hr", HOUR], ["hrs", HOUR], ["hour", HOUR], ["hours", HOUR],
  ["d", DAY], ["day", DAY], ["days", DAY],
]);

// Longest spellings first, so "1hrs" reads as one part rather than failing after "1h".
const UNIT = [...UNITS.keys()].sort((a, b) => b.length - a.length).join("|");
const NUMBER = String.raw`\d+(?:\.\d+)?`;
const MERIDIEM = String.raw`[ap]\.?m\.?`;
const DELAY_TOKEN = new RegExp(`^(?:${NUMBER}(?:${UNIT}))+$`, "i");
const DELAY_PART = new RegExp(`(${NUMBER})(${UNIT})`, "gi");
const NUMBER_TOKEN = new RegExp(`^${NUMBER}$`);
const UNIT_TOKEN = new RegExp(`^(?:${UNIT})$`, "i");
const MERIDIEM_TOKEN = new RegExp(`^${MERIDIEM}$`, "i");
const CLOCK_TOKEN = new RegExp(String.raw`^(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?(${MERIDIEM})?$`, "i");
const NAMED_TIMES = new Map([
  ["noon", 12],
  ["midnight", 0],
]);

type Token = { value: string; start: number; end: number };

function tokenAt(text: string, from: number): Token | undefined {
  const pattern = /\S+/g;
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match === null ? undefined : { value: match[0], start: match.index, end: match.index + match[0].length };
}

function unitMs(unit: string): number {
  return UNITS.get(unit.toLowerCase()) ?? Number.NaN;
}

function delayTokenMs(token: string): number {
  let total = 0;
  for (const [, amount, unit] of token.matchAll(DELAY_PART)) total += Number(amount) * unitMs(unit!);
  return total;
}

function clockTime(spec: string, hourText: string, minuteText = "00", secondText = "00", meridiem?: string): When {
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (meridiem === undefined) {
    if (hour > 23 || minute > 59 || second > 59) throw new AtInputError(`Invalid time "${spec}"`);
    // 1:00-11:59 reads differently on 12- and 24-hour clocks; a leading zero marks a 24-hour time.
    if (hour >= 1 && hour <= 11 && !hourText.startsWith("0")) {
      const rest = spec.slice(hourText.length);
      throw new AtInputError(
        `Ambiguous time "${spec}": write ${spec}am, ${spec}pm, or a 24-hour time such as ` +
          `${String(hour).padStart(2, "0")}${rest} or ${hour + 12}${rest}`,
      );
    }
    return { kind: "clock", hour, minute, second };
  }
  if (hour < 1 || hour > 12 || minute > 59 || second > 59) throw new AtInputError(`Invalid time "${spec}"`);
  const pm = meridiem.toLowerCase().startsWith("p");
  return { kind: "clock", hour: (hour % 12) + (pm ? 12 : 0), minute, second };
}

/**
 * Split `/at` arguments into a time and the prompt. The time is a delay made of one or more
 * `<number><unit>` parts (`4h`, `1h30m`, `1h 30m`, `90 minutes`) or a clock time (`4:35pm`,
 * `4:35 pm`, `16:35`, `noon`). Everything after it is the prompt, kept verbatim apart from the
 * surrounding whitespace.
 */
export function parseAtRequest(args: string): AtRequest {
  const first = tokenAt(args, 0);
  if (first === undefined) throw new AtInputError(USAGE);

  let when: When;
  let last = first;
  const second = tokenAt(args, first.end);
  if (NUMBER_TOKEN.test(first.value)) {
    if (second !== undefined && UNIT_TOKEN.test(second.value)) {
      when = { kind: "delay", ms: Number(first.value) * unitMs(second.value) };
      last = second;
    } else if (second !== undefined && MERIDIEM_TOKEN.test(second.value) && /^\d{1,2}$/.test(first.value)) {
      when = clockTime(`${first.value} ${second.value}`, first.value, undefined, undefined, second.value);
      last = second;
    } else {
      throw new AtInputError(
        `"${first.value}" needs a unit or am/pm: for example ${first.value}m, ${first.value}h, or ${first.value}pm`,
      );
    }
  } else if (DELAY_TOKEN.test(first.value)) {
    when = { kind: "delay", ms: delayTokenMs(first.value) };
  } else {
    const clock = CLOCK_TOKEN.exec(first.value);
    const named = NAMED_TIMES.get(first.value.toLowerCase());
    if (clock !== null) {
      const [, hourText, minuteText, secondText, attached] = clock;
      const separate = attached === undefined && second !== undefined && MERIDIEM_TOKEN.test(second.value);
      if (separate) last = second;
      const spec = separate ? `${first.value} ${second.value}` : first.value;
      when = clockTime(spec, hourText!, minuteText, secondText, separate ? second.value : attached);
    } else if (named !== undefined) {
      when = { kind: "clock", hour: named, minute: 0, second: 0 };
    } else {
      throw new AtInputError(`Unrecognized time "${first.value}"\n${USAGE}`);
    }
  }

  if (when.kind === "delay") {
    // Further delay parts extend the delay: "1h 30m", "1 hour 30 minutes".
    for (;;) {
      const next = tokenAt(args, last.end);
      if (next === undefined) break;
      if (DELAY_TOKEN.test(next.value)) {
        when = { kind: "delay", ms: when.ms + delayTokenMs(next.value) };
        last = next;
        continue;
      }
      const unit = NUMBER_TOKEN.test(next.value) ? tokenAt(args, next.end) : undefined;
      if (unit === undefined || !UNIT_TOKEN.test(unit.value)) break;
      when = { kind: "delay", ms: when.ms + Number(next.value) * unitMs(unit.value) };
      last = unit;
    }
    when = { kind: "delay", ms: Math.round(when.ms) };
    if (!(when.ms > 0)) throw new AtInputError("Delay must be greater than zero");
  }

  const prompt = args.slice(last.end).trim();
  if (prompt.length === 0) throw new AtInputError(`Missing prompt after "${args.slice(first.start, last.end)}"\n${USAGE}`);
  return { when, prompt };
}

/** The instant a request is due: after the delay, or at the next local occurrence of the clock time. */
export function resolveDueAt(when: When, now: number): number {
  let dueAt: number;
  if (when.kind === "delay") {
    dueAt = now + when.ms;
  } else {
    const target = new Date(now);
    target.setHours(when.hour, when.minute, when.second, 0);
    if (target.getTime() <= now) {
      // Re-applying the time of day keeps the wall-clock time across a DST change.
      target.setDate(target.getDate() + 1);
      target.setHours(when.hour, when.minute, when.second, 0);
    }
    dueAt = target.getTime();
  }
  if (Number.isNaN(new Date(dueAt).getTime())) throw new AtInputError("Time is too far in the future");
  return dueAt;
}

/** Pi's built-in commands, which its editor runs before a prompt is ever submitted. */
export const BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
  "settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy",
  "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new",
  "compact", "resume", "reload", "quit",
]);

/**
 * Reject prompts that would not do what typing them does. An extension sends prompts through
 * `pi.sendUserMessage()`, which runs extension commands, prompt templates, and skills, but would
 * hand built-in commands and `!` shell commands to the model as plain text.
 */
export function assertDeliverable(prompt: string, commands: ReadonlySet<string>): void {
  if (prompt.startsWith("!")) {
    throw new AtInputError(
      "Shell commands (!cmd) cannot be scheduled; ask the agent to run one instead, for example: /at 1h run make test",
    );
  }
  const name = /^\/(\S+)/.exec(prompt)?.[1];
  if (name !== undefined && !commands.has(name) && BUILTIN_COMMANDS.has(name)) {
    throw new AtInputError(
      `/${name} is a built-in Pi command, which runs only when typed; scheduled prompts can use ` +
        "prompt templates, skills, and extension commands",
    );
  }
}
