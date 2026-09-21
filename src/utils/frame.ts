/**
 * One decoder for the `{ type, payload }` envelope every WebSocket peer here
 * speaks — the relay, the relay probe, the controller link and the direct sender
 * each had their own copy of the same four-line try/catch, each with the parsed
 * frame typed `any` so nothing downstream was checked either.
 *
 * `payload` stays `Record<string, unknown>`: this only says the frame WAS a JSON
 * object, never what is in it. Narrow every field before you trust it — a frame
 * arrives from another process and can say anything.
 */
export interface Frame {
  type?: string;
  payload?: Record<string, unknown>;
}

/** Decode one frame, or `undefined` if it is not JSON or not an object. */
export function parseFrame(raw: unknown): Frame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === "object" ? (parsed as Frame) : undefined;
}
