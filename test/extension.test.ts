import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiAt, DISPATCH_GRACE_MS, MAX_WAIT_MS, STATUS_KEY, UPSTREAM_LOOKBACK } from "../index.ts";
import { USAGE } from "../src/parse.ts";
import { RECORD_TYPE } from "../src/record.ts";
import { FakeClock } from "./support/clock.ts";

process.env.TZ = "America/Los_Angeles";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const START = Date.parse("2026-10-28T13:00:00-07:00");
const SEND_OPTIONS = { deliverAs: "followUp", expandPromptTemplates: true };

type Entry = { type: "custom"; id: string; parentId: string | null; customType: string; data: unknown };

/** Append to the session file as Pi does: each new entry is a child of the current leaf. */
function append(entries: Entry[], customType: string, data: unknown, id = `entry-${entries.length + 1}`): void {
  entries.push({ type: "custom", id, parentId: entries.at(-1)?.id ?? null, customType, data });
}
type Command = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
  getArgumentCompletions?(prefix: string): unknown;
};
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

type CommandInfo = { name: string; source: "extension" | "prompt" | "skill" };

/** One extension runtime; a reload or session switch replaces it while the session file persists. */
function createRuntime(
  clock: FakeClock,
  entries: Entry[],
  commands: CommandInfo[] = [{ name: "at", source: "extension" }],
) {
  const handlers = new Map<string, Handler[]>();
  const sends: Array<{ content: unknown; options: unknown }> = [];
  let command: Command | undefined;
  let sendError: Error | undefined;
  let appendError: Error | undefined;
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, options: Command) {
      assert.equal(name, "at");
      command = options;
    },
    sendUserMessage(content: unknown, options: unknown) {
      if (sendError !== undefined) {
        const error = sendError;
        sendError = undefined;
        throw error;
      }
      sends.push({ content, options });
    },
    appendEntry(customType: string, data: unknown) {
      if (appendError !== undefined) {
        const error = appendError;
        appendError = undefined;
        throw error;
      }
      append(entries, customType, structuredClone(data));
    },
    getCommands() {
      return commands;
    },
  } as unknown as ExtensionAPI;
  createPiAt({ clock })(api);
  assert.ok(command);
  const registered = command;

  return {
    sends,
    completions: (prefix: string) => registered.getArgumentCompletions?.(prefix),
    run: (args: string, ui: Ui) => registered.handler(args, ui.ctx),
    failNextSend(error: Error) {
      sendError = error;
    },
    failNextAppend(error: Error) {
      appendError = error;
    },
    async emit(event: string, payload: object, ui: Ui) {
      for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ui.ctx);
    },
  };
}

type Runtime = ReturnType<typeof createRuntime>;

/** The jwiegley/pi fork indexes custom entries; upstream Pi only offers the full history. */
function sessionManager(entries: Entry[], history: "indexed" | "upstream", sessionId: string) {
  const getEntries = () => [...entries];
  const getSessionId = () => sessionId;
  if (history === "upstream") {
    // The fork's bounded-history policy forbids reading the whole history on any host.
    const wholeHistory = () => {
      throw new Error("pi-at must not read the whole session history");
    };
    let byId = new Map<string, Entry>();
    return {
      getSessionId,
      getLeafEntry() {
        byId = new Map(entries.map((entry) => [entry.id, entry]));
        return entries.at(-1);
      },
      getEntry: (id: string) => byId.get(id),
      getEntries: wholeHistory,
      getBranch: wholeHistory,
    };
  }
  return {
    getSessionId,
    getEntries() {
      throw new Error("pi-at must use the indexed lookup when the host provides one");
    },
    getLatestCustomEntry(customType: string, options?: { scope?: string }) {
      // Jobs belong to the session, not to the branch that was active when they were scheduled.
      if (options?.scope !== "all") throw new Error("pi-at must restore from the whole session");
      return getEntries().reverse().find((entry) => entry.customType === customType);
    },
  };
}

