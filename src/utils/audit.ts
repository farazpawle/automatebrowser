/**
 * B10 — action audit log.
 *
 * `src/relay/log-file.ts` records relay TRAFFIC. This records what the agent
 * DID in the user's real, logged-in browser: one JSON line per tool call, with
 * the tool, the browser and tab it was aimed at, the URL when there was one, the
 * outcome and how long it took.
 *
 * ON BY DEFAULT, deliberately. This server drives a browser the user is signed
 * into on their own machine; "what did it touch?" has to be answerable *after*
 * something looks wrong, not only if you thought to switch on logging before it
 * happened. `AUTOMATE_BROWSER_AUDIT=off` turns it off, and
 * `AUTOMATE_BROWSER_AUDIT_FILE` moves it.
 *
 * It lives in `~/.automate-browser/`, NOT the temp dir. Rotation deliberately
 * keeps a predecessor so a trail outlives one session, and a swept temp dir
 * silently voids that: measured 2026-09-02, nothing in %TEMP% survived a day.
 * See `utils/log-dir`.
 *
 * Explicitly NOT telemetry: the file is local, nothing is sent anywhere, and the
 * roadmap rejected phoning home outright.
 */
import { appendFileSync, readFileSync, renameSync, statSync } from "node:fs";

import type { ToolOutcome } from "@/tools/tool";

import { debugLog } from "./log";
import { logPath } from "./log-dir";

/** Rotate at 1 MB, keeping exactly one predecessor. Enough to see a session, bounded. */
const MAX_BYTES = 1_048_576;

/** Argument values are for identifying a call, not for reproducing it. */
const MAX_VALUE_CHARS = 120;

/**
 * Parameter names whose VALUE never reaches the file. An audit log that records
 * the password the agent typed is worse than no audit log — it turns a
 * transparency feature into a credential store on disk. The length
 * is kept, so "it typed 14 characters into the password box" is still on record.
 */
const SECRET_PARAMS = new Set([
  "text",
  "value",
  "values",
  "token",
  "password",
  "secret",
  "cookie",
  "cookies",
  "auth",
  "authorization",
  "headers",
  "apikey",
  "api_key",
  "fields",
]);

export interface AuditEntry {
  tool: string;
  args?: Record<string, unknown>;
  agent: string;
  ctrl?: string;
  browser?: string;
  tabId?: number;
  ok: boolean;
  /**
   * I04 — which of the five outcomes this was. `ok` is the two-value summary a
   * reader scans for; this is the one that distinguishes a policy refusal that
   * sent nothing from a click whose reply was lost and may well have landed.
   * A closed enum, so it needs no redaction of its own.
   */
  outcome?: ToolOutcome;
  ms: number;
  error?: string;
}

function enabled(): boolean {
  const v = (process.env.AUTOMATE_BROWSER_AUDIT ?? "").toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

/** Where the audit trail is written. Read by `browser_status` so a human can find it. */
export function auditPath(): string {
  const custom = process.env.AUTOMATE_BROWSER_AUDIT_FILE?.trim();
  return custom || logPath("automate-browser-audit.log");
}

function shorten(v: unknown): unknown {
  if (typeof v === "string") {
    return v.length > MAX_VALUE_CHARS ? `${v.slice(0, MAX_VALUE_CHARS)}…(${v.length})` : v;
  }
  if (Array.isArray(v)) return v.slice(0, 5).map(shorten);
  if (v && typeof v === "object") return redact(v as Record<string, unknown>);
  return v;
}

/**
 * Secret-named params become a length; everything else is truncated. Both halves
 * matter: redaction stops a credential landing on disk, and truncation stops one
 * `browser_eval` with a megabyte of HTML from making the whole log useless.
 */
export function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith("__")) continue; // internal routing keys, never agent input
    if (SECRET_PARAMS.has(k.toLowerCase())) {
      out[k] = typeof v === "string" ? `<redacted ${v.length} chars>` : "<redacted>";
      continue;
    }
    out[k] = shorten(v);
  }
  return out;
}

function rotateIfNeeded(path: string): void {
  const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
  if (size < MAX_BYTES) return;
  renameSync(path, `${path}.1`);
}

/** Append one line. Never throws — a logging failure must not fail a tool call. */
export function auditRecord(entry: AuditEntry): void {
  if (!enabled()) return;
  const path = auditPath();
  try {
    rotateIfNeeded(path);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      agent: entry.agent,
      ctrl: entry.ctrl?.slice(0, 8),
      tool: entry.tool,
      browser: entry.browser,
      tab: entry.tabId,
      ok: entry.ok,
      outcome: entry.outcome,
      ms: entry.ms,
      ...(entry.error ? { error: entry.error.slice(0, 200) } : {}),
      args: entry.args ? redact(entry.args) : undefined,
    });
    appendFileSync(path, line + "\n");
  } catch (e) {
    debugLog(`[audit] not written: ${String(e)}`);
  }
}

/**
 * The last `n` entries, newest last, rendered one per line for `browser_status`.
 * Returns an empty array when auditing is off or nothing has been logged yet.
 */
export function auditTail(n: number): string[] {
  if (!enabled()) return [];
  try {
    const raw = readFileSync(auditPath(), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .slice(-n)
      .map((line) => {
        try {
          const e = JSON.parse(line);
          const target = [e.browser, e.tab != null ? `tab ${e.tab}` : undefined]
            .filter(Boolean)
            .join(" ");
          const url = typeof e.args?.url === "string" ? ` ${e.args.url}` : "";
          // The outcome only earns a place when it says something `ok` does not:
          // "partial" and "unknown" are the two a reader must not skim past.
          const shade = e.outcome === "partial" || e.outcome === "unknown" ? ` (${e.outcome})` : "";
          return `  ${String(e.ts).slice(11, 19)} ${e.ok ? "ok " : "ERR"} ${e.tool}${url}${shade}${target ? ` → ${target}` : ""}`;
        } catch {
          return `  ${line.slice(0, 120)}`;
        }
      });
  } catch {
    return [];
  }
}

/** One line for `browser_status`: where the trail is, or that it is switched off. */
export function describeAudit(): string {
  return enabled()
    ? `audit: ${auditPath()} (set AUTOMATE_BROWSER_AUDIT=off to stop recording)`
    : "audit: off (AUTOMATE_BROWSER_AUDIT)";
}
