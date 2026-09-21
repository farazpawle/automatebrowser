import type {
  ImageContent,
  TextContent,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchema7Type } from "zod-to-json-schema";

import type { Context } from "@/context";
import type { PathMode } from "@/utils/paths";

export type ToolSchema = {
  name: string;
  description: string;
  inputSchema: JsonSchema7Type;
  outputSchema?: JsonSchema7Type;
  annotations?: ToolAnnotations;
};

/**
 * The schema as it goes on the wire. `zod-to-json-schema` stamps every schema it
 * builds with `"$schema": "http://json-schema.org/draft-07/schema#"` — 14 tokens
 * that the protocol never reads, on 46 input schemas and 9 output schemas, paid
 * on EVERY request. Measured 2026-09-18 across 348 real sessions: **644 tokens,
 * 6.2% of the whole tool budget**, for a key JSON Schema itself calls optional.
 *
 * Safe to drop rather than merely cheap to drop: `$schema` only declares which
 * dialect to validate under, and the MCP TypeScript SDK validates
 * `structuredContent` with Ajv's draft-07 build — which is exactly what it falls
 * back to when the key is absent. Nothing revalidates under a different dialect
 * because of its removal.
 *
 * Stripped HERE, at the two points a schema leaves this process, and not at the
 * 46 `zodToJsonSchema` call sites: same bytes off the wire, one place to look
 * when it is ever wrong.
 */
export function wireSchema(schema: ToolSchema): ToolSchema {
  const strip = <T>(value: T): T => {
    if (value === null || typeof value !== "object") return value;
    const { $schema: _dialect, ...rest } = value as Record<string, unknown>;
    return rest as T;
  };
  return {
    ...schema,
    inputSchema: strip(schema.inputSchema),
    ...(schema.outputSchema === undefined ? {} : { outputSchema: strip(schema.outputSchema) }),
  };
}

/**
 * What actually happened. `isError` has two values and four meanings to carry,
 * so the two that matter most collapse into it: a fill that set 2 of 5 fields is
 * not a plain success, and an action whose reply was lost is not a failure —
 * "it did not happen" and "nobody knows whether it happened" are different
 * things to tell an agent that is deciding whether to try again.
 *
 * - `refused`  — stopped before anything was asked of the browser. Certain.
 * - `success`  — it happened. Optional-output warnings do not change this.
 * - `partial`  — some of it happened, and the result says which parts.
 * - `unknown`  — the request went out and the reply was lost. May have landed.
 * - `failed`   — it demonstrably did not happen.
 */
export type ToolOutcome = "refused" | "success" | "partial" | "unknown" | "failed";

export type ToolResult = {
  content: (ImageContent | TextContent)[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /**
   * Set only when `isError` alone would misreport it — in practice `partial`.
   * Absent means `success`, or `failed` when `isError` is set.
   *
   * A TOP-LEVEL field and not a `structuredContent` key on purpose: a tool that
   * declares an `outputSchema` gets its `structuredContent` validated against it
   * by the client, and `zodToJsonSchema` emits `additionalProperties: false`, so
   * an extra key there would make the whole result fail validation. The MCP
   * result schema itself is permissive, so this rides alongside `isError`.
   */
  outcome?: ToolOutcome;
};

export type Tool = {
  schema: ToolSchema;
  /**
   * Params that name a local filesystem path. `server.ts` resolves and sandboxes
   * each one BEFORE `handle` runs, so no tool can hand an out-of-root path to the
   * browser. Declared here rather than on `schema` because it is server-side
   * enforcement metadata — putting it on the schema would ship it to every
   * client in `tools/list` and count against the tool-schema token budget.
   */
  pathParams?: Array<{ param: string; mode: PathMode }>;
  /**
   * Suppress the console-delta footer for a tool that is NOT a page action.
   * The footer probe is a real drive, so on `browser_release_client` it would
   * silently re-take the claim just released, and on `browser_close_tab` it
   * would target a tab that no longer exists. Server-side metadata, like
   * `pathParams` — never shipped in `tools/list`.
   */
  skipConsoleDelta?: boolean;
  /**
   * This tool acts on the page, so an open JS modal blocks it: the dialog pauses
   * the renderer, anything injected into it never runs, and the call burns its
   * whole timeout before failing with a bare "Socket message timeout" that says
   * nothing about the cause. Marked tools get that cause named instead.
   *
   * Detecting an open modal from outside is only possible over CDP — while one is
   * up the renderer cannot answer a probe either — so the debugger-free path
   * explains the timeout rather than pre-empting it. Server-side metadata, like
   * `pathParams` — never shipped in `tools/list`.
   */
  blockedByDialog?: boolean;
  handle: (context: Context, params?: Record<string, unknown>) => Promise<ToolResult>;
};

export type ToolFactory = (snapshot: boolean) => Tool;