function createUi(
  entries: Entry[],
  options: {
    mode?: ExtensionContext["mode"];
    editorText?: string;
    history?: "indexed" | "upstream";
    sessionId?: string;
  } = {},
) {
  const mode = options.mode ?? "tui";
  const ui = {
    idle: true,
    editorText: options.editorText ?? "",
    notifications: [] as Array<{ message: string; type: string | undefined }>,
    statuses: new Map<string, string | undefined>(),
    ctx: undefined as unknown as ExtensionCommandContext,
    get status() {
      return this.statuses.get(STATUS_KEY);
    },
    get messages() {
      return this.notifications.map(({ message }) => message);
    },
  };
  ui.ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      notify(message: string, type?: string) {
        ui.notifications.push({ message, type });
      },
      setStatus(key: string, text: string | undefined) {
        ui.statuses.set(key, text);
      },
      getEditorText: () => ui.editorText,
      setEditorText(text: string) {
        ui.editorText = text;
      },
    },
    isIdle: () => ui.idle,
    sessionManager: sessionManager(entries, options.history ?? "indexed", options.sessionId ?? "session-1"),
  } as unknown as ExtensionCommandContext;
  return ui;
}

/** What Pi does once a sent prompt passes its checks. */
async function runStarts(runtime: Runtime, ui: Ui): Promise<void> {
  await runtime.emit("agent_start", {}, ui);
}

type Ui = ReturnType<typeof createUi>;

async function start(options: { reason?: string; editorText?: string; mode?: ExtensionContext["mode"] } = {}) {
  const clock = new FakeClock(START);
  const entries: Entry[] = [];
  const runtime = createRuntime(clock, entries);
  const ui = createUi(entries, options);
  await runtime.emit("session_start", { reason: options.reason ?? "startup" }, ui);
  return { clock, entries, runtime, ui };
}

/** Replace the runtime as /reload, /resume, or a restart does, keeping the session file. */
async function restart(
  clock: FakeClock,
  entries: Entry[],
  old: { runtime: Runtime; ui: Ui },
  reason: "reload" | "resume" | "quit",
  options: { editorText?: string; mode?: ExtensionContext["mode"] } = {},
) {
  await old.runtime.emit("session_shutdown", { reason }, old.ui);
  const runtime = createRuntime(clock, entries);
  const ui = createUi(entries, options);
  await runtime.emit("session_start", { reason: reason === "quit" ? "startup" : reason }, ui);
  return { runtime, ui };
}

test("sends a delayed prompt once it is due", async () => {
  const { clock, runtime, ui } = await start();
  await runtime.run("4h check the build", ui);
  assert.deepEqual(ui.notifications, [
    { message: "Scheduled #1 for 5:00pm (in 4h): check the build", type: "info" },
  ]);
  assert.equal(ui.status, "◷ at 5:00pm");

  clock.advance(4 * HOUR - 1);
  assert.deepEqual(runtime.sends, []);
  clock.advance(1);
  assert.deepEqual(runtime.sends, [{ content: "check the build", options: SEND_OPTIONS }]);
  assert.equal(ui.messages.at(-1), "Sending scheduled prompt #1: check the build");
  assert.equal(ui.status, undefined);

  await runStarts(runtime, ui);
  clock.advance(24 * HOUR);
  assert.equal(runtime.sends.length, 1);
  assert.equal(ui.messages.at(-1), "Sending scheduled prompt #1: check the build");
  assert.equal(ui.editorText, "");
});

test("sends a clock-time prompt at the next occurrence of that time", async () => {
  const { clock, runtime, ui } = await start();
  await runtime.run("4:35pm continue", ui);
  await runtime.run("9am morning review", ui);
  assert.deepEqual(ui.messages, [
    "Scheduled #1 for 4:35pm (in 3h 35m): continue",
    "Scheduled #2 for tomorrow 9:00am (in 20h): morning review",
  ]);
  assert.equal(ui.status, "◷ at 4:35pm +1");

  clock.advance(3 * HOUR + 35 * MINUTE);
  assert.deepEqual(runtime.sends.map(({ content }) => content), ["continue"]);
  assert.equal(ui.status, "◷ at tomorrow 9:00am");
  await runStarts(runtime, ui);
  clock.advance(20 * HOUR - 3 * HOUR - 35 * MINUTE);
  assert.deepEqual(runtime.sends.map(({ content }) => content), ["continue", "morning review"]);
});

