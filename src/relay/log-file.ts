/**
 * File logger for the detached relay process. The relay is spawned with
 * `stdio:"ignore"`, so stderr goes nowhere — diagnostics are appended to a file
 * in `~/.automate-browser/` instead (NOT the temp dir, which gets swept - see
 * `utils/log-dir`). Set AUTOMATE_BROWSER_RELAY_FOREGROUND=1 to also tee to
 * stderr (useful when running `node dist/relay.js` directly for debugging).
 * Honors AUTOMATE_BROWSER_LOG_LEVEL like the server's stderr logger.
 */
import { appendFileSync } from "node:fs";

import { logPath } from "../utils/log-dir";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const minLevel =
  LEVELS[(process.env.AUTOMATE_BROWSER_LOG_LEVEL ?? "info").toLowerCase() as Level] ?? LEVELS.info;
const foreground = process.env.AUTOMATE_BROWSER_RELAY_FOREGROUND === "1";

/**
 * Where the detached relay writes its log
 * (e.g. `~/.automate-browser/automate-browser-relay.log`).
 * NOT the temp dir - see `utils/log-dir`. This file is the only durable record
 * of a browser dropping off and whether it ever came back, and a swept temp dir
 * had already deleted the one occurrence anybody wanted to read.
 */
export const RELAY_LOG_PATH = logPath("automate-browser-relay.log");

function emit(level: Level, args: unknown[]): void {
  if (LEVELS[level] < minLevel) return;
  const body = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${new Date().toISOString()}] [relay] [${level}] ${body}`;
  try {
    appendFileSync(RELAY_LOG_PATH, line + "\n");
  } catch {
    /* logging must never throw */
  }
  if (foreground) {
    console.error(line);
  }
}

export const rlog = {
  debug: (...a: unknown[]) => emit("debug", a),
  info: (...a: unknown[]) => emit("info", a),
  warn: (...a: unknown[]) => emit("warn", a),
  error: (...a: unknown[]) => emit("error", a),
};
