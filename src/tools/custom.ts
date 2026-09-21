import { writeFileSync } from "node:fs";

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { mcpConfig } from "@repo/config/mcp.config";
import { GetConsoleLogsTool } from "@repo/types/mcp/tool";

import { paginate, pageFooter, type Page } from "@/utils/paginate";
import { assertPathAllowed } from "@/utils/paths";

import { ToolError } from "./errors";
import type { ToolResult } from "./tool";
import type { Tool } from "./tool";

const SCREENSHOT_TIMEOUT_MS = mcpConfig.timeouts.screenshot;

/**
 * Entries per page. Written into the `page` description as a number, because an
 * agent cannot discover it any other way — and without it, a footer saying
 * "page 2 of 7" is not enough to reason about how much log is left.
 */
const CONSOLE_PAGE_SIZE = 50;

/**
 * Frame-strip limits (D6). A strip is N stills on a timer, not a video — see the
 * README section for why real video was rejected rather than deferred.
 *
 * 30 frames at the 100ms floor is 3 seconds of capture: enough to show a
 * transition or a flicker, small enough that a mistaken call is not a
 * disk-filling event. The floor is where it is because a capture measurably
 * costs ~110ms on a foreground tab (2026-09-05, jpeg q60), so asking for less
 * buys nothing except a strip whose stated interval is a fiction.
 */
const MAX_FRAMES = 30;
const MIN_INTERVAL_MS = 100;
const DEFAULT_INTERVAL_MS = 200;

export const MAX_WIDTH_ENV = "AUTOMATE_BROWSER_SCREENSHOT_MAX_WIDTH";
export const MAX_HEIGHT_ENV = "AUTOMATE_BROWSER_SCREENSHOT_MAX_HEIGHT";

/**
 * D17's default ceiling, and the measurement that shaped it — Edge 152,
 * 2026-09-09, one Wikipedia article, viewport emulated to 2560x1440:
 *
 * | Capture | Device px | Chrome's PNG | Downscaled to 1536 wide |
 * |---|---|---|---|
 * | Viewport, 1080p | 1912x914 | 241 KB | png **446 KB**, jpeg60 103 KB, webp60 75 KB |
 * | Viewport, 2K | 2560x1440 | 332 KB | png **529 KB**, jpeg60 100 KB, webp60 74 KB |
 * | Full page, 2K | 2545x6362 | 1198 KB | png **2287 KB** |
 *
 * **THE PREMISE THIS ITEM WAS WRITTEN ON IS HALF WRONG, and the measurement is
 * the only reason we know.** Downscaling a screenshot and re-encoding it as PNG
 * makes the FILE BIGGER — 60% bigger for a viewport, 91% for a full page. Chrome's
 * capture is flat colour and sharp edges, which PNG compresses superbly;
 * resampling turns every edge into a gradient of unique pixels that a lossless
 * codec then has to store in full. Only the lossy formats shrink, and those shrink
 * a lot (332 KB → 74 KB).
 *
 * So the ceiling is applied to an image coming back **INLINE and nowhere else**.
 * Inline, the cost is PIXELS, not bytes: 2560x1440 is ~4900 image tokens against
 * ~1770 for 1536x864, a 2.8x saving on every capture, and the byte size of the
 * base64 in flight is irrelevant next to that. A capture written to `filePath` —
 * which includes every frame of a strip — is left alone, because there the cost
 * IS the bytes, the ceiling would add to them, and the fidelity it spends is not
 * recoverable.
 *
 * **Width 1536** because that is roughly where a model's vision pipeline
 * downsamples to anyway (~1568px on the long edge), so pixels above it are paid
 * for and then thrown away — and because 16px page text scaled by 1536/2560
 * still lands near 10px, which is the floor at which it stays readable. Lower
 * would start costing legibility rather than waste.
 *
 * **Height 4096** is deliberately NOT the same number. The ceiling is a bounding
 * box with the aspect ratio preserved, so a matching 1536 height would take that
 * 2545x6362 full-page capture down to 613 px WIDE — a legible-width screenshot
 * traded for an illegible sliver, which is a worse outcome than the cost it
 * saves. At 4096 the width still binds first for any page under ~6800 device px
 * tall, and beyond that the picture is an overview anyway.
 *
 * Either may be set to `0` to switch that half off.
 */