test("reports invalid or undeliverable input without scheduling anything", async () => {
  const { clock, entries, runtime, ui } = await start();
  for (const args of ["4:35 go", "soon go", "1h", "1h /compact", "1h !make test"]) await runtime.run(args, ui);
  assert.deepEqual(ui.notifications.map(({ type }) => type), ["error", "error", "error", "error", "error"]);
  assert.match(ui.messages[0]!, /^Ambiguous time "4:35"/);
  assert.match(ui.messages[3]!, /^\/compact is a built-in Pi command/);
  assert.deepEqual(entries, []);
  assert.equal(ui.status, undefined);
  clock.advance(48 * HOUR);
  assert.deepEqual(runtime.sends, []);
});

test("schedules extension commands, which run when sent", async () => {
  const { clock, runtime, ui } = await start();
  await runtime.run("1h /at 1h follow up", ui);
  clock.advance(HOUR);
  assert.deepEqual(runtime.sends, [{ content: "/at 1h follow up", options: SEND_OPTIONS }]);
});

test("holds a due prompt until Pi is idle", async () => {
  const { clock, runtime, ui } = await start();
  await runtime.run("1h continue", ui);
  ui.idle = false;
  clock.advance(HOUR + 10 * MINUTE);
  assert.deepEqual(runtime.sends, []);

  await runtime.run("", ui);
  assert.equal(ui.messages.at(-1), "Scheduled prompts:\n#1  2:00pm (due; waiting for Pi to be idle)  continue");

  ui.idle = true;
  await runtime.emit("agent_settled", { aborted: false }, ui);
  assert.deepEqual(runtime.sends.map(({ content }) => content), ["continue"]);
});

test("sends simultaneous prompts one run at a time", async () => {
  const { clock, runtime, ui } = await start();
  await runtime.run("1h first", ui);
  await runtime.run("1h second", ui);
  clock.advance(HOUR);
  assert.deepEqual(runtime.sends.map(({ content }) => content), ["first"]);

  // Pi has taken the first prompt but still reports idle until its run starts.
  clock.advance(SECOND);
  assert.equal(runtime.sends.length, 1);

  await runtime.emit("agent_start", {}, ui);
  ui.idle = false;
  clock.advance(SECOND);
  assert.equal(runtime.sends.length, 1);

  // A run that ends within the grace period frees the next prompt at once.
  ui.idle = true;
  await runtime.emit("agent_settled", { aborted: false }, ui);
  assert.ok(2 * SECOND < DISPATCH_GRACE_MS);
  assert.deepEqual(runtime.sends.map(({ content }) => content), ["first", "second"]);
});

test("moves straight on after an extension command, which runs as it is sent", async () => {
  const { clock, runtime, ui } = await start();
  await runtime.run("1h /at 2h nested", ui);
  await runtime.run("1h second", ui);
  clock.advance(HOUR);
  assert.equal(runtime.sends.length, 1);
  clock.advance(SECOND);
  assert.deepEqual(runtime.sends.map(({ content }) => content), ["/at 2h nested", "second"]);
  assert.equal(ui.editorText, "");
});

