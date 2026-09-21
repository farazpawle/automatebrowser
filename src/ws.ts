import { WebSocketServer } from "ws";

import { mcpConfig } from "@repo/config/mcp.config";

import { debugLog, log } from "@/utils/log";

const MAX_BIND_ROUNDS = 3;
const INITIAL_BACKOFF_MS = 100;
/**
 * WebSocket frame ceiling for the relay.
 *
 * 64 MiB, NOT the 1 MiB it used to be. Found by a real-browser check on
 * 2026-08-27: a `browser_perf_trace` reply is a whole Chrome trace, which is
 * never under 1 MiB even for an idle recording. `ws` does not truncate an
 * oversized frame — it errors and CLOSES the socket, so the browser was dropped
 * and silently reconnected, and the agent saw a bare "Socket message timeout"
 * that named nothing. The relay log said `RangeError: Max payload size exceeded`
 * three times for three attempts.
 *
 * The smoke harness could never have caught this: its fake browser replies are
 * a few hundred bytes.
 *
 * ponytail: a flat ceiling, not chunking. A trace is the only payload anywhere
 * near this size; if something later needs to stream more than 64 MiB, chunk the
 * response rather than raising this again.
 */
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1_048_576;
/**
 * With no explicit allow-list, ANY `chrome-extension://` origin is accepted.
 *
 * It was one pinned origin until 2026-09-21 — the id the manifest `key` forced.
 * That key was browsermcp.io's, inherited in the fork, and removing it was the
 * point: an unpacked load now gets a RANDOM id per profile and the store will
 * assign a different one again. A pinned default would refuse the very extension
 * this server exists to talk to, and there is no id to pin in its place.
 *
 * What the check is FOR is unchanged. A malicious web page dialling
 * `ws://127.0.0.1:9009` sends an `http(s)` Origin and is still refused — that is
 * the browser-borne attack this closes, and it does not depend on knowing an id.
 * Narrowing back to exact origins is still available through
 * `AUTOMATE_BROWSER_EXTENSION_ORIGINS`; it just cannot be the default any more.
 *
 * Note what this has NEVER closed: a local Node process sends no Origin at all
 * and is allowed unconditionally, because every controller relies on that. This
 * is a guard against callers inside a browser, not general access control.
 */
const EXTENSION_ORIGIN_SCHEME = "chrome-extension://";

/** The operator's explicit allow-list, or `null` when they have not set one. */
function configuredExtensionOrigins(): Set<string> | null {
  const raw = process.env.AUTOMATE_BROWSER_EXTENSION_ORIGINS;
  if (!raw) return null;
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  // Set-but-empty (`""`, `" , "`) reads as unset rather than as "allow nothing".
  // The variable exists to NARROW; a stray value that silently severed the
  // extension would surface only as a 403 in a log nobody is reading.
  return values.length ? new Set(values) : null;
}

function maxPayloadBytes(): number {
  const n = Number(process.env.AUTOMATE_BROWSER_WS_MAX_PAYLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PAYLOAD_BYTES;
}

export function isAllowedWsOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // Node/ws controllers and local probes do not set Origin.
  const pinned = configuredExtensionOrigins();
  if (pinned) return pinned.has(origin);
  return origin.startsWith(EXTENSION_ORIGIN_SCHEME);
}

function bindOnce(port: number, host: string): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host,
      port,
      maxPayload: maxPayloadBytes(),
      verifyClient(info, done) {
        if (isAllowedWsOrigin(info.origin)) {
          done(true);
          return;
        }
        log.warn(`[ws] rejected websocket origin ${info.origin || "(none)"}`);
        done(false, 403, "Forbidden");
      },
    });
    const onError = (err: Error) => {
      wss.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      wss.off("error", onError);
      resolve(wss);
    };
    wss.once("error", onError);
    wss.once("listening", onListening);
  });
}

export interface BoundServer {
  wss: WebSocketServer;
  port: number;
}

/**
 * Bind a WebSocket host on the first free port in `range` (inclusive). Scanning
 * a small range — rather than insisting on a single port — means a stale/orphan
 * automate-browser instance holding 9009 no longer wedges startup; we simply take the
 * next port, and the extension discovers it by scanning the same range. We never
 * kill the port holder (the old `killProcessOnPort` behaviour), which previously
 * also disconnected a healthy extension.
 */
export async function createWebSocketServer(
  range: readonly [number, number] = mcpConfig.wsPortRange,
  host = "127.0.0.1",
): Promise<BoundServer> {
  const [start, end] = range;
  let lastErr: unknown;
  for (let round = 0; round < MAX_BIND_ROUNDS; round++) {
    for (let port = start; port <= end; port++) {
      try {
        const wss = await bindOnce(port, host);
        log.info(`[ws] listening on ws://${host}:${port}`);
        return { wss, port };
      } catch (err) {
        lastErr = err;
        if ((err as NodeJS.ErrnoException)?.code !== "EADDRINUSE") {
          throw err;
        }
        debugLog(`[ws] port ${port} in use, trying next`);
      }
    }
    const backoff = INITIAL_BACKOFF_MS * 2 ** round;
    debugLog(
      `[ws] ports ${start}-${end} all in use (round ${round + 1}/${MAX_BIND_ROUNDS}), retrying in ${backoff}ms`,
    );
    await new Promise((r) => setTimeout(r, backoff));
  }
  throw new Error(
    `No free port in range ${start}-${end}. Another automate-browser instance is likely running — close it and try again. Last error: ${String(lastErr)}`,
  );
}
