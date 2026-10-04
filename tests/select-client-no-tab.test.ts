/**
 * Plan 14, Task 15 — choosing a browser opens no tab.
 *
 * `browser_select_client` is not read-only, so the console-delta footer in
 * `callTool` probed the page after it. That probe is a claiming send: it ran
 * `ensureOwnTab`, which opened a blank background tab — while the tool's own
 * description says "Selecting does NOT claim the browser". `browser_force_claim`
 * had the same probe; it claims on purpose, but the claim is the relay lease,
 * not a tab, and it changes no page for the footer to report on.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Context } from "@/context";

import { callTool } from "@/tools/call";
import { forceClaim, selectClient } from "@/tools/clients";

/** A Context that records every probe or send that would reach the browser. */
function recorder(): { context: Context; sent: string[] } {
  const sent: string[] = [];
  const info = { id: "abcdef0123456789", browser: "chrome", active: true };
  const context = {
    auditTarget: () => ({}),
    clientName: () => "test",
    ctrlId: () => "test",
    hasClients: () => true,
    takeNotice: () => undefined,
    setActive: () => info,
    forceClaim: async () => info,
    consoleErrorDelta: async () => {
      sent.push("consoleErrorDelta");
      return 0;
    },
    issuesDelta: async () => {
      sent.push("issuesDelta");
      return 0;
    },
    sendSocketMessage: async (type: string) => {
      sent.push(type);
      return {};
    },
  } as unknown as Context;
  return { context, sent };
}

describe("Task 15 — choosing a browser sends nothing to it", () => {
  for (const [label, tool, args] of [
    ["browser_select_client", selectClient, { browser: "chrome" }],
    ["browser_select_client force:true", selectClient, { browser: "chrome", force: true }],
    ["browser_force_claim", forceClaim, { browser: "chrome" }],
  ] as const) {
    it(`${label} runs no console or issues probe`, async () => {
      const r = recorder();
      const out = await callTool(r.context, tool, args);
      assert.match(JSON.stringify(out.content), /chrome/);
      assert.deepEqual(r.sent, []);
    });
  }
});