const DEFAULT_MAX_WIDTH = 1536;
const DEFAULT_MAX_HEIGHT = 4096;

function ceilingFor(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  // A typo must fall back to the default, never to "no limit" — the failure mode
  // of a mis-set ceiling should be a smaller image, not an unbounded one.
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** The width/height ceiling this process enforces; `0` means that half is off. */
export function screenshotCeiling(): { maxWidth: number; maxHeight: number } {
  return {
    maxWidth: ceilingFor(MAX_WIDTH_ENV, DEFAULT_MAX_WIDTH),
    maxHeight: ceilingFor(MAX_HEIGHT_ENV, DEFAULT_MAX_HEIGHT),
  };
}

/**
 * What `browser_screenshot` answers. An older extension build sends a bare base64
 * png STRING instead of this object, which is why every read of it below tolerates
 * both — that back-compat is the reason the shape is a union and not a record.
 */
type ShotResult = {
  data?: string;
  mimeType?: string;
  viaDebugger?: boolean;
  reason?: string;
  cropped?: boolean;
  width?: number;
  height?: number;
  scaledFrom?: { width: number; height: number };
};

/**
 * Older extension builds answer with a bare base64 png STRING rather than the
 * object. Normalised once, here, so the eight reads below are eight reads and not
 * eight repetitions of the same back-compat ternary.
 */
function asShot(res: unknown): ShotResult {
  if (typeof res === "string") return { data: res, mimeType: "image/png" };
  return (res ?? {}) as ShotResult;
}

/**
 * The one line an agent measuring pixels has to see. A silently shrunk
 * screenshot is a wrong screenshot: coordinates read off it point at the wrong
 * part of the page, and nothing in the image says so.
 */
function downscaleNote(res: ShotResult): string | undefined {
  const from = res.scaledFrom;
  if (!from) return undefined;
  return (
    `ⓘ Downscaled to ${res.width}x${res.height} from ${from.width}x${from.height} to stay under ` +
    `the ${MAX_WIDTH_ENV}/${MAX_HEIGHT_ENV} ceiling. Measure pixels against the SMALLER image, ` +
    `or set either variable to 0 to capture at full size.`
  );
}

export const ConsoleArgs = z.object({
  includePreserved: z
    .boolean()
    .optional()
    .describe("Also return the previous 2 pages' console — for debugging a redirect."),
  page: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("50 entries per page; 1 (default) is the newest, higher is older."),
});

export const ScreenshotArgs = z.object({
  format: z
    .enum(["png", "jpeg", "webp"])
    .optional()
    .describe("png (default), jpeg or webp (smaller — set quality)."),
  ref: z.string().optional().describe("Capture just this element (snapshot ref)."),
  filePath: z.string().optional().describe("Write the image here; returns the path, not bytes."),
  quality: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("JPEG quality 0–100 (ignored for png). Lower = smaller payload."),
  fullPage: z
    .boolean()
    .optional()
    .describe(
      "Capture the FULL scrollable page, not just the viewport. Auto-attaches CDP/debugger for the operation.",
    ),
  keepEnabled: z
    .boolean()
    .optional()
    .describe("For fullPage:true, keep CDP/debugger attached after capture. Defaults to false."),
  frames: z
    .number()
    .int()
    .min(1)
    .max(MAX_FRAMES)
    .optional()
    .describe(`A strip of stills, up to ${MAX_FRAMES}. Needs filePath.`),
  intervalMs: z
    .number()
    .int()
    .min(MIN_INTERVAL_MS)
    .optional()
    .describe(`Gap between frames, min ${MIN_INTERVAL_MS}ms (default ${DEFAULT_INTERVAL_MS}).`),
});

/** One captured console entry; `kind`/`stack`/`source` appear only on thrown errors. */
interface ConsoleEntry {
  /** Per-document sequence number, so a specific line can be named. */
  msgid?: number;
  level?: string;
  ts?: number;
  text?: string;
  kind?: string;
  stack?: string;
  source?: string;
}

/**
 * Chronological console dump, then the thrown errors again WITH their stacks.
 *
 * The stack is stripped from the chronological lines rather than printed there:
 * a multi-frame stack inlined into a JSON line makes the log unreadable at exactly
 * the moment the agent is scanning it. Nothing is lost — every thrown entry is
 * repeated below in full. An older extension build sends no `stack` at all, in
 * which case this renders exactly as it always did.
 *
 * The stack section covers THIS PAGE, not the whole log — 50 entries carrying
 * 50 stacks is already the largest thing this tool emits, and re-printing every
 * stack on every page would make paging cost more than not paging.
 */
function renderConsole(page: Page<ConsoleEntry>): string {
  const footer = pageFooter(page, "browser_get_console_logs", "entries");
  if (page.total === 0) return `(no console entries captured for this tab)${footer}`;
  const lines = page.items.map(({ stack: _stack, ...rest }) => JSON.stringify(rest)).join("\n");
  const thrown = page.items.filter((e) => e.kind && e.stack);
  if (thrown.length === 0) return `${lines}${footer}`;
  const detail = thrown
    .map(
      (e) =>
        `${e.kind === "unhandledrejection" ? "Unhandled rejection" : "Uncaught error"}` +
        `${e.msgid != null ? ` (msgid ${e.msgid})` : ""}: ${e.text ?? ""}\n${e.stack}`,
    )
    .join("\n\n");
  return `${lines}\n\n--- Thrown errors with stacks (${thrown.length}) ---\n\n${detail}${footer}`;
}

export const getConsoleLogs: Tool = {
  schema: {
    name: GetConsoleLogsTool.shape.name.value,
    description: GetConsoleLogsTool.shape.description.value,
    inputSchema: zodToJsonSchema(ConsoleArgs),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const { page, ...pass } = ConsoleArgs.parse(params ?? {});
    // `page` is not forwarded: the extension holds the whole buffer and knows
    // nothing about paging, so the slice has to happen here, after the log
    // arrives. The wire hop is local; the context window is what this saves.
    const consoleLogs = await context.sendSocketMessage("browser_get_console_logs", pass);
    const entries: ConsoleEntry[] = Array.isArray(consoleLogs) ? consoleLogs : [];
    const p = paginate(entries, page, CONSOLE_PAGE_SIZE);
    return {
      content: [{ type: "text", text: renderConsole(p) }],
      // Page fields only — never the entries. This tool has no `outputSchema`,
      // and repeating a 50-entry log as structured data would double the cost of
      // the most verbose result the server produces.
      structuredContent: {
        page: p.page,
        totalPages: p.totalPages,
        total: p.total,
        hasNext: p.hasNext,
      },
    };
  },
};

/**
 * `out/run.png` + frame 3 → `out/run-03.png`. The number goes before the
 * extension so the files sort in capture order in any file browser, which is the
 * whole point of handing a person a strip.
 */
function framePath(base: string, n: number): string {
  const pad = String(n).padStart(2, "0");
  const dot = base.lastIndexOf(".");
  const slash = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  return dot > slash ? `${base.slice(0, dot)}-${pad}${base.slice(dot)}` : `${base}-${pad}`;
}

/**
 * N stills on a timer, through the capture path that already exists (D6).
 *
 * Three things here are deliberate:
 *
 * 1. **Every generated name goes through `assertPathAllowed` too.** `pathParams`
 *    sandboxes the caller's `filePath`, and these are names the caller never
 *    typed — so they are checked individually rather than assumed safe for
 *    sharing a directory with a path that passed.
 * 2. **Every frame goes through the debugger, and it stays attached.** Not a
 *    second capture mechanism — the same CDP path a background tab already uses.
 *    It is forced because Chrome quotas the cheap `captureVisibleTab` at 2 calls
 *    per second and rejects the third outright (measured: a 4-frame strip at
 *    150ms failed on frame 3). Attaching per frame would also flash Chrome's
 *    banner up to 30 times, so only the LAST frame honours the caller's
 *    `keepEnabled` and the strip detaches exactly once, at the end.
 * 3. **The achieved timing is reported, not the requested timing.** A capture
 *    costs 50-250ms; a strip that asked for 100ms and got 300ms would otherwise
 *    read as evidence of something happening three times slower than it did.
 */
async function captureStrip(
  context: Parameters<Tool["handle"]>[0],
  args: z.infer<typeof ScreenshotArgs>,
  frames: number,
  base: string,
): Promise<ToolResult> {
  const interval = args.intervalMs ?? DEFAULT_INTERVAL_MS;
  const written: Array<{ path: string; bytes: number }> = [];
  const startedAt = Date.now();
  let mimeType = "image/png";
  let viaDebugger = false;

  for (let i = 0; i < frames; i++) {
    // Schedule against the START, not against the previous frame, so a slow
    // capture does not compound into a strip that drifts further behind on
    // every frame.
    const dueIn = startedAt + i * interval - Date.now();
    if (dueIn > 0) await new Promise((r) => setTimeout(r, dueIn));

    const last = i === frames - 1;
    const res = asShot(
      await context.sendSocketMessage(
        "browser_screenshot",
        {
          format: args.format,
          quality: args.quality,
          ref: args.ref,
          fullPage: args.fullPage,
          keepEnabled: last ? args.keepEnabled : true,
          // Always the debugger path, foreground tab or not. Chrome quotas the
          // cheap capture at 2 per second and REJECTS the third — measured
          // 2026-09-05, a 4-frame strip at 150ms failed on frame 3. Forcing it also
          // makes a strip's rate independent of whether the user happens to be
          // looking at the tab, which is the more predictable behaviour anyway.
          forceCdp: true,
        },
        { timeoutMs: SCREENSHOT_TIMEOUT_MS },
      ),
    );
    if (res.mimeType) mimeType = res.mimeType;
    if (res.viaDebugger === true) viaDebugger = true;

    const target = assertPathAllowed(framePath(base, i + 1), "write");
    const bytes = Buffer.from(res.data ?? "", "base64");
    writeFileSync(target, bytes);
    written.push({ path: target, bytes: bytes.length });
  }

  const elapsedMs = Date.now() - startedAt;
  const totalKb = Math.round(written.reduce((n, f) => n + f.bytes, 0) / 1024);
  // frames-1 gaps, not frames: 10 frames at 200ms spans 1.8s, not 2.0s.
  const achieved = frames > 1 ? Math.round(elapsedMs / (frames - 1)) : 0;
  const summary =
    `${written.length} frames written to ${framePath(base, 1)} … ${framePath(base, frames)} ` +
    `(${totalKb} KB total, ${mimeType}, one every ~${achieved}ms over ${elapsedMs}ms). ` +
    `Stills, not video — open them in order.`;

  // Measured, not assumed, and reported only when it actually bit. Chrome does
  // not draw a tab nobody is looking at, so each frame waits for one to be
  // rendered: 2026-09-05, the same 10-frame strip ran at ~110ms per frame in the
  // foreground and ~3900ms in the background. That is not a bug to fix, it is a
  // fact to hand over — with the one action that changes it.
  const slow =
    achieved > interval * 2
      ? `ⓘ You asked for a frame every ${interval}ms and got one every ~${achieved}ms. Chrome ` +
        `stops drawing a tab nobody is looking at, so each frame waits for one to be rendered — ` +
        `about 4 seconds each, against ~110ms for a tab in the foreground. For a strip of ` +
        `something MOVING, bring the tab to the front first with browser_switch_tab (it takes ` +
        `the user's focus) — or keep this strip, which is fine for slow changes.`
      : undefined;

  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: written.map((f) => f.path).join("\n") },
      ...(slow ? [{ type: "text" as const, text: slow }] : []),
      ...(viaDebugger
        ? [
            {
              type: "text" as const,
              text:
                `ⓘ Every frame was rendered through the debugger, so Chrome showed its ` +
                `"being debugged" banner for the length of the strip. That is deliberate: the ` +
                `cheap capture is capped at 2 frames per second by Chrome. The debugger was ` +
                `attached once and detached at the end, not per frame.`,
            },
          ]
        : []),
    ],
    structuredContent: {
      frames: written,
      count: written.length,
      mimeType,
      intervalMs: interval,
      achievedIntervalMs: achieved,
      elapsedMs,
      ...(slow ? { slowerThanAsked: true } : {}),
      ...(viaDebugger ? { viaDebugger: true } : {}),
    },
  };
}

