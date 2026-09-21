import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { Tool } from "./tool";

/**
 * Downloads (roadmap B8). Backed by `chrome.downloads` in the extension.
 *
 * Deliberately returns the PATH and never the bytes: reading the file is the
 * file sandbox's job (Stage 1), and streaming a binary back through the tool
 * result would route around it.
 */

export const DownloadsArgs = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max to return (default 10, newest first)."),
  wait: z.boolean().optional().describe("Block until in-progress downloads finish."),
  timeout: z.number().int().positive().optional().describe("Seconds to wait (default 30)."),
});

const DownloadsOutput = z.object({
  downloads: z.array(z.record(z.unknown())),
  waited: z.boolean().optional(),
});

interface DownloadView {
  id: number;
  filename: string;
  url: string;
  mime: string;
  bytes: number;
  totalBytes: number;
  state: string;
  error?: string;
  startTime: string;
}

function size(bytes: number, total: number): string {
  const n = total || bytes;
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)}${units[u]}`;
}

export const downloads: Tool = {
  schema: {
    name: "browser_downloads",
    description:
      "Recent downloads: final path on disk, URL, mime, size, state. Paths only, never contents.",
    inputSchema: zodToJsonSchema(DownloadsArgs),
    outputSchema: zodToJsonSchema(DownloadsOutput),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = DownloadsArgs.parse(params ?? {});
    // Downloads are browser-wide, not tab-scoped — taking a tab lease to read
    // them would lock out another IDE for no reason.
    // The socket budget must OUTLAST the wait the extension was asked to do.
    // Without this the default 8s round-trip budget killed the connection while
    // the extension was still legitimately waiting (its own default is 30s), so
    // any download slower than 8s died as a bare "Socket message timeout" — the
    // exact case `wait` exists for. The slack lets the extension's own timeout
    // fire FIRST and report "still transferring", which is a real answer.
    const waitMs = args.wait ? Math.min(Math.max(args.timeout ?? 30, 1), 300) * 1000 : 0;
    const r = (await context.sendSocketMessage("browser_downloads", args, {
      noClaim: true,
      ...(args.wait ? { timeoutMs: waitMs + 5_000 } : {}),
    })) as { downloads: DownloadView[]; waited?: boolean };
    const list = r.downloads ?? [];
    const timedOut = r.waited === false ? "\n(still transferring — the wait timed out)" : "";
    const text =
      list.length === 0
        ? "(no downloads)"
        : list
            .map(
              (d) =>
                `${d.state.padEnd(11)} ${size(d.bytes, d.totalBytes).padStart(7)}  ` +
                `${d.filename || "(no path yet)"}${d.error ? `  ERR(${d.error})` : ""}\n` +
                `${" ".repeat(20)}← ${d.url}`,
            )
            .join("\n");
    return { content: [{ type: "text", text: text + timedOut }], structuredContent: r };
  },
};
