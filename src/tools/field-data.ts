import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { rate } from "./trace-metrics";
import type { Tool } from "./tool";

/**
 * C8 — Chrome UX Report (CrUX) field data.
 *
 * The only tool in this server that talks to anything other than the local
 * relay, so the boundary is stated rather than assumed: it sends the URL BEING
 * MEASURED to Google's public CrUX API and nothing else — no page content, no
 * cookies, no identity, nothing about the user. It is inert without an API key,
 * which is the user's own.
 *
 * It pairs with `browser_perf_trace`: that measures THIS machine on THIS run,
 * this reports what real Chrome users actually experienced at p75. A lab number
 * with no field number behind it routinely sends people optimising a page that
 * is already fast for everyone but them.
 *
 * A separate tool rather than an action on `browser_perf_trace` — the cheaper
 * shape by token count — because this call touches no browser at all. As a
 * `readOnlyHint: true` tool it skips the console-delta probe entirely; folded
 * into `perf_trace` (readOnlyHint false) it would have run a real drive against
 * a browser it never used, and refused whenever advanced mode was off.
 */

const KEY_ENV = "AUTOMATE_BROWSER_CRUX_KEY";
const ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
const TIMEOUT_MS = 10_000;

const FieldDataArgs = z.object({
  url: z
    .string()
    .describe("Page URL; falls back to its origin when the page has no data of its own."),
  formFactor: z
    .enum(["PHONE", "DESKTOP", "TABLET"])
    .optional()
    .describe("Omit for all form factors combined."),
});

/** CrUX metric key → the short name everyone (and `rate`) uses. */
const METRICS: Array<[string, string, string]> = [
  ["largest_contentful_paint", "LCP", "ms"],
  ["interaction_to_next_paint", "INP", "ms"],
  ["cumulative_layout_shift", "CLS", ""],
  ["first_contentful_paint", "FCP", "ms"],
  ["experimental_time_to_first_byte", "TTFB", "ms"],
];

type CruxResponse = {
  record?: {
    key?: { url?: string; origin?: string; formFactor?: string };
    metrics?: Record<string, { percentiles?: { p75?: number | string } }>;
    collectionPeriod?: {
      firstDate?: { year: number; month: number; day: number };
      lastDate?: { year: number; month: number; day: number };
    };
  };
  error?: { code?: number; message?: string; status?: string };
};

async function query(key: string, body: Record<string, unknown>): Promise<CruxResponse> {
  const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 404 is CrUX's "not enough real-user data" answer and carries a useful body,
  // so it is parsed like any other reply rather than thrown on status alone.
  return (await res.json()) as CruxResponse;
}

function ymd(d?: { year: number; month: number; day: number }): string | undefined {
  return d
    ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`
    : undefined;
}

export const perfFieldData: Tool = {
  schema: {
    name: "browser_perf_field_data",
    description:
      "Real-user Core Web Vitals (p75 LCP/INP/CLS/FCP/TTFB) for a URL, from Google's Chrome UX Report. " +
      `No browser involved: it sends the URL to Google's public API and needs ${KEY_ENV}. ` +
      "browser_perf_trace measures this machine; this is what real visitors got.",
    inputSchema: zodToJsonSchema(FieldDataArgs),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (_context, params) => {
    const args = FieldDataArgs.parse(params ?? {});
    const key = process.env[KEY_ENV]?.trim();
    if (!key) {
      // Never let this surface as a bare 403 from Google — the cause is local
      // and the fix is one env var.
      throw new Error(
        `browser_perf_field_data needs a Chrome UX Report API key in ${KEY_ENV}. ` +
          "Create a free key at https://console.cloud.google.com/apis/credentials with the " +
          `"Chrome UX Report API" enabled, then set ${KEY_ENV} in the MCP server's environment. ` +
          "Note: this tool sends the URL you ask about to Google's public API.",
      );
    }

    const ff = args.formFactor ? { formFactor: args.formFactor } : {};
    let data = await query(key, { url: args.url, ...ff });
    let scope = "page";

    // A specific page usually has too little traffic to be reported on its own;
    // the origin almost always does. Falling back is what makes the tool useful,
    // but WHICH one answered has to be said or the number is misread.
    if (!data.record?.metrics) {
      let origin: string;
      try {
        origin = new URL(args.url).origin;
      } catch {
        throw new Error(`Not a valid URL: ${args.url}`);
      }
      data = await query(key, { origin, ...ff });
      scope = "origin";
    }

    const metrics = data.record?.metrics;
    if (!metrics) {
      const why = data.error?.message ?? "no record returned";
      // Expected outcome for any site with modest traffic — an answer, not a failure.
      return {
        content: [
          {
            type: "text",
            text:
              `No field data for ${args.url} or its origin. Chrome UX Report only publishes a site ` +
              `once it has enough real-user traffic to be anonymous, so this is the normal answer for ` +
              `a small or new site — it is not an error and not a verdict on the page's speed. ` +
              `Use browser_perf_trace for a lab measurement instead. (API said: ${why})`,
          },
        ],
      };
    }

    const period =
      [ymd(data.record?.collectionPeriod?.firstDate), ymd(data.record?.collectionPeriod?.lastDate)]
        .filter(Boolean)
        .join(" → ") || "unknown period";
    const subject = data.record?.key?.url ?? data.record?.key?.origin ?? args.url;

    const lines: string[] = [];
    for (const [cruxKey, short, unit] of METRICS) {
      const p75 = metrics[cruxKey]?.percentiles?.p75;
      if (p75 === undefined) continue;
      const value = typeof p75 === "string" ? Number(p75) : p75;
      if (!Number.isFinite(value)) continue;
      const shown = short === "CLS" ? value.toFixed(3) : `${Math.round(value)}${unit}`;
      lines.push(`  ${short.padEnd(4)} ${shown} — ${rate(short, value)}`);
    }

    if (lines.length === 0) {
      lines.push("  (the record carried no p75 percentiles)");
    }

    return {
      content: [
        {
          type: "text",
          text:
            `Real-user field data (p75) for the ${scope}: ${subject}\n` +
            `Collected ${period}${args.formFactor ? ` · ${args.formFactor}` : " · all devices"}\n\n` +
            lines.join("\n") +
            (scope === "origin"
              ? "\n\nThe page itself had too little traffic to be reported, so these are whole-site " +
                "numbers — a slow page can hide behind a fast origin."
              : ""),
        },
      ],
    };
  },
};
