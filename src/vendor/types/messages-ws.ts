/**
 * Local replacement for `@repo/types/messages/ws`. The half of the WebSocket
 * contract that has no tool behind it: the control plane, and the reads whose
 * ANSWER is a fixed type worth declaring.
 *
 * Everything a tool sends lives in `src/tools/messages.ts` instead, derived from
 * that tool's zod schema. This file used to declare those too, by hand, and by
 * 2026-09-08 it was 20 entries against ~50 actual message types with the payloads
 * of the ones it did have out of date — so the tool layer sent everything through
 * `as any` and the contract was off. Nothing that a schema can describe belongs
 * here again; the two maps are joined as `WireMessageMap`, and a duplicated key
 * is a type error rather than a silent winner.
 *
 * Control messages added for robust multi-browser connection:
 *  - `hello`    (server -> extension) sent on open so the extension can verify
 *               it connected to a real automate-browser server before trusting it.
 *  - `identify` (extension -> server) sent right after `hello` is validated so
 *               the server can tell Chrome from Edge and label each client.
 */

export interface HelloPayload {
  /** Always the literal "automate-browser"; the extension rejects anything else. */
  server: "automate-browser";
  version: string;
  port: number;
}

export interface IdentifyPayload {
  /** Normalised browser family, e.g. "chrome" | "edge" | "brave". */
  browser: string;
  browserVersion?: string;
  /** Optional user-set friendly name from the popup, e.g. "Work Chrome". */
  label?: string;
  /** Stable per-profile id persisted in the extension's storage. */
  instanceId?: string;
  tabId?: number;
  tabUrl?: string;
  tabTitle?: string;
}

/**
 * "This message carries no payload." Written as an empty RECORD rather than `{}`
 * because `{}` in TypeScript means "any non-nullish value" — it would accept `0`
 * or `"x"` where a payload object belongs, which is the opposite of the intent.
 */
type NoPayload = Record<string, never>;

export interface SocketMessageMap {
  // ── timing ────────────────────────────────────────────────────────────────
  /** No tool schema of its own: `browser_wait` forwards the vendored `WaitTool` shape. */
  browser_wait: { payload: { time: number }; response: void };

  // ── reads with a fixed answer (called by the snapshot helper, not by a tool) ─
  browser_snapshot: { payload: { verbose?: boolean }; response: string };
  browser_snapshot_full: {
    payload: { verbose?: boolean };
    response: { url: string; title: string; snapshot: string };
  };
  getUrl: { payload: NoPayload; response: string };
  getTitle: { payload: NoPayload; response: string };

  // ── control plane ─────────────────────────────────────────────────────────
  hello: { payload: HelloPayload; response: void };
  identify: { payload: IdentifyPayload; response: void };
}
