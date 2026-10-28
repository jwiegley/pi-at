import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createPiAt, STATUS_KEY } from "../index.ts";
import { RECORD_TYPE } from "../src/record.ts";
import { FakeClock } from "./support/clock.ts";
import { createTestHost, type TestHost } from "./support/host.ts";

process.env.TZ = "America/Los_Angeles";

const HOUR = 3_600_000;
const START = Date.parse("2026-10-28T13:00:00-07:00");

function recordingUi() {
  const ui = {
    notifications: [] as Array<{ message: string; type: string | undefined }>,
    statuses: new Map<string, string | undefined>(),
    editorText: "",
    get messages() {
      return this.notifications.map(({ message }) => message);
    },
    get status() {
      return this.statuses.get(STATUS_KEY);
    },
    context: undefined as unknown as ExtensionUIContext,
  };
  ui.context = {
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
    onTerminalInput: () => () => {},
  } as unknown as ExtensionUIContext;
  return ui;
}

function userText(message: Message | undefined): string {
  if (message?.role !== "user") return "";
  const { content } = message;
  return typeof content === "string"
    ? content
    : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** Answer each model request, recording the user prompt it was given. */
function recordPrompts(host: TestHost, count: number): string[] {
  const prompts: string[] = [];
  host.faux.setResponses(
    Array.from({ length: count }, () => (context: { messages: Message[] }) => {
      prompts.push(userText(context.messages.at(-1)));
      return fauxAssistantMessage("done");
    }),
  );
  return prompts;
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function startHost(prompts?: Record<string, string>) {
  const clock = new FakeClock(START);
  const host = await createTestHost([{ name: "pi-at", factory: createPiAt({ clock }) }], {
    extensionPaths: [],
    ...(prompts === undefined ? {} : { prompts }),
  });
  const ui = recordingUi();
  await host.session.bindExtensions({ mode: "tui", uiContext: ui.context });
  return { clock, host, ui };
}

test("loads the packaged extension without errors", async () => {
  const host = await createTestHost();
  try {
    assert.deepEqual(host.extensionsResult.errors, []);
    const path = fileURLToPath(new URL("../index.ts", import.meta.url));
    const extension = host.extensionsResult.extensions.find((candidate) => candidate.resolvedPath === path);
    assert.ok(extension?.commands.has("at"));
  } finally {
    host.cleanup();
  }
});

test("a scheduled prompt reaches the model when it falls due", async () => {
  const { clock, host, ui } = await startHost();
  const asked = recordPrompts(host, 1);
  try {
    await host.session.prompt("/at 1h summarize the build log");
    assert.equal(ui.messages.at(-1), "Scheduled #1 for 2:00pm (in 1h): summarize the build log");
    assert.equal(ui.status, "◷ at 2:00pm");
    assert.equal(host.faux.state.callCount, 0);

    clock.advance(HOUR - 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(host.faux.state.callCount, 0);
    clock.advance(1);
    await waitFor(() => asked.length === 1, "the scheduled prompt");
    await host.session.waitForIdle();
    assert.deepEqual(asked, ["summarize the build log"]);
    assert.equal(ui.status, undefined);
  } finally {
    host.cleanup();
  }
});

test("scheduled prompts survive a real /reload on upstream Pi's session history", async () => {
  const { clock, host, ui } = await startHost();
  const asked = recordPrompts(host, 1);
  try {
    // Upstream Pi lacks the fork's indexed lookup, so this exercises the full-history scan.
    assert.equal("getLatestCustomEntry" in host.sessionManager, false);
    await host.session.prompt("/at 1h after the reload");
    await host.session.prompt("/at 2h cancelled before the reload");
    await host.session.prompt("/at cancel 2");
    await host.session.reload();
    assert.equal(ui.messages.at(-1), "Restored 1 scheduled prompt; next at 2:00pm");

    clock.advance(HOUR);
    await waitFor(() => asked.length === 1, "the restored prompt");
    await host.session.waitForIdle();
    assert.deepEqual(asked, ["after the reload"]);
    clock.advance(2 * HOUR);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(host.faux.state.callCount, 1);
  } finally {
    host.cleanup();
  }
});

test("scheduled templates and extension commands run as if typed", async () => {
  const { clock, host, ui } = await startHost({ "review.md": "Review $@ for regressions." });
  const asked = recordPrompts(host, 2);
  try {
    await host.session.prompt("/at 1h /review the parser");
    await host.session.prompt("/at 2h /at 1h nested follow-up");

    clock.advance(HOUR);
    await waitFor(() => asked.length === 1, "the template prompt");
    await host.session.waitForIdle();
    assert.deepEqual(asked, ["Review the parser for regressions."]);

    clock.advance(HOUR);
    await waitFor(() => ui.messages.includes("Scheduled #3 for 4:00pm (in 1h): nested follow-up"), "the nested /at");
    assert.equal(host.faux.state.callCount, 1);
    // Pi's TUI replaces consecutive notices, so a command's own output must come last.
    assert.deepEqual(ui.messages.slice(-2), [
      "Sending scheduled prompt #2: /at 1h nested follow-up",
      "Scheduled #3 for 4:00pm (in 1h): nested follow-up",
    ]);

    clock.advance(HOUR);
    await waitFor(() => asked.length === 2, "the nested prompt");
    await host.session.waitForIdle();
    assert.deepEqual(asked, ["Review the parser for regressions.", "nested follow-up"]);
  } finally {
    host.cleanup();
  }
});

test("refuses built-in commands using the live command list", async () => {
  const { host, ui } = await startHost();
  try {
    await host.session.prompt("/at 1h /compact");
    assert.deepEqual(ui.notifications.at(-1)?.type, "error");
    assert.match(ui.messages.at(-1)!, /^\/compact is a built-in Pi command/);
    const records = host.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === RECORD_TYPE);
    assert.deepEqual(records, []);
  } finally {
    host.cleanup();
  }
});
