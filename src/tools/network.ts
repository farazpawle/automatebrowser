import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { paginate, pageFooter } from "@/utils/paginate";

import type { Tool } from "./tool";

/**
 * Network request log (metadata only). Backed by chrome.webRequest in the
 * extension — method, URL, type, status, timing. There are NO request/response
 * BODIES without the debugger (that's Milestone 3's opt-in CDP mode).
 */

/**
 * Page size when the caller does not set `limit`. Was 100 before paging.
 *
 * Exported because `call.ts` renders its own condensed network block for
 * `include: "network"` and asks the extension directly. Left at the extension's
 * own default of 100 it would quietly hand back twice what this tool documents,
 * on the incidental path rather than the one the agent asked for.
 */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * What is asked of the extension, regardless of page size. Its ring buffer holds
 * 1000 entries, so this is "everything you have" — paging cannot slice a window
 * the extension already truncated to the newest N. `getIssues` asks for the same
 * number for the same reason.
 */
const BUFFER_LIMIT = 1000;

export const NetworkArgs = z.object({
  limit: z.number().int().positive().optional().describe("Page size (default 50, newest first)."),
  page: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1 (default) is the newest page, higher is older."),
  resourceTypes: z
    .array(z.string())
    .optional()
    .describe("Filter by resource type (e.g. xmlhttprequest, fetch, script, image, document)."),
  includePreserved: z
    .boolean()
    .optional()
    .describe("Also return the previous 2 pages' requests — for debugging a redirect."),
});
const NetworkOutput = z.object({
  captured: z.boolean(),
  requests: z.array(z.record(z.unknown())),
  generations: z.number().optional(),
  page: z.number().optional(),
  totalPages: z.number().optional(),
  total: z.number().optional(),
  hasNext: z.boolean().optional(),
});

export const networkRequests: Tool = {
  schema: {
    name: "browser_network_requests",
    description:
      "List network requests the tab you are driving made on the CURRENT page (method, URL, status, type, " +
      "timing) — pass includePreserved for the pages before it. Metadata only; response BODIES need " +
      "browser_get_network_request. The log survives the worker idling, but not a browser restart.",
    inputSchema: zodToJsonSchema(NetworkArgs),
    outputSchema: zodToJsonSchema(NetworkOutput),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const { page, limit, ...pass } = NetworkArgs.parse(params ?? {});
    // The extension applies `limit` as "the newest N" before returning, so
    // forwarding the page size would make every page after the first empty.
    // Ask for the whole buffer and slice here.
    const r = (await context.sendSocketMessage("browser_network_requests", {
      ...pass,
      limit: BUFFER_LIMIT,
    })) as {
      captured: boolean;
      generations?: number;
      requests: Array<{
        method: string;
        url: string;
        type: string;
        status?: number;
        error?: string;
        start: number;
        end?: number;
      }>;
    };
    if (!r.captured) {
      return {
        content: [
          {
            type: "text",
            text: "Network capture is unavailable (the extension lacks the webRequest permission — reload the rebuilt extension).",
          },
        ],
        structuredContent: r,
      };
    }
    const p = paginate(r.requests, page, limit ?? DEFAULT_PAGE_SIZE);
    const body =
      p.total === 0
        ? "(no requests captured for this tab on the current page)"
        : p.items
            .map((q) => {
              const ms = q.end && q.start ? ` ${Math.round(q.end - q.start)}ms` : "";
              const st = q.error ? `ERR(${q.error})` : (q.status ?? "—");
              return `${String(st).padEnd(6)} ${q.method.padEnd(6)} ${q.type.padEnd(14)}${ms}  ${q.url}`;
            })
            .join("\n");
    const text = `${body}${pageFooter(p, "browser_network_requests", "requests")}`;
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        ...r,
        requests: p.items,
        page: p.page,
        totalPages: p.totalPages,
        total: p.total,
        hasNext: p.hasNext,
      },
    };
  },
};