test("hands a prompt back when Pi never starts its run", async () => {
  const clock = new FakeClock(START);
  const entries: Entry[] = [];
  const runtime = createRuntime(clock, entries, [
    { name: "at", source: "extension" },
    { name: "review", source: "prompt" },
  ]);
  const ui = createUi(entries, { editorText: "draft" });
  await runtime.emit("session_start", { reason: "startup" }, ui);
  await runtime.run("1h /review the parser", ui);
  await runtime.run("1h second", ui);

  // Pi takes the prompt, then rejects it before any run starts (no model, expired login).
  clock.advance(HOUR);
  assert.deepEqual(runtime.sends.map(({ content }) => content), ["/review the parser"]);
  clock.advance(DISPATCH_GRACE_MS - 1);
  assert.equal(ui.editorText, "draft");
  assert.equal(runtime.sends.length, 1);

  clock.advance(1);
  assert.equal(ui.editorText, "/review the parser\n\ndraft");
  assert.deepEqual(ui.notifications.slice(-2), [
    {
      message: "1 scheduled prompt did not start; its text is in the editor:\n#1 due 2:00pm: /review the parser",
      type: "warning",
    },
    { message: "Sending scheduled prompt #2: second", type: "info" },
  ]);
  assert.deepEqual(runtime.sends.map(({ content }) => content), ["/review the parser", "second"]);
});

test("re-reads the wall clock so a sleeping machine sends soon after waking", async () => {
  const { clock, runtime, ui } = await start();
  await runtime.run("4h continue", ui);
  clock.advance(10 * SECOND);
  clock.sleep(5 * HOUR);
  clock.advance(MAX_WAIT_MS);
  assert.deepEqual(runtime.sends.map(({ content }) => content), ["continue"]);
});

test("lists pending prompts in due order", async () => {
  const { runtime, ui } = await start();
  await runtime.run("", ui);
  assert.equal(ui.messages.at(-1), `No scheduled prompts.\n${USAGE}`);

  await runtime.run("2h later\nwith detail", ui);
  await runtime.run("1h sooner", ui);
  await runtime.run("list", ui);
  assert.equal(ui.messages.at(-1), "Scheduled prompts:\n#2  2:00pm (in 1h)  sooner\n#1  3:00pm (in 2h)  later with detail");
});

test("cancels prompts by id, by several ids, or all at once", async () => {
  const { clock, runtime, ui } = await start();
  for (const args of ["1h one", "2h two", "3h three", "4h four"]) await runtime.run(args, ui);

  await runtime.run("cancel 2", ui);
  assert.equal(ui.messages.at(-1), "Cancelled scheduled prompt #2");
  await runtime.run("cancel #1 3", ui);
  assert.equal(ui.messages.at(-1), "Cancelled 2 scheduled prompts");
  assert.equal(ui.status, "◷ at 5:00pm");

  for (const args of ["cancel 2", "cancel soon", "cancel"]) await runtime.run(args, ui);
  assert.deepEqual(ui.notifications.slice(-3), [
    { message: "No scheduled prompt #2", type: "error" },
    { message: 'Not a scheduled prompt id: "soon"', type: "error" },
    { message: "Usage: /at cancel <id...|all> (scheduled: #4)", type: "error" },
  ]);

  await runtime.run("cancel all", ui);
  assert.equal(ui.messages.at(-1), "Cancelled scheduled prompt #4");
  assert.equal(ui.status, undefined);
  await runtime.run("cancel all", ui);
  assert.equal(ui.messages.at(-1), "No scheduled prompts to cancel");

  clock.advance(48 * HOUR);
  assert.deepEqual(runtime.sends, []);
});

test("completes subcommands and pending prompt ids", async () => {
  const { runtime, ui } = await start();
  assert.equal(runtime.completions("4h"), null);
  await runtime.run("1h first prompt", ui);
  await runtime.run("2h second", ui);
  assert.deepEqual(runtime.completions("c"), [
    { value: "cancel ", label: "cancel", description: "Cancel scheduled prompts" },
  ]);
  assert.deepEqual(runtime.completions("cancel "), [
    { value: "cancel 1", label: "#1", description: "2:00pm  first prompt" },
    { value: "cancel 2", label: "#2", description: "3:00pm  second" },
    { value: "cancel all", label: "all", description: "Cancel every scheduled prompt" },
  ]);
  assert.deepEqual(runtime.completions("cancel 2"), [
    { value: "cancel 2", label: "#2", description: "3:00pm  second" },
  ]);
});