export const screenshot: Tool = {
  schema: {
    name: "browser_screenshot",
    description:
      "Capture the visible viewport of the tab you are driving — including a background " +
      "tab, which is rendered via the debugger (brief banner) rather than refused. Optional " +
      "`format` (png|jpeg) and `quality` (jpeg). Full-page capture auto-attaches CDP and " +
      "detaches after unless keepEnabled:true. Checking one element? Pass its `ref` — a page " +
      "costs ~1,500 tokens of context and stays there; an element costs a fraction.",
    inputSchema: zodToJsonSchema(ScreenshotArgs),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  // Same write choke point as every other file-producing tool: containment
  // against the negotiated roots happens before `handle` runs.
  pathParams: [{ param: "filePath", mode: "write" }],
  handle: async (context, params) => {
    const args = ScreenshotArgs.parse(params ?? {});

    const frames = args.frames ?? 1;
    if (frames > 1) {
      // Refused rather than defaulted: N images inline is the single most
      // expensive thing this server could return, and picking a directory on the
      // agent's behalf would put files somewhere it did not choose.
      if (!args.filePath) {
        throw new ToolError(
          "BAD_ARGS",
          `frames: ${frames} needs a filePath — a strip is written to disk, never returned as ` +
            `images, because ${frames} inline pictures would swamp the reply. Pass ` +
            `filePath: "…/strip.png" and the frames land beside it as strip-01.png, strip-02.png, ….`,
        );
      }
      return captureStrip(context, args, frames, args.filePath);
    }

    const res = asShot(
      await context.sendSocketMessage(
        "browser_screenshot",
        // The ceiling rides along ONLY for an image that comes back inline — see
        // `screenshotCeiling` for the measurement that decided that. A capture
        // written to a file, and every frame of a strip, keeps its full size.
        { ...args, ...(args.filePath ? {} : screenshotCeiling()) },
        { timeoutMs: SCREENSHOT_TIMEOUT_MS },
      ),
    );
    const data = res.data ?? "";
    const mimeType = res.mimeType || "image/png";

    // The debugger path shows Chrome's "being debugged" banner, and the extension
    // already knows WHY it had to be used. Passing that on is the difference
    // between an agent explaining the banner and the user watching it appear for
    // no stated reason — the same reason every other diagnostic here rides in the
    // result rather than only in a doc. Absent on the cheap path, so a foreground
    // capture is byte-identical to what it always was.
    const banner =
      res.viaDebugger === true
        ? `ⓘ Rendered through the debugger, so Chrome showed its "being debugged" banner for the ` +
          `moment of capture: ${res.reason ?? "the cheap capture could not be trusted for this tab"}. ` +
          `The image is of the tab you asked for, and the debugger was detached again straight after.`
        : undefined;

    const shrunk = downscaleNote(res);

    // A3: with a filePath the whole point is to keep the bytes OUT of the
    // context window, so the path is the entire answer — returning both would
    // defeat the reason the param exists.
    if (args.filePath) {
      const bytes = Buffer.from(data, "base64");
      writeFileSync(args.filePath, bytes);
      return {
        content: [
          {
            type: "text",
            text:
              `Screenshot written to ${args.filePath} ` +
              `(${Math.round(bytes.length / 1024)} KB, ${mimeType}` +
              `${res.cropped ? `, cropped to ref ${args.ref}` : ""}).`,
          },
          ...(banner ? [{ type: "text" as const, text: banner }] : []),
        ],
        structuredContent: {
          filePath: args.filePath,
          bytes: bytes.length,
          mimeType,
          cropped: res.cropped === true,
          ...(res.viaDebugger === true ? { viaDebugger: true, reason: res.reason } : {}),
        },
      };
    }
    return {
      content: [
        {
          type: "image",
          data,
          mimeType,
        },
        ...(shrunk ? [{ type: "text" as const, text: shrunk }] : []),
        ...(banner ? [{ type: "text" as const, text: banner }] : []),
      ],
    };
  },
};
