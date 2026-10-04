/**
 * What leaves the server for the agent: the written reply, not the data copy (plan 14, F2).
 *
 * Claude Code shows a result's `structuredContent` INSTEAD of its text when both
 * are present. Measured live on 2026-10-02: `browser_status` arrived as bare
 * JSON, its warnings gone, and in the benchmark (T23) the console tool showed its
 * page counts and none of its messages. Every hint, footer and "call this next"
 * line this server writes was invisible there on ~25 result sites.
 *
 * So the data copy is stripped at the one exit, and the declared output schemas
 * go with it — a declared schema obliges a structured result. A script that
 * wants the fields opts back in with AUTOMATE_BROWSER_STRUCTURED=1.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { ToolResult, ToolSchema } from "@/tools/tool";

import { wireResult, wireSchema } from "@/tools/tool";

const RESULT: ToolResult = {
  content: [{ type: "text", text: "Uncaught error: x is undefined" }],
  structuredContent: { page: 1, totalPages: 1, total: 1, hasNext: false },
};

const SCHEMA = {
  name: "browser_list_tabs",
  description: "",
  inputSchema: { type: "object" },
  outputSchema: { type: "object", properties: { tabs: { type: "array" } } },
} as unknown as ToolSchema;

describe("wire shape", () => {
  afterEach(() => delete process.env.AUTOMATE_BROWSER_STRUCTURED);

  it("sends the written reply without the data copy by default", () => {
    const out = wireResult({ ...RESULT, isError: true, outcome: "partial" });
    assert.equal("structuredContent" in out, false);
    assert.deepEqual(out.content, RESULT.content);
    assert.equal(out.isError, true);
    assert.equal(out.outcome, "partial");
  });

  it("lists no output schema by default", () => {
    assert.equal("outputSchema" in wireSchema(SCHEMA), false);
  });

  it("keeps both when AUTOMATE_BROWSER_STRUCTURED=1", () => {
    process.env.AUTOMATE_BROWSER_STRUCTURED = "1";
    assert.deepEqual(wireResult(RESULT).structuredContent, RESULT.structuredContent);
    assert.deepEqual(wireSchema(SCHEMA).outputSchema, SCHEMA.outputSchema);
  });
});