test("keeps pending prompts across /reload and sends ones that fell due meanwhile", async () => {
  const { clock, entries, runtime, ui } = await start();
  await runtime.run("1h first", ui);
  await runtime.run("3h second", ui);
  await runtime.run("4h third", ui);
  await runtime.run("cancel 3", ui);

  const reloaded = await restart(clock, entries, { runtime, ui }, "reload");
  assert.deepEqual(reloaded.ui.messages, ["Restored 2 scheduled prompts; next at 2:00pm"]);
  assert.equal(reloaded.ui.status, "◷ at 2:00pm +1");
  clock.advance(HOUR);
  assert.deepEqual(runtime.sends, []);
  assert.deepEqual(reloaded.runtime.sends.map(({ content }) => content), ["first"]);

  // A prompt that fell due during a reload is still wanted: send it as soon as Pi is idle.
  await reloaded.runtime.emit("session_shutdown", { reason: "reload" }, reloaded.ui);
  clock.advance(3 * HOUR);
  const again = createRuntime(clock, entries);
  const againUi = createUi(entries);
  await again.emit("session_start", { reason: "reload" }, againUi);
  assert.deepEqual(again.sends.map(({ content }) => content), ["second"]);
  assert.equal(againUi.status, undefined);

  // Sent and cancelled prompts never come back.
  const later = await restart(clock, entries, { runtime: again, ui: againUi }, "reload");
  assert.deepEqual(later.ui.messages, []);
  clock.advance(48 * HOUR);
  assert.deepEqual(later.runtime.sends, []);
});

test("reports prompts that fell due while the session was closed and restores their text", async () => {
  const { clock, entries, runtime, ui } = await start();
  await runtime.run("1h first\nline two", ui);
  await runtime.run("90m second", ui);
  await runtime.run("3h third", ui);
  await runtime.emit("session_shutdown", { reason: "quit" }, ui);
  clock.sleep(2 * HOUR);

  const resumed = createRuntime(clock, entries);
  const resumedUi = createUi(entries, { editorText: "draft" });
  await resumed.emit("session_start", { reason: "startup" }, resumedUi);
  assert.deepEqual(resumedUi.notifications, [
    {
      message:
        "Missed 2 scheduled prompts while this session was closed; their text is in the editor:\n" +
        "#1 due 2:00pm: first line two\n#2 due 2:30pm: second",
      type: "warning",
    },
    { message: "Restored 1 scheduled prompt; next at 4:00pm", type: "info" },
  ]);
  assert.equal(resumedUi.editorText, "first\nline two\n\nsecond\n\ndraft");
  assert.deepEqual(resumed.sends, []);

  clock.advance(HOUR);
  assert.deepEqual(resumed.sends.map(({ content }) => content), ["third"]);

  // Missed prompts are reported once.
  const later = await restart(clock, entries, { runtime: resumed, ui: resumedUi }, "resume");
  assert.deepEqual(later.ui.messages, []);
  assert.equal(later.ui.editorText, "");
});

test("restores on upstream Pi by walking back along the active branch", async () => {
  const { clock, entries, runtime, ui } = await start();
  await runtime.run("1h first", ui);
  await runtime.run("2h second", ui);
  await runtime.run("cancel 1", ui);
  append(entries, "another-extension", {});
  await runtime.emit("session_shutdown", { reason: "reload" }, ui);

  const reloaded = createRuntime(clock, entries);
  const reloadedUi = createUi(entries, { history: "upstream" });
  await reloaded.emit("session_start", { reason: "reload" }, reloadedUi);
  assert.deepEqual(reloadedUi.messages, ["Restored 1 scheduled prompt; next at 3:00pm"]);
  clock.advance(2 * HOUR);
  assert.deepEqual(reloaded.sends.map(({ content }) => content), ["second"]);
});

