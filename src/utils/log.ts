/**
 * stderr-only logger. Stdio MCP transport uses stdout for protocol frames;
 * any stray stdout write corrupts the session, so all diagnostics go to stderr.
 *
 * Level is set via AUTOMATE_BROWSER_LOG_LEVEL=debug|info|warn|error (default: info).
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function resolveLevel(): number {
  const raw = (process.env.AUTOMATE_BROWSER_LOG_LEVEL ?? "info").toLowerCase();
  return LEVELS[raw as Level] ?? LEVELS.info;
}

const minLevel = resolveLevel();

function emit(level: Level, args: unknown[]): void {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toISOString();

  console.error(`[${ts}] [${level}]`, ...args);
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};

/**
 * Legacy alias retained for callers that imported `debugLog`. Maps to `info`
 * since most existing call sites are operational events, not deep traces.
 */
export const debugLog = (...args: unknown[]) => emit("info", args);
