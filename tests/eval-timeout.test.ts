/**
 * browser_eval takes a timeout (plan 14, F13).
 *
 * eval passed no deadline, so every call got the 8 s quick-op default and a
 * long in-page computation in benchmark T12 timed out with no way to ask for
 * more. It now takes the shared `timeout` argument and sends it with the call.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mcpConfig } from "@repo/config/mcp.config";

import type { Context } from "@/context";

import { evaluate } from "@/tools/eval";

/** The deadline eval handed to the socket call for `params`. */
async function deadlineFor(params: Record<string, unknown>): Promise<number | undefined> {
  let sent: number | undefined;
  const ctx = {
    sendSocketMessage: async (_t: string, _p: unknown, o?: { timeoutMs?: number }) => {
      sent = o?.timeoutMs;
      return 1;
    },
  } as unknown as Context;
  await evaluate.handle(ctx, params);
  return sent;
}

describe("browser_eval timeout", () => {
  it("passes the caller's timeout to the browser call", async () => {
    assert.equal(await deadlineFor({ expression: "1", timeout: 30_000 }), 30_000);
  });

  it("keeps the quick-op default when none is given", async () => {
    assert.equal(await deadlineFor({ expression: "1" }), mcpConfig.timeouts.default);
  });

  it("is in the schema an agent sees", () => {
    const props = (evaluate.schema.inputSchema as { properties: Record<string, unknown> })
      .properties;
    assert.ok("timeout" in props);
  });
});
