/**
 * User-facing connection strings + client rendering, shared so the wording is
 * identical wherever it surfaces (Context disambiguation errors, tool output).
 * Verbatim copies of the strings that previously lived in `src/context.ts`.
 */
import type { ClientInfo } from "./types";

export const noConnectionMessage = `No connection to browser extension. Make sure the AutomateBrowser extension is installed and enabled — it connects automatically (there is no 'Connect' button). If it was just installed, the browser was idle, or you're on a restricted page (chrome://, the Web Store, a PDF), open the extension popup to wake it (or wait a few seconds for it to reconnect), open a normal http(s) tab, then retry.`;

/** Relay is reachable but no browser is connected to it right now. */
export const relayUpNoBrowsersMessage = `The AutomateBrowser relay is running but no browser is connected to it. Open a browser that has the AutomateBrowser extension on a normal http(s) tab (not chrome://, the Web Store, or a PDF), then retry. Use browser_status to see what the relay can currently see.`;

/** The relay link dropped mid-call; the controller auto-reconnects. */
export const relayClosedMessage = `Lost the connection to the AutomateBrowser relay (it may be restarting). This is usually transient — retry in a moment.`;

/** Render the connected-browser list (the `*` marks the active one). */
export function renderClients(clients: ClientInfo[]): string {
  return clients
    .map((c) => {
      const label = c.label ? ` "${c.label}"` : "";
      const tab = c.tabUrl ? ` — ${c.tabTitle ?? ""} ${c.tabUrl}` : "";
      const star = c.active ? "* " : "  ";
      return `${star}[id=${c.id.slice(0, 8)}] ${c.browser}${label}${tab}`;
    })
    .join("\n");
}
