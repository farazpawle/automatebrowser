/**
 * A timeout during which the page moved on is not blamed on a dialog (F4).
 *
 * The extension now returns as soon as a ref op's page starts loading, but a
 * load Chrome never reports — or an older extension build — can still leave a
 * page-acting call to run out its socket deadline. The server used to add "the
 * page has an open alert/confirm/prompt" to every such timeout, which sent
 * benchmark run T32 looking for a dialog that was never there.
 *
 * The check costs nothing on a call that succeeds: only after a timeout does the
 * server ask the browser's request log whether a top-level load began during
 * the call. A dialog freezes the page before any navigation request is made, so
 * a load seen there rules the dialog out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context } from "@/context";
import type { Tool } from "@/tools/tool";

import { callTool } from "@/tools/call";

/** The request log's answer: the newest top-level request, `msAgo` before now. */
function context(log: { url: string; msAgo: number } | "unavailable" | null) {
  const sent: string[] = [];
  const ctx = {
    auditTarget: () => ({}),
    clientName: () => "test",
    ctrlId: () => "test",
    hasClients: () => true,
    takeNotice: () => undefined,
    consoleErrorDelta: async () => 0,
    issuesDelta: async () => 0,
    sendSocketMessage: async (type: string) => {
      sent.push(type);
      if (log === "unavailable") throw new Error("Socket message timeout");
      return {
        captured: true,
        requests: log ? [{ url: log.url, type: "main_frame", start: Date.now() - log.msAgo }] : [],
      };
    },
  } as unknown as Context;
  return { ctx, sent };
}

/** A page-acting tool whose request outlived the socket deadline. */
const timedOutClick = {
  blockedByDialog: true,
  schema: {
    name: "browser_click",
    description: "",
    inputSchema: {},
    annotations: { readOnlyHint: false },
  },
  handle: async () => {
    await new Promise((r) => setTimeout(r, 20));
    throw new Error("Socket message timeout");
  },
} as unknown as Tool;

const failure = (run: () => Promise<unknown>): Promise<Error> =>
  run().then(
    () => {
      throw new assert.AssertionError({ message: "expected the call to fail" });
    },
    (e: Error) => e,
  );

describe("a timeout during which the page moved on", () => {
  it("names the load instead of a dialog", async () => {
    // The load began after the call was sent - it is this call's doing.
    const { ctx } = context({ url: "https://example.test/b", msAgo: 5 });
    const e = await failure(() => callTool(ctx, timedOutClick, { element: "a", ref: "e1" }));
    assert.doesNotMatch(e.message, /alert\/confirm\/prompt/);
    assert.match(e.message, /https:\/\/example\.test\/b/);
    assert.match(e.message, /browser_snapshot/, "the next step is to look, not to repeat");
  });

  it("keeps the dialog hint when the last load is older than the call", async () => {
    const { ctx } = context({ url: "https://example.test/a", msAgo: 60_000 });
    const e = await failure(() => callTool(ctx, timedOutClick, { element: "a", ref: "e1" }));
    assert.match(e.message, /alert\/confirm\/prompt/);
  });

  it("keeps the dialog hint when the request log cannot be read", async () => {
    const { ctx } = context("unavailable");
    const e = await failure(() => callTool(ctx, timedOutClick, { element: "a", ref: "e1" }));
    assert.match(e.message, /alert\/confirm\/prompt/);
  });

  it("asks nothing extra of a call that succeeds", async () => {
    const { ctx, sent } = context(null);
    const ok = { ...timedOutClick, handle: async () => ({ content: [] }) } as unknown as Tool;
    await callTool(ctx, ok, { element: "a", ref: "e1" });
    assert.ok(!sent.includes("browser_network_requests"), `sent: ${sent.join(", ")}`);
  });
});
