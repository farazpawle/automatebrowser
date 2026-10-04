/**
 * Local, in-repo replacement for the monorepo `@repo/config` package
 * (`/app.config` + `/mcp.config`). The published repo resolves these from a
 * workspace package; in this extracted repo they are vendored here so the
 * project builds standalone. Mirrors the historical `dist/config.js`.
 */

// `browser: { port, host }` lived here until 2026-09-07, reading
// `AUTOMATE_BROWSER_PORT` for a CDP endpoint on 9222. Nothing had read it since
// the architecture stopped attaching to a debugger port: `appConfig.name` is the
// only field this repo uses. It was deleted rather than documented — D13's
// generated Configuration table would otherwise have advertised a setting that
// does nothing, which is worse than the omission it replaced.
export const appConfig = {
  name: "@automatebrowser/mcp",
  version: "1.0.1",
  server: {
    name: "@automatebrowser/mcp",
    version: "1.0.1",
  },
} as const;

/**
 * `wsPortRange` is the inclusive [start, end] range the relay scans for a free
 * port (and the extension scans to discover it). Defaults to 9009–9013; override
 * with `AUTOMATE_BROWSER_WS_PORT_RANGE="<start>-<end>"` to isolate an instance (e.g.
 * the connection smoke test runs on a high range so it never touches a live
 * relay on 9009). Keeping 9009 as the default start preserves compatibility.
 */
function resolveWsPortRange(): [number, number] {
  const raw = process.env.AUTOMATE_BROWSER_WS_PORT_RANGE;
  const m = raw?.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (m) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (start > 0 && end >= start) return [start, end];
  }
  return [9009, 9013];
}

export const mcpConfig = {
  server: {
    name: "@automatebrowser/mcp",
    version: "1.0.1",
  },
  transport: {
    type: "stdio",
  },
  defaultWsPort: 9009,
  wsPortRange: resolveWsPortRange(),
  /**
   * WS round-trip budgets. Kept short so a wedged page/element fails fast with a
   * clear error instead of stalling the agent for 30-60s. Genuinely slow
   * operations (navigation waits for load, ARIA walk on huge pages) get their
   * own, larger budget below.
   */
  timeouts: {
    /** Default for quick ops: click, type, hover, eval, tab management, … */
    default: 8_000,
    /** ARIA snapshot can be heavy on very large pages. */
    snapshot: 15_000,
    /** captureVisibleTab + PNG encode. */
    screenshot: 20_000,
    /** Navigation: the extension resolves only after the page finishes loading. */
    navigation: 20_000,
  },
  errors: {
    noConnectedTab: "No connected tab found",
  },
} as const;

/**
 * Global override. When set, every interaction re-bundles a full page snapshot
 * (the pre-lean behaviour). Off by default: actions return a short confirmation
 * and the agent calls `browser_snapshot` only when it needs fresh element refs
 * (mirrors Chrome DevTools MCP, where `includeSnapshot` defaults to false).
 */
export function snapshotEachAction(): boolean {
  const v = process.env.AUTOMATE_BROWSER_SNAPSHOT_EACH_ACTION;
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Opt-in: send each result's `structuredContent` (and list the output schemas).
 * Off by default because Claude Code shows the structured half INSTEAD of the
 * text when both arrive, which hides every written hint and footer (plan 14, F2).
 */
export function structuredReplies(): boolean {
  const v = process.env.AUTOMATE_BROWSER_STRUCTURED;
  return v === "1" || v === "true" || v === "yes";
}
