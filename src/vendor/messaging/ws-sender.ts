/**
 * Local replacement for `@r2r/messaging/ws/sender` — a REAL request/response
 * WebSocket sender matching the AutomateBrowser extension wire protocol:
 *   request  (server -> ext): { id, type, payload }
 *   response (ext -> server): { type: "messageResponse",
 *                               payload: { requestId, result, error } }
 *
 * Correlation is by `payload.requestId === id`. Ported from the proven
 * `dist/utils.js` implementation and typed against the socket message map.
 */
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

import type { MessagePayload, MessageType } from "./types";

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface SendOptions {
  timeoutMs?: number;
}

/** Fail-fast fallback budget. Callers (Context) normally pass an explicit value. */
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * The response envelope, as far as correlation cares. Kept here rather than
 * imported from `@/utils/frame`: nothing else under `src/vendor` reaches into
 * repo code, and this file is a drop-in replacement for a package.
 */
type ResponseFrame = {
  type?: string;
  payload?: { requestId?: unknown; result?: unknown; error?: unknown };
};

function parseResponse(raw: unknown): ResponseFrame | undefined {
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return parsed !== null && typeof parsed === "object" ? (parsed as ResponseFrame) : undefined;
  } catch {
    return undefined; // ignore non-JSON frames
  }
}

export function createSocketMessageSender<TMap>(ws: WebSocket) {
  function sendSocketMessage<T extends MessageType<TMap>>(
    type: T,
    payload: MessagePayload<TMap, T>,
    options: SendOptions = { timeoutMs: DEFAULT_TIMEOUT_MS },
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket is not connected"));
        return;
      }
      const id = randomUUID();
      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", onMessage);
      };
      const onMessage = (raw: unknown) => {
        const msg = parseResponse(raw);
        if (!msg || msg.type !== "messageResponse") return;
        const body = msg.payload;
        if (!body || body.requestId !== id) return; // not our reply
        cleanup();
        if (body.error) {
          const err = body.error;
          reject(
            new Error(
              typeof err === "string" ? err : (err as Error)?.message || JSON.stringify(err),
            ),
          );
        } else {
          resolve(body.result);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Socket message timeout"));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      ws.on("message", onMessage);
      try {
        ws.send(JSON.stringify({ id, type, payload }));
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  return { sendSocketMessage };
}
