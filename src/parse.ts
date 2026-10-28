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
type DelayPart = { ms: number; unit: number };

function tokenAt(text: string, from: number): Token | undefined {
  const pattern = /\S+/g;
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match === null ? undefined : { value: match[0], start: match.index, end: match.index + match[0].length };
}

/** The token after `from`, unless a line break comes first: later lines belong to the prompt. */
function nextOnLine(text: string, from: number): Token | undefined {
  const token = tokenAt(text, from);
  return token === undefined || text.slice(from, token.start).includes("\n") ? undefined : token;
}

function unitMs(unit: string): number {
  return UNITS.get(unit.toLowerCase()) ?? Number.NaN;
}

function delayPart(amount: string, unit: string): DelayPart {
  return { ms: Number(amount) * unitMs(unit), unit: unitMs(unit) };
}

function delayParts(token: string): DelayPart[] {
  return [...token.matchAll(DELAY_PART)].map(([, amount, unit]) => delayPart(amount!, unit!));
}

/**
 * Extend a delay with further parts in strictly smaller units on the same line, as in "1h 30m"
 * or "1 hour 30 minutes"; anything else starts the prompt, as in "2h 3d printer status".
 */
function readDelay(text: string, parts: DelayPart[], last: Token): { when: When; last: Token } {
  let smallest = Math.min(...parts.map(({ unit }) => unit));
  let total = parts.reduce((sum, { ms }) => sum + ms, 0);
  for (;;) {
    const next = nextOnLine(text, last.end);
    if (next === undefined) break;
    let more: DelayPart[];
    let end = next;
    if (DELAY_TOKEN.test(next.value)) {
      more = delayParts(next.value);
    } else {
      const unit = NUMBER_TOKEN.test(next.value) ? nextOnLine(text, next.end) : undefined;
      if (unit === undefined || !UNIT_TOKEN.test(unit.value)) break;
      more = [delayPart(next.value, unit.value)];
      end = unit;
    }
    if (Math.max(...more.map(({ unit }) => unit)) >= smallest) break;
    smallest = Math.min(...more.map(({ unit }) => unit));
    total += more.reduce((sum, { ms }) => sum + ms, 0);
    last = end;
  }
  const ms = Math.round(total);
  if (!(ms > 0)) throw new AtInputError("Delay must be greater than zero");
  return { when: { kind: "delay", ms }, last };
}

/** Explain a number given without a unit, suggesting only forms that parse. */
function bareNumberError(text: string): AtInputError {
  const value = Number(text);
  if (Number.isInteger(value) && value >= 1 && value <= 12) {
    return new AtInputError(`"${text}" needs a unit or am/pm: for example ${text}m, ${text}h, or ${text}pm`);
  }
  if (Number.isInteger(value) && value >= 13 && value <= 23) {
    return new AtInputError(`"${text}" needs a unit or minutes: for example ${text}m, ${text}h, or ${text}:00`);
  }
  if (value === 0) return new AtInputError(`"${text}" needs minutes: for example ${text}:00`);
  return new AtInputError(`"${text}" needs a unit: for example ${text}m or ${text}h`);
}

function clockTime(spec: string, hourText: string, minuteText = "00", secondText = "00", meridiem?: string): When {
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (meridiem === undefined) {
    if (hour > 23 || minute > 59 || second > 59) throw new AtInputError(`Invalid time "${spec}"`);
    // 1:00-11:59 reads differently on 12- and 24-hour clocks; a leading zero marks a 24-hour
    // morning time, which 10 and 11 cannot have, so those need am or pm.
    if (hour >= 1 && hour <= 11 && !hourText.startsWith("0")) {
      const rest = spec.slice(hourText.length);
      const twentyFour =
        hour <= 9 ? `a 24-hour time such as 0${hour}${rest} or ${hour + 12}${rest}` : `the 24-hour time ${hour + 12}${rest}`;
      throw new AtInputError(`Ambiguous time "${spec}": write ${spec}am or ${spec}pm, or ${twentyFour}`);
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
 * `4:35 pm`, `16:35`, `noon`), all on the first line. Everything after it is the prompt, kept
 * verbatim apart from the surrounding whitespace.
 */
export function parseAtRequest(args: string): AtRequest {
  const first = tokenAt(args, 0);
  if (first === undefined) throw new AtInputError(USAGE);

  let when: When;
  let last = first;
  const second = nextOnLine(args, first.end);
  if (NUMBER_TOKEN.test(first.value)) {
    if (second !== undefined && UNIT_TOKEN.test(second.value)) {
      ({ when, last } = readDelay(args, [delayPart(first.value, second.value)], second));
    } else if (second !== undefined && MERIDIEM_TOKEN.test(second.value) && /^\d{1,2}$/.test(first.value)) {
      when = clockTime(`${first.value} ${second.value}`, first.value, undefined, undefined, second.value);
      last = second;
    } else {
      throw bareNumberError(first.value);
    }
  } else if (DELAY_TOKEN.test(first.value)) {
    ({ when, last } = readDelay(args, delayParts(first.value), first));
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
