/**
 * Loopback test, shared by the relay's bind guard (C13) and `browser_status`'s
 * "reachable from other machines" warning.
 *
 * Its own module for a boring but load-bearing reason: `src/relay/index.ts` is a
 * PROCESS ENTRY — it calls `main()` at import time — so importing anything from
 * it into the server would start a relay bind inside the MCP server.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h.startsWith("127.");
}