test("looks back only a bounded distance along the branch on upstream Pi", async () => {
  for (const [later, restored] of [
    [UPSTREAM_LOOKBACK - 1, true],
    [UPSTREAM_LOOKBACK, false],
  ] as const) {
    const { clock, entries, runtime, ui } = await start();
    await runtime.run("1h ping", ui);
    await runtime.emit("session_shutdown", { reason: "reload" }, ui);
    for (let count = 0; count < later; count++) append(entries, "another-extension", {});

    const reloaded = createRuntime(clock, entries);
    const reloadedUi = createUi(entries, { history: "upstream" });
    await reloaded.emit("session_start", { reason: "reload" }, reloadedUi);
    assert.equal(reloadedUi.status, restored ? "◷ at 2:00pm" : undefined, `${later} later entries`);
  }
});

test("leaves prompts in their session when switching to another", async () => {
  const { clock, entries, runtime, ui } = await start();
  await runtime.run("1h first", ui);
  await runtime.run("2h second", ui);
  await runtime.emit("session_shutdown", { reason: "new" }, ui);
  assert.equal(ui.status, undefined);
  clock.advance(90 * MINUTE);
  assert.deepEqual(runtime.sends, []);

  // Returning later: what fell due meanwhile is handed back, the rest resumes.
  const back = createRuntime(clock, entries);
  const backUi = createUi(entries);
  await back.emit("session_start", { reason: "resume" }, backUi);
  assert.deepEqual(backUi.messages, [
    "Missed 1 scheduled prompt while this session was closed; its text is in the editor:\n#1 due 2:00pm: first",
    "Restored 1 scheduled prompt; next at 3:00pm",
  ]);
});

test("never restores prompts that a fork or clone copied from another session", async () => {
  const { clock, entries, runtime, ui } = await start();
  await runtime.run("1h deploy the release branch", ui);
  await runtime.emit("session_shutdown", { reason: "fork" }, ui);

  // A fork's file begins with a copy of the parent's entries, records included.
  const forkEntries = structuredClone(entries);
  const fork = createRuntime(clock, forkEntries);
  const forkUi = createUi(forkEntries, { sessionId: "session-2" });
  await fork.emit("session_start", { reason: "fork" }, forkUi);
  assert.deepEqual(forkUi.notifications, []);
  assert.equal(forkUi.status, undefined);
  clock.advance(2 * HOUR);
  assert.deepEqual(fork.sends, []);

  await fork.run("1h its own prompt", forkUi);
  assert.equal(forkUi.messages.at(-1), "Scheduled #1 for 4:00pm (in 1h): its own prompt");
  assert.equal((forkEntries.at(-1)?.data as { sessionId: string }).sessionId, "session-2");
});

test("hands due prompts back instead of sending them when the user stops a run", async () => {
  const { clock, runtime, ui } = await start({ editorText: "draft" });
  await runtime.run("1h check the deploy", ui);
  await runtime.run("3h later work", ui);
  ui.idle = false;
  clock.advance(HOUR + 10 * MINUTE);

  ui.idle = true;
  await runtime.emit("agent_settled", { aborted: true }, ui);
  assert.deepEqual(runtime.sends, []);
  assert.equal(ui.editorText, "check the deploy\n\ndraft");
  assert.deepEqual(ui.notifications.at(-1), {
    message:
      "Held 1 due scheduled prompt because the run was stopped; its text is in the editor:\n" +
      "#1 due 2:00pm: check the deploy",
    type: "warning",
  });
  clock.advance(MINUTE);
  assert.deepEqual(runtime.sends, []);
  assert.equal(ui.status, "◷ at 4:00pm");
  clock.advance(2 * HOUR);
  assert.deepEqual(runtime.sends.map(({ content }) => content), ["later work"]);
});

