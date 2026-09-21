import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { Tool } from "./tool";

/**
 * Emulation (roadmap A4 + A5). ONE tool for both halves, per A5's own
 * instruction: a second emulation tool would pay for a whole extra schema to
 * describe the same concept.
 *
 * `geolocation` and `headers` need no debugger. Everything else refuses with
 * `ADVANCED_MODE_REQUIRED` until `browser_advanced_mode` is on, because no
 * debugger-free API can do them — a JS `defineProperty` on `userAgent` only
 * fools reads, and `prefers-color-scheme` cannot be overridden from page JS at
 * all.
 *
 * Every option takes `null` to clear it, and calling with no arguments reports
 * what is currently in force — an emulation you cannot see or switch off is a
 * tab the user has to close.
 */

const CLEARABLE = [
  "geolocation",
  "headers",
  "colorScheme",
  "viewport",
  "userAgent",
  "network",
  "cpuThrottling",
] as const;

export const EmulateArgs = z.object({
  geolocation: z
    .array(z.number())
    .length(2)
    .optional()
    .describe("[latitude, longitude]. Only affects requests made AFTER this call."),
  headers: z.record(z.string()).optional().describe("Extra request headers on every request."),
  colorScheme: z.enum(["light", "dark"]).optional(),
  viewport: z
    .array(z.number().int().positive())
    .length(2)
    .optional()
    .describe("[width, height] — responsive testing."),
  mobile: z.boolean().optional().describe("With viewport: emulate a touch device."),
  userAgent: z.string().optional(),
  network: z.enum(["offline", "slow-3g", "fast-3g", "slow-4g"]).optional(),
  cpuThrottling: z.number().min(1).max(20).optional().describe("Slowdown multiplier."),
  clear: z.array(z.string()).optional().describe("Option names to turn off again."),
});

export const emulate: Tool = {
  schema: {
    name: "browser_emulate",
    description:
      "Emulate location, headers, colour scheme, viewport, user agent, network or CPU. No " +
      "arguments reports what is in force. All but location and headers need browser_advanced_mode.",
    inputSchema: zodToJsonSchema(EmulateArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = EmulateArgs.parse(params ?? {});
    // `clear` is a bare string array in the schema (an enum there duplicated all
    // seven names for ~35 tokens on every request), so the names are checked
    // HERE instead — a typo must not silently clear nothing.
    const unknown = (args.clear ?? []).filter((c) => !(CLEARABLE as readonly string[]).includes(c));
    if (unknown.length) {
      throw new Error(
        `Cannot clear ${unknown.join(", ")} — known options are ${CLEARABLE.join(", ")}.`,
      );
    }
    const r = (await context.sendSocketMessage("browser_emulate", args)) as {
      active: Record<string, unknown>;
      applied: string[];
    };
    const entries = Object.entries(r.active ?? {});
    const state = entries.length
      ? entries.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n")
      : "  (nothing emulated)";
    const head = r.applied?.length ? `Applied: ${r.applied.join(", ")}.\nIn force:` : "In force:";
    // Touch emulation reaches `navigator.maxTouchPoints` immediately, but
    // `'ontouchstart' in window` is decided when the DOCUMENT is created — so a
    // page loaded before this call still feature-detects as non-touch (verified
    // on a real page 2026-08-27: false before a reload, true after). Without this
    // line an agent emulates a phone, tests for touch, gets "no", and concludes
    // the site is broken rather than that the page needs reloading. It rides in
    // the RESULT, not the schema, so it costs no tokens on requests that never
    // ask for mobile.
    const touchNote =
      args.mobile === true
        ? "\n\nⓘ Reload the page (browser_navigate {reload:true}) before checking touch support: " +
          "`ontouchstart` is fixed when the document is created, so a page loaded before this call " +
          "still detects as non-touch. navigator.maxTouchPoints is already correct."
        : "";
    return {
      content: [{ type: "text", text: `${head}\n${state}${touchNote}` }],
      structuredContent: r,
    };
  },
};
