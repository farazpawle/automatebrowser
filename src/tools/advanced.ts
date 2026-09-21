import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { redactHeaders } from "@/utils/redact";

import {
  analyzeTrace,
  hasNavigationStart,
  renderMetrics,
  renderHeapTrend,
  type HeapTrend,
} from "./trace-metrics";
import type { Tool, ToolResult } from "./tool";

/**
 * Advanced tools use CDP/chrome.debugger for operations the debugger-free engine
 * cannot perform. One-shot tools auto-attach and auto-detach by default; pass
 * keepEnabled:true or use browser_advanced_mode for longer capture sessions.
 */

export const AdvancedModeArgs = z.object({
  enable: z
    .boolean()
    .optional()
    .describe(
      "true = attach the debugger to the tab you are driving (enables advanced tools; shows the banner). " +
        "false = detach. Omit to just query the current status.",
    ),
});

export const advancedMode: Tool = {
  schema: {
    name: "browser_advanced_mode",
    description:
      "Enable/disable opt-in debugger (CDP) mode for the tab you are driving. Required before browser_upload_file, " +
      "browser_get_network_request (response bodies), browser_perf_trace, full-page screenshots, and " +
      "trusted native input. Attaching shows Chrome's 'debugging this browser' banner for that tab only.",
    inputSchema: zodToJsonSchema(AdvancedModeArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    // D21 was DELETED on 2026-09-16, by the user's decision. `acceptInsecureCerts`
    // could only ever fail: `chrome.debugger` exposes a fixed allow-list of CDP
    // domains to extensions and `Security` is not on it — the same allow-list that
    // killed D7's heap snapshot — measured identically on headless Chrome, headed
    // Chrome and Edge. It is refused HERE rather than simply dropped from the
    // schema: this object is not strict, so an agent working from older guidance
    // would otherwise get a cheerful "advanced mode ON" and believe certificate
    // checking was off. The refusal costs nothing per request — it is not in the
    // schema — and names the two things that DO work.
    if ((params as Record<string, unknown> | undefined)?.acceptInsecureCerts !== undefined) {
      throw new Error(
        "BAD_ARGS: acceptInsecureCerts was removed — it never worked. Chrome does not expose the " +
          "CDP Security domain to extensions, so certificate checking cannot be turned off from " +
          "here on any build. Start the browser with --ignore-certificate-errors, or click through " +
          "the warning page by hand once.",
      );
    }

    const args = AdvancedModeArgs.parse(params ?? {});

    const r = (await context.sendSocketMessage("browser_advanced_mode", args)) as {
      enabled: boolean;
      attachedTabs: number[];
      tabId: number;
    };

    return {
      content: [
        {
          type: "text",
          text:
            `Advanced mode ${r.enabled ? "ON" : "OFF"} for tab ${r.tabId}. ` +
            `Attached tabs: [${r.attachedTabs.join(", ")}]`,
        },
      ],
    };
  },
};

export const UploadFileArgs = z.object({
  ref: z.string().describe('Ref (from a snapshot) of the <input type="file"> element.'),
  filePaths: z
    .array(z.string())
    .min(1)
    .describe(
      "Absolute local file path(s) to set on the input. The browser must be on the same machine.",
    ),
  keepEnabled: z
    .boolean()
    .optional()
    .describe("Keep CDP/debugger attached after the operation. Defaults to false."),
});

export const uploadFile: Tool = {
  schema: {
    name: "browser_upload_file",
    description:
      "Set files on a file input (real upload). Auto-attaches CDP for the operation and detaches after unless keepEnabled:true. Snapshot first to get the ref.",
    inputSchema: zodToJsonSchema(UploadFileArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  // Sandboxed in server.ts: without this an agent could upload ~/.ssh/id_rsa.
  pathParams: [{ param: "filePaths", mode: "read" }],
  handle: async (context, params) => {
    const args = UploadFileArgs.parse(params ?? {});
    const r = (await context.sendSocketMessage("browser_upload_file", args)) as {
      ok: true;
      files: number;
    };
    return { content: [{ type: "text", text: `Set ${r.files} file(s) on ${args.ref}` }] };
  },
};

export const GetNetworkRequestArgs = z.object({
  url: z
    .string()
    .optional()
    .describe("Substring to match the request URL. Omit to use the most recent captured request."),
  requestId: z
    .string()
    .optional()
    .describe("Exact request id, from a previous call's list of matches. Wins over `url`."),
  maxLength: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Truncate the body (default 50000 chars)."),
  keepEnabled: z
    .boolean()
    .optional()
    .describe(
      "Keep CDP/debugger attached after the operation. Useful before reloading to capture response bodies.",
    ),
  revealValues: z
    .boolean()
    .optional()
    .describe(
      "Return raw header values. Defaults to false, which redacts auth/cookie/token headers.",
    ),
});

export const getNetworkRequest: Tool = {
  schema: {
    name: "browser_get_network_request",
    description:
      "Get a network request's response BODY, status and headers by URL substring. Auto-attaches CDP, " +
      "but the request must happen after CDP is enabled; pass keepEnabled:true, then reload/navigate. Unlike " +
      "browser_network_requests (metadata only), this returns the actual body.",
    inputSchema: zodToJsonSchema(GetNetworkRequestArgs),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = GetNetworkRequestArgs.parse(params ?? {});
    const r = (await context.sendSocketMessage("browser_get_network_request", args)) as {
      url: string;
      method: string;
      status?: number;
      mimeType?: string;
      body: string;
      truncated: boolean;
      requestId?: string;
      matches?: Array<{ requestId: string; method: string; status?: number; url: string }>;
      requestHeaders?: Record<string, string>;
      responseHeaders?: Record<string, string>;
    };
    const head =
      `${r.method} ${r.status ?? "—"} ${r.mimeType ?? ""}` +
      `${r.requestId ? ` [requestId=${r.requestId}]` : ""}\n${r.url}\n\n`;

    // D15: an `Authorization` or `Set-Cookie` value reaching this text is in the
    // transcript for good, so it is withheld unless the caller asked for it. The
    // COUNT is reported because "no auth header" and "an auth header you cannot
    // see" are different answers, and an agent debugging a 401 needs the difference.
    const reveal = args.revealValues === true;
    const req = redactHeaders(r.requestHeaders, reveal);
    const res = redactHeaders(r.responseHeaders, reveal);
    const block = (label: string, h: Record<string, string>): string => {
      const lines = Object.entries(h);
      if (lines.length === 0) return "";
      return `${label}:\n${lines.map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n\n`;
    };
    const withheld = req.redacted + res.redacted;
    const redactionNote = withheld
      ? `(${withheld} header value(s) redacted — pass revealValues:true to see them)\n\n`
      : "";
    const headers = block("request headers", req.headers) + block("response headers", res.headers);

    const note = r.truncated ? "\n\n…(truncated)" : "";
    // A URL substring that matched several requests used to return the newest with
    // no hint the others existed. Say so, and hand over the ids to address them.
    const ambiguity =
      r.matches && r.matches.length > 1
        ? `\n\n${r.matches.length} requests matched "${args.url}" — this is the most recent. ` +
          `Re-call with requestId to pick another:\n` +
          r.matches
            .map((m) => `  ${m.requestId}  ${m.method} ${m.status ?? "—"}  ${m.url}`)
            .join("\n")
        : "";
    return {
      content: [{ type: "text", text: head + headers + redactionNote + r.body + note + ambiguity }],
    };
  },
};

export const PerfTraceArgs = z.object({
  action: z
    .enum(["start", "stop", "analyze", "memory"])
    .describe(
      "Start/stop a trace, analyze a saved one, or sample the JS heap over time " +
        "(memory; needs no debugger).",
    ),
  categories: z
    .array(z.string())
    .optional()
    .describe("Optional trace categories (advanced). Omit for the default recording."),
  filePath: z
    .string()
    .optional()
    .describe(
      "Where to save the raw trace JSON (used on stop, READ on analyze). Pass it on START " +
        "too and the location is checked before recording begins, so a bad path fails " +
        "immediately instead of after the trace. Omit to use a temp file.",
    ),
  reload: z
    .boolean()
    .optional()
    .describe(
      "On start: reload the tab once recording has begun, so the trace covers the whole page load.",
    ),
  autoStop: z
    .boolean()
    .optional()
    .describe(
      "On start: stop when loading finishes and return the saved trace in this same call. " +
        "With reload:true this profiles a full page load in one step.",
    ),
  durationMs: z
    .number()
    .optional()
    .describe("memory: sampling window in ms, 1000-30000 (default 5000)."),
});

type TraceResult = { events: unknown[]; durationMs: number; eventCount: number };

/** `start` answers with either an acknowledgement or, under autoStop, the finished trace. */
type StartResult = TraceResult & {
  started?: true;
  reloaded?: boolean;
  autoStopped?: true;
  loadComplete?: boolean;
};

export const perfTrace: Tool = {
  schema: {
    name: "browser_perf_trace",
    description:
      "Record a performance trace (requires advanced/debugger mode). action=start, then drive the page, " +
      "then action=stop — the raw trace is saved to a file and LCP/FCP/INP/CLS reported. For a page-load " +
      "profile use one call: {action:'start', reload:true, autoStop:true}. action=analyze re-reads a " +
      "saved trace at filePath without recording again.",
    inputSchema: zodToJsonSchema(PerfTraceArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  // Sandboxed in server.ts: the trace file must land inside an allowed root.
  pathParams: [{ param: "filePath", mode: "write" }],
  handle: async (context, params) => {
    const args = PerfTraceArgs.parse(params ?? {});

    // Shared by the manual stop and by autoStop, which hands back the very same
    // payload from the `start` round-trip. The vitals are computed HERE rather
    // than only under action:"analyze" because the events are already in hand —
    // it costs no schema tokens, no round-trip, and no second call an agent
    // would usually not make.
    const save = async (r: TraceResult, headline: string): Promise<ToolResult> => {
      const path = args.filePath || join(tmpdir(), `bmcp-trace-${randomUUID()}.json`);
      await writeFile(path, JSON.stringify({ traceEvents: r.events }), "utf8");
      const metrics = renderMetrics(analyzeTrace(r.events), hasNavigationStart(r.events));
      return {
        content: [
          {
            type: "text",
            text:
              `${headline}: ${r.eventCount} events, ~${r.durationMs}ms. Saved to ${path}\n\n` +
              `${metrics}\n\nOpen the file in chrome://tracing or DevTools → Performance → Load profile for the full timeline.`,
          },
        ],
      };
    };

    // D7 — the heap trend. First, because it touches none of the trace state
    // machine below and does not even need advanced mode.
    //
    // There is no `heapsnapshot` sibling, and there cannot be: `chrome.debugger`
    // exposes a fixed allow-list of CDP domains and `HeapProfiler` is not on it.
    // It was built and Chrome answered "'HeapProfiler.enable' wasn't found".
    if (args.action === "memory") {
      const durationMs = args.durationMs ?? 5_000;
      // Rejected, not clamped — same rule as the screenshot strip. An agent that
      // asked for 60s and silently got 30 would report a flat heap over a window
      // it never actually watched.
      if (durationMs < 1_000 || durationMs > 30_000) {
        throw new Error(
          `BAD_ARGS: durationMs must be between 1000 and 30000 (got ${durationMs}). ` +
            "For a longer watch, call this repeatedly while you drive the page.",
        );
      }
      const r = (await context.sendSocketMessage(
        "browser_perf_trace",
        { action: "memory", durationMs },
        // The sampler holds the page for the whole window before it answers.
        { timeoutMs: durationMs + 15_000 },
      )) as HeapTrend;
      if (!r?.supported) {
        throw new Error(
          "This browser does not expose performance.memory, so heap size cannot be read here. " +
            "It is a Chrome-family API. Take a heap snapshot from DevTools → Memory instead " +
            "— no extension can capture one, so there is no tool for it.",
        );
      }
      return { content: [{ type: "text", text: renderHeapTrend(r) }] };
    }

    // A6: parse a trace recorded earlier instead of recording another one. No
    // browser, no debugger, no relay round-trip — just the file.
    //
    // `filePath` is declared a WRITE param (it is one for start/stop), so the
    // sandbox also preflights writability here. That is a deliberate reuse: a
    // second read-mode param would have cost schema tokens on every request to
    // buy nothing except tolerance of a read-only trace file.
    if (args.action === "analyze") {
      if (!args.filePath) {
        throw new Error(
          "browser_perf_trace {action:'analyze'} needs filePath — the trace file a previous " +
            "stop saved (its path is in that call's reply).",
        );
      }
      let events: unknown;
      try {
        const raw = await readFile(args.filePath, "utf8");
        const parsed = JSON.parse(raw);
        events = Array.isArray(parsed) ? parsed : parsed?.traceEvents;
      } catch (e) {
        throw new Error(
          `Could not read a trace from ${args.filePath}: ${String((e as Error)?.message ?? e)}`,
          { cause: e },
        );
      }
      if (!Array.isArray(events)) {
        throw new Error(
          `${args.filePath} is not a Chrome trace — expected an array of events or {traceEvents:[…]}.`,
        );
      }
      const m = analyzeTrace(events);
      return {
        content: [
          {
            type: "text",
            text: `${args.filePath} — ${m.eventCount} events.\n\n${renderMetrics(m, hasNavigationStart(events))}`,
          },
        ],
      };
    }

    if (args.action === "start") {
      // autoStop holds the call open across a whole page load, so it needs the
      // trace-sized budget rather than the 15s a bare start takes.
      const r = (await context.sendSocketMessage(
        "browser_perf_trace",
        {
          action: "start",
          categories: args.categories,
          reload: args.reload,
          autoStop: args.autoStop,
        },
        { timeoutMs: args.autoStop ? 90_000 : 15_000 },
      )) as StartResult;

      if (r?.autoStopped) {
        return save(
          r,
          r.loadComplete
            ? "Trace stopped at load-complete"
            : "Trace stopped after the load wait timed out (the page may already have been idle)",
        );
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Performance trace started${r?.reloaded ? " and the tab reloaded" : ""}. ` +
              `Drive the page, then call browser_perf_trace { action: 'stop' }.`,
          },
        ],
      };
    }

    // stop — the trace can be large, so allow a generous round-trip.
    const r = (await context.sendSocketMessage(
      "browser_perf_trace",
      { action: "stop" },
      { timeoutMs: 60_000 },
    )) as TraceResult;
    return save(r, "Trace stopped");
  },
};