test("stops scheduling instead of crashing Pi when a timer task fails", async () => {
  const { clock, runtime, ui } = await start();
  await runtime.run("1h continue", ui);
  await runtime.run("2h later", ui);
  runtime.failNextAppend(new Error("ENOSPC: no space left on device"));
  assert.doesNotThrow(() => clock.advance(HOUR));
  assert.deepEqual(ui.notifications.at(-1), {
    message: "Scheduled prompts stopped: ENOSPC: no space left on device; /reload restarts them",
    type: "error",
  });
  const notices = ui.notifications.length;
  clock.advance(2 * HOUR);
  assert.deepEqual(runtime.sends, []);
  assert.equal(ui.notifications.length, notices);
  await assert.rejects(runtime.run("1h again", ui), /^Error: \/at is not running in this session; \/reload restarts it/);
});

test("reports the full text instead of replacing the draft over RPC, which cannot read the editor", async () => {
  const { clock, entries, runtime, ui } = await start({ mode: "rpc" });
  await runtime.run("1h first\nline two", ui);
  await runtime.emit("session_shutdown", { reason: "quit" }, ui);
  clock.sleep(2 * HOUR);

  const resumed = createRuntime(clock, entries);
  const resumedUi = createUi(entries, { mode: "rpc", editorText: "client draft" });
  await resumed.emit("session_start", { reason: "startup" }, resumedUi);
  assert.equal(resumedUi.editorText, "client draft");
  assert.deepEqual(resumedUi.notifications, [
    {
      message: "Missed 1 scheduled prompt while this session was closed; its text follows:\n#1 due 2:00pm:\nfirst\nline two",
      type: "warning",
    },
  ]);
});

test("ignores an unreadable record and starts fresh", async () => {
  const clock = new FakeClock(START);
  const entries: Entry[] = [{ type: "custom", id: "bad", parentId: null, customType: RECORD_TYPE, data: { version: 99 } }];
  const runtime = createRuntime(clock, entries);
  const ui = createUi(entries);
  await runtime.emit("session_start", { reason: "resume" }, ui);
  assert.deepEqual(ui.notifications, [
    { message: "Ignored an unreadable pi-at record; no scheduled prompts were restored", type: "warning" },
  ]);
  await runtime.run("1h ping", ui);
  assert.equal(ui.messages.at(-1), "Scheduled #1 for 2:00pm (in 1h): ping");
});

test("stays inert in print and JSON modes, which exit before anything is due", async () => {
  for (const mode of ["print", "json"] as const) {
    const clock = new FakeClock(START);
    const entries: Entry[] = [];
    const tui = createRuntime(clock, entries);
    const tuiUi = createUi(entries);
    await tui.emit("session_start", { reason: "startup" }, tuiUi);
    await tui.run("1h ping", tuiUi);
    await tui.emit("session_shutdown", { reason: "quit" }, tuiUi);
    clock.sleep(2 * HOUR);

    const recorded = entries.length;
    const runtime = createRuntime(clock, entries);
    const ui = createUi(entries, { mode });
    await runtime.emit("session_start", { reason: "startup" }, ui);
    await assert.rejects(runtime.run("1h ping", ui), new RegExp(`^Error: /at needs interactive or RPC mode.*${mode}`));
    clock.advance(4 * HOUR);
    assert.deepEqual(runtime.sends, [], mode);
    assert.equal(entries.length, recorded, mode);
    assert.deepEqual(ui.notifications, [], mode);
  }
});

test("restores a prompt to the editor if Pi refuses to take it", async () => {
  const { clock, runtime, ui } = await start({ editorText: "draft" });
  await runtime.run("1h continue", ui);
  runtime.failNextSend(new Error("dispatch unavailable"));
  clock.advance(HOUR);
  assert.deepEqual(runtime.sends, []);
  assert.equal(ui.editorText, "continue\n\ndraft");
  assert.deepEqual(ui.notifications.at(-1), {
    message: "1 scheduled prompt was not sent (dispatch unavailable); its text is in the editor:\n#1 due 2:00pm: continue",
    type: "error",
  });
  clock.advance(HOUR);
  assert.deepEqual(runtime.sends, []);
});
