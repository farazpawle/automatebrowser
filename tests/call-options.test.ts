/**
 * B04 — an option that only affects the REPLY must be validated before the
 * action, not after it.
 *
 * The bug: `include` was parsed at the point of attachment, which is after the
 * handler has run. `include: "consoel"` clicked the button and then returned
 * "Cannot include consoel". An agent reads an error, concludes the action did
 * not happen, and retries — so a typo in an output option quietly became a
 * double click. Nothing about validating a list of section names needs the
 * action to have happened first.
 *
 * The mirror-image failure is in the same code and gets the same attention here:
 * once the action HAS happened, an optional attachment that cannot be fetched is
 * a footnote, never a failure. A click that worked must never be reported as a
 * click that did not, because the console read after it timed out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context } from "@/context";
import type { Tool, ToolResult } from "@/tools/tool";

import { callTool } from "@/tools/call";

/** What the call put on the wire, and whether the handler itself ran. */
interface Recorder {
  context: Context;
  sent: string[];
}

/**
 * A Context with no policy in play, so `include` is the only thing under test.
 * `failing` names the message types that should throw instead of answering.
 */
function recorder(failing: string[] = []): Recorder {
  const r: Recorder = { sent: [], context: undefined as unknown as Context };
  r.context = {
    auditTarget: () => ({}),
    clientName: () => "test",
    ctrlId: () => "test",
    hasClients: () => true,
    takeNotice: () => undefined,
    consoleErrorDelta: async () => 0,
    issuesDelta: async () => 0,
    takeNewConsole: async () => {
      r.sent.push("takeNewConsole");
      if (failing.includes("takeNewConsole")) throw new Error("console read timed out");
      return [{ level: "error", text: "boom" }];
    },
    sendSocketMessage: async (type: string) => {
      r.sent.push(type);
      if (failing.includes(type)) throw new Error(`${type} timed out`);
      if (type === "browser_network_requests") return { requests: [] };
      return {};
    },
  } as unknown as Context;
  return r;
}

/** A mutating tool that records whether it ran — the whole question here. */
function clickStub(): Tool & { ran: number } {
  const t = {
    ran: 0,
    schema: {
      name: "browser_click",
      description: "",
      inputSchema: {},
      annotations: { readOnlyHint: false },
    },
    handle: async (): Promise<ToolResult> => {
      t.ran += 1;
      return { content: [{ type: "text", text: "Clicked" }] };
    },
  } as unknown as Tool & { ran: number };
  return t;
}

const textOf = (r: ToolResult): string =>
  r.content.map((p) => ("text" in p ? p.text : "")).join("\n");

describe("B04 — an invalid include is refused before anything happens", () => {
  it("does not run the handler for a misspelt section", async () => {
    const r = recorder();
    const click = clickStub();

    await assert.rejects(
      () => callTool(r.context, click, { element: "b", ref: "e1", include: "snapshot, consoel" }),
      /consoel/,
    );

    assert.equal(click.ran, 0, "the click must not have happened");
  });

  it("spends no optional probes either", async () => {
    const r = recorder();

    await assert.rejects(() =>
      callTool(r.context, clickStub(), { element: "b", ref: "e1", include: "consoel" }),
    );

    assert.deepEqual(r.sent, [], "nothing at all crossed the wire");
  });

  it("still names the sections that do exist", async () => {
    const r = recorder();
    await assert.rejects(
      () => callTool(r.context, clickStub(), { element: "b", ref: "e1", include: "consoel" }),
      /snapshot.*console.*network/s,
    );
  });

  it("refuses every malformed shape without acting", async () => {
    for (const include of ["", "  ", "snapshot,,console", "SNAPSHOT", ["snapshot"], 7, null]) {
      const r = recorder();
      const click = clickStub();
      let threw = false;
      try {
        await callTool(r.context, click, { element: "b", ref: "e1", include });
      } catch {
        threw = true;
      }
      // Blank, whitespace and empty segments are not typos — they ask for
      // nothing, which is allowed. What matters is that a shape which IS
      // rejected never reaches the handler.
      if (threw) assert.equal(click.ran, 0, JSON.stringify(include));
      else assert.equal(click.ran, 1, JSON.stringify(include));
    }
  });

  it("leaves a valid include working exactly as before", async () => {
    const r = recorder();
    const click = clickStub();

    const out = await callTool(r.context, click, {
      element: "b",
      ref: "e1",
      include: "console, network",
    });

    assert.equal(click.ran, 1);
    assert.match(textOf(out), /--- console \(1 new\) ---/);
    assert.match(textOf(out), /--- network \(0\) ---/);
  });

  it("accepts the same sections whatever the spacing and case", async () => {
    const r = recorder();
    const click = clickStub();
    const out = await callTool(r.context, click, {
      element: "b",
      ref: "e1",
      include: " Console ,NETWORK ",
    });
    assert.equal(click.ran, 1);
    assert.match(textOf(out), /--- console/);
    assert.match(textOf(out), /--- network/);
  });
});

describe("B04 — a failed attachment is a footnote, not a failed action", () => {
  // The snapshot case fails BOTH messages on purpose: `captureAriaSnapshot`
  // falls back to the older three-message form when the combined one fails, so
  // breaking only the first would test the fallback, not the guard.
  for (const [section, failing, label] of [
    ["console", ["takeNewConsole"], "console"],
    ["network", ["browser_network_requests"], "network"],
    ["snapshot", ["browser_snapshot_full", "browser_snapshot"], "snapshot"],
  ] as const) {
    it(`keeps the click successful when the ${label} attachment fails`, async () => {
      const r = recorder([...failing]);
      const click = clickStub();

      const out = await callTool(r.context, click, { element: "b", ref: "e1", include: section });

      assert.equal(click.ran, 1, "the action happened");
      assert.equal(out.isError, undefined, "and must not be reported as an error");
      assert.match(textOf(out), /Clicked/, "the action's own result survives");
      assert.match(
        textOf(out),
        new RegExp(`--- ${label} ---? \\(unavailable`),
        "the missing section is labelled, not swallowed",
      );
    });
  }

  it("still attaches the sections that did work", async () => {
    const r = recorder(["takeNewConsole"]);
    const click = clickStub();

    const out = await callTool(r.context, click, {
      element: "b",
      ref: "e1",
      include: "console, network",
    });

    assert.equal(click.ran, 1);
    assert.match(textOf(out), /--- console --- \(unavailable/);
    assert.match(textOf(out), /--- network \(0\) ---/, "one failure does not cancel the other");
  });
});
