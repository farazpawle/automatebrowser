/**
 * Server-side helper: guarantee a relay is running and hand back a live
 * controller socket connected to it. Used by `RelayLink` (which the Context
 * wraps). Strategy:
 *
 *   1. Probe the port range for an existing relay (role:"relay"); if found,
 *      open a controller socket to it.
 *   2. Otherwise spawn `dist/relay.js` detached, poll until it answers, connect.
 *
 * Concurrent spawns are safe: each relay binds the lowest free port and a
 * lowest-port tiebreak (relay/index.ts) leaves exactly one survivor; every
 * controller converges on it (re-discovering after a transient miss).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

import { mcpConfig } from "@repo/config/mcp.config";

import { RELAY_ROLE } from "./relay/control";
import { probePort } from "./relay/probe";
import type { AuthChallenge } from "@/utils/auth";
import { parseFrame } from "@/utils/frame";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RelayConnection {
  ws: WebSocket;
  port: number;
  authChallenge?: AuthChallenge;
  /** Ports answering as a legacy direct host (old npx self-hoster) — diagnostics. */
  legacyPorts: number[];
}

/** How long a single controller-socket open waits for the relay's hello. */
const OPEN_TIMEOUT_MS = 1_500;
/** Total budget to wait for a freshly spawned relay to come up. */
const SPAWN_WAIT_MS = 4_000;

interface RangeScan {
  /** Lowest port answering with a relay hello, or null. */
  relayPort: number | null;
  /** Ports answering as a `automate-browser` host WITHOUT role:"relay" (legacy). */
  legacyPorts: number[];
}

/** Scan the range, distinguishing the relay from any legacy direct hosts. */
async function scanRange(): Promise<RangeScan> {
  const [start, end] = mcpConfig.wsPortRange;
  let relayPort: number | null = null;
  const legacyPorts: number[] = [];
  for (let p = start; p <= end; p++) {
    const hello = await probePort(p, 400);
    if (!hello) continue;
    if (hello.role === RELAY_ROLE) {
      if (relayPort == null) relayPort = p;
    } else if (hello.server === "automate-browser") {
      legacyPorts.push(p);
    }
  }
  return { relayPort, legacyPorts };
}

interface OpenedController {
  ws: WebSocket;
  authChallenge?: AuthChallenge;
}

/** Open a controller socket and resolve once the relay's hello is verified. */
function openController(port: number): Promise<OpenedController | null> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket;
    const finish = (r: OpenedController | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws?.off("message", onMessage);
      if (!r) {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      }
      resolve(r);
    };
    const onMessage = (raw: unknown) => {
      const msg = parseFrame(raw);
      if (msg?.type === "hello" && msg.payload?.role === RELAY_ROLE) {
        finish({ ws, authChallenge: msg.payload.auth as AuthChallenge | undefined });
      }
    };
    const timer = setTimeout(() => finish(null), OPEN_TIMEOUT_MS);
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      finish(null);
      return;
    }
    ws.on("message", onMessage);
    ws.on("error", () => finish(null));
  });
}

function spawnRelay(version: string): void {
  const relayPath = fileURLToPath(new URL("./relay.js", import.meta.url));
  const child = spawn(process.execPath, [relayPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, AUTOMATE_BROWSER_RELAY_VERSION: version },
  });
  child.unref();
}

export async function ensureRelay(opts: { version: string }): Promise<RelayConnection> {
  // 1. Use an already-running relay if one exists.
  const first = await scanRange();
  if (first.relayPort != null) {
    const ws = await openController(first.relayPort);
    if (ws) {
      return {
        ws: ws.ws,
        port: first.relayPort,
        authChallenge: ws.authChallenge,
        legacyPorts: first.legacyPorts,
      };
    }
  }

  // 2. Spawn one and wait for it to come up.
  spawnRelay(opts.version);
  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    const scan = await scanRange();
    if (scan.relayPort != null) {
      const ws = await openController(scan.relayPort);
      if (ws) {
        return {
          ws: ws.ws,
          port: scan.relayPort,
          authChallenge: ws.authChallenge,
          legacyPorts: scan.legacyPorts,
        };
      }
    }
    await wait(120);
  }
  throw new Error(
    "AutomateBrowser relay did not start. Another (older) AutomateBrowser server may be holding the port range — close other IDEs' servers or restart, then retry.",
  );
}
