/**
 * Relay process entry — built to `dist/relay.js` and spawned (detached) by the
 * first MCP server that needs it (see `src/relay-ensure.ts`).
 *
 * Lifecycle:
 *   1. Bind the lowest free port in the range on 127.0.0.1 (loopback by default;
 *      see `resolveHost` for the opt-in remote bind).
 *      If a legacy direct server holds 9009, we simply take the next port; the
 *      updated extension prefers a `role:"relay"` hello, so browsers migrate.
 *   2. Singleton tiebreak: if another relay already holds a LOWER port in the
 *      range (e.g. we lost a spawn race), defer to it and exit. The lowest-port
 *      relay wins, guaranteeing exactly one relay.
 *   3. Otherwise start serving and stay alive until idle (see startRelay).
 */
import { mcpConfig } from "@repo/config/mcp.config";

import { getAuthToken } from "@/utils/auth";
import { isLoopbackHost } from "@/utils/host";
import { createWebSocketServer } from "@/ws";

import { rlog } from "./log-file";
import { probePort } from "./probe";
import { startRelay } from "./relay";

const version = process.env.AUTOMATE_BROWSER_RELAY_VERSION ?? mcpConfig.server.version;

/**
 * C13 — the bind address. Loopback unless `AUTOMATE_BROWSER_RELAY_HOST` says
 * otherwise, which is how a browser on ANOTHER machine can reach this relay.
 *
 * A non-loopback bind without `AUTOMATE_BROWSER_TOKEN` is REFUSED, not warned
 * about: this socket accepts frames that drive the user's real, logged-in
 * browser, so an unauthenticated listener on a LAN is not a configuration to
 * shrug at. The extension enforces the same rule on its own side, so neither end
 * can be talked into an open link by the other.
 *
 * Returns `null` when the configuration is refused.
 */
function resolveHost(): string | null {
  const raw = process.env.AUTOMATE_BROWSER_RELAY_HOST?.trim();
  if (!raw) return "127.0.0.1";
  if (isLoopbackHost(raw)) return raw;
  if (!getAuthToken()) {
    rlog.error(
      `AUTOMATE_BROWSER_RELAY_HOST=${raw} would make this relay reachable from other machines, ` +
        `but AUTOMATE_BROWSER_TOKEN is not set. Refusing to listen without a shared secret — ` +
        `set AUTOMATE_BROWSER_TOKEN to the same value here and in the browser extension's popup, ` +
        `or unset AUTOMATE_BROWSER_RELAY_HOST to stay on loopback.`,
    );
    return null;
  }
  rlog.warn(
    `binding ${raw} — this relay is reachable from other machines on the network ` +
      `(token required, and every peer must prove it).`,
  );
  return raw;
}

async function main(): Promise<void> {
  const host = resolveHost();
  if (host === null) {
    process.exit(1);
    return;
  }

  let bound;
  try {
    // Loopback by default; the first free port in the range wins.
    bound = await createWebSocketServer(mcpConfig.wsPortRange, host);
  } catch (e) {
    rlog.error("failed to bind any port in range; exiting", String(e));
    process.exit(0);
    return;
  }
  const { wss, port } = bound;

  // Both scans stay on LOOPBACK on purpose: a relay bound to a wildcard or LAN
  // address is still reachable at 127.0.0.1, and probing a wildcard address is
  // not a connection anyone can make.
  // Defer to any relay already holding a lower port (spawn-race / legacy-host).
  const [start, end] = mcpConfig.wsPortRange;
  for (let p = start; p < port; p++) {
    const hello = await probePort(p, 400);
    if (hello && hello.role === "relay") {
      rlog.info(`another relay already on :${p}; exiting (this would be :${port})`);
      try {
        wss.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
      return;
    }
  }

  // Warn about legacy direct hosts (old `npx @automatebrowser/mcp` self-hosters) that
  // squat the range — they capture browsers a controller's relay never sees.
  for (let p = start; p <= end; p++) {
    if (p === port) continue;
    const hello = await probePort(p, 400);
    if (hello && hello.server === "automate-browser" && hello.role !== "relay") {
      rlog.warn(
        `legacy AutomateBrowser server detected on :${p} — it may capture browsers; ` +
          `remove the old npx config and restart that IDE`,
      );
    }
  }

  startRelay(wss, port, version, host);
}

void main();
