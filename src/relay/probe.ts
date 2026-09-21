/**
 * Short-lived client probe of a candidate port: open a socket, read the server's
 * `hello`, return its payload, then close. Used to (a) discover a running relay
 * and (b) distinguish a relay (`role:"relay"`) from a legacy direct host. Binds
 * nothing — purely a connect-and-read.
 */
import { WebSocket } from "ws";

import type { AuthChallenge } from "@/utils/auth";
import { parseFrame } from "@/utils/frame";

export interface ProbeResult {
  server?: string;
  version?: string;
  port?: number;
  role?: string;
  auth?: AuthChallenge;
  /** Legacy direct servers may still echo the token in hello. New relays must not. */
  token?: string;
}

export function probePort(
  port: number,
  timeoutMs = 800,
  host = "127.0.0.1",
): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: WebSocket | undefined;
    const done = (r: ProbeResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      socket = new WebSocket(`ws://${host}:${port}`);
    } catch {
      done(null);
      return;
    }
    socket.on("message", (raw) => {
      const msg = parseFrame(raw);
      if (msg?.type === "hello" && msg.payload) done(msg.payload as ProbeResult);
    });
    socket.on("error", () => done(null));
  });
}
