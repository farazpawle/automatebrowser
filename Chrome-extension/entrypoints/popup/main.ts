import {
  clearObsoletePinnedPort,
  getAuthToken,
  getLabel,
  getRelayHostSetting,
  isLoopbackHost,
  setAuthToken,
  setLabel,
  setRelayHost,
} from "../../lib/identity";
import { type AgentClaim, type AgentPeer, WHOLE_TAB } from "../../lib/protocol";
import {
  clearSelectedTab,
  getSelectedTabId,
  setSelectedTabId,
} from "../../lib/selected-tab";

/**
 * The connection is always on (the background service worker owns it), so the
 * popup does not "connect". It shows live SERVER STATUS (is the MCP server
 * running / reachable?) and lets you choose targeting:
 *   - "Pin this tab"      → drive a specific tab, even in the background;
 *   - "Follow active tab" → drive whatever tab is in front (default).
 */
const byId = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const serverEl = byId<HTMLDivElement>("server");
const dotEl = byId<HTMLSpanElement>("dot");
const serverTextEl = byId<HTMLSpanElement>("server-text");
const targetEl = byId<HTMLParagraphElement>("target");
const agentsEl = byId<HTMLDivElement>("agents");
const connectBtn = byId<HTMLButtonElement>("connect");
const disconnectBtn = byId<HTMLButtonElement>("disconnect");
const labelInput = byId<HTMLInputElement>("label");
const tokenInput = byId<HTMLInputElement>("token");
const relayHostInput = byId<HTMLInputElement>("relay-host");
const errorEl = byId<HTMLParagraphElement>("error");

interface ServerStatus {
  connected: boolean;
  port: number | null;
  /** Agents currently driving this browser (relay `agents` push, via background). */
  agents?: AgentClaim[];
  /** All agents CONNECTED to the relay (roster), listed even when idle. */
  roster?: AgentPeer[];
}

async function getServerStatus(): Promise<ServerStatus> {
  try {
    const res = (await chrome.runtime.sendMessage({
      type: "bmcp:getStatus",
    })) as ServerStatus | undefined;
    return res ?? { connected: false, port: null };
  } catch {
    return { connected: false, port: null };
  }
}

function renderServer(status: ServerStatus): void {
  serverEl.classList.remove("checking", "connected", "disconnected");
  if (status.connected) {
    serverEl.classList.add("connected");
    serverTextEl.textContent = `MCP server connected${status.port ? ` · port ${status.port}` : ""}`;
  } else {
    serverEl.classList.add("disconnected");
    serverTextEl.textContent = "MCP server not running — start it, then reopen";
  }
  void dotEl; // styled via CSS; element kept for the colored indicator
}

async function renderTarget(): Promise<void> {
  const pinnedId = await getSelectedTabId();
  if (pinnedId != null) {
    let title = `tab ${pinnedId}`;
    try {
      const t = await chrome.tabs.get(pinnedId);
      title = t.title || t.url || title;
    } catch {
      /* tab gone; selection self-heals on next resolve */
    }
    targetEl.textContent = `Driving: pinned to "${title}"`;
    connectBtn.hidden = true;
    disconnectBtn.hidden = false;
  } else {
    targetEl.textContent = "Driving: the active tab";
    connectBtn.hidden = false;
    disconnectBtn.hidden = true;
  }
}

/** Human label for a claimed tab — resolved locally since the popup runs in the browser. */
async function tabLabel(tabId: number): Promise<string> {
  if (tabId === WHOLE_TAB) return "the active tab";
  try {
    const t = await chrome.tabs.get(tabId);
    return t.title || t.url || `tab ${tabId}`;
  } catch {
    return `tab ${tabId}`; // tab closed since the claim was pushed
  }
}

/**
 * List the agents CONNECTED to the relay (one row per agent), annotating each
 * with the tab(s) it is currently driving on THIS browser — or "idle" when it
 * holds no live lease. This is the key reason a connected agent no longer
 * vanishes (and the name no longer flickers) when its ~60s lease lapses.
 *
 * `roster` is the connected-agent list; `agents` are this browser's live tab
 * claims. An OLDER relay sends no roster — we then fall back to listing just the
 * live claim holders so the panel still works. Built with textContent so
 * untrusted page titles / agent names can never inject markup. Hidden entirely
 * when no agent is connected.
 */
async function renderAgents(
  roster: AgentPeer[],
  agents: AgentClaim[],
): Promise<void> {
  const now = Date.now();
  const live = agents.filter((c) => c.leaseExpiry > now);

  // Tabs each controller is driving right now, keyed by controllerId. An agent
  // can hold claims on several tabs of this browser at once — collect them all.
  const tabsByController = new Map<string, number[]>();
  for (const c of live) {
    const tabs = tabsByController.get(c.controllerId) ?? [];
    tabs.push(c.tabId);
    tabsByController.set(c.controllerId, tabs);
  }

  // Who to list: the connected roster, or (older relay w/o a roster) just the
  // live claim holders synthesised from their claims.
  let peers: AgentPeer[];
  if (roster.length > 0) {
    peers = roster;
  } else {
    const byId = new Map<string, string>();
    for (const c of live) byId.set(c.controllerId, c.controllerName);
    peers = [...byId].map(([id, name]) => ({ id, name }));
  }

  if (peers.length === 0) {
    agentsEl.hidden = true;
    agentsEl.replaceChildren();
    return;
  }

  const rows = await Promise.all(
    peers.map(async (p) => {
      const tabs = tabsByController.get(p.id) ?? [];
      const active = tabs.length > 0;
      return {
        name: p.name,
        active,
        status: active
          ? `driving ${(await Promise.all(tabs.map(tabLabel))).join(", ")}`
          : "idle",
      };
    }),
  );

  agentsEl.replaceChildren();
  const head = document.createElement("div");
  head.className = "agents-head";
  head.textContent = `Connected agents (${peers.length})`;
  agentsEl.append(head);

  for (const r of rows) {
    const row = document.createElement("div");
    row.className = r.active ? "agent-row" : "agent-row idle";
    const dot = document.createElement("span");
    dot.className = "dot";
    const name = document.createElement("span");
    name.className = "agent-name";
    name.textContent = r.name;
    const tab = document.createElement("span");
    tab.className = "agent-tab";
    tab.textContent = r.status;
    row.append(dot, name, tab);
    agentsEl.append(row);
  }
  agentsEl.hidden = false;
}

async function refresh(): Promise<void> {
  const status = await getServerStatus();
  renderServer(status);
  await renderAgents(status.roster ?? [], status.agents ?? []);
  await renderTarget();
}

connectBtn.addEventListener("click", async () => {
  errorEl.textContent = "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
    errorEl.textContent =
      "This page cannot be automated. Open a normal http(s) tab and try again.";
    return;
  }
  await setLabel(labelInput.value.trim());
  await setSelectedTabId(tab.id);
  await renderTarget();
});

disconnectBtn.addEventListener("click", async () => {
  await clearSelectedTab();
  await renderTarget();
});

labelInput.addEventListener("change", () => {
  void setLabel(labelInput.value.trim());
});

// Saving the token changes who the extension trusts → force a reconnect so the
// new value takes effect immediately.
tokenInput.addEventListener("change", async () => {
  await setAuthToken(tokenInput.value);
  try {
    await chrome.runtime.sendMessage({ type: "bmcp:reconnect" });
  } catch {
    /* background may be asleep; it reconnects on its own */
  }
});

// C13: pointing the browser at another machine only takes effect with a token,
// so say so here rather than letting the connection silently fall back.
relayHostInput.addEventListener("change", async () => {
  errorEl.textContent = "";
  const host = relayHostInput.value.trim();
  if (host && !isLoopbackHost(host) && !(await getAuthToken())) {
    errorEl.textContent =
      "Set an auth token first — this browser will not connect to another computer without one.";
    return;
  }
  await setRelayHost(host);
  try {
    await chrome.runtime.sendMessage({ type: "bmcp:reconnect" });
  } catch {
    /* background may be asleep; it reconnects on its own */
  }
});

(async function init() {
  labelInput.value = (await getLabel()) ?? "";
  tokenInput.value = (await getAuthToken()) ?? "";
  relayHostInput.value = await getRelayHostSetting();
  // Discovery is automatic (singleton relay on the lowest free port); the manual
  // port pin was removed. Clear any stale value left by an older install.
  void clearObsoletePinnedPort();
  await refresh();
  // Keep the server indicator live while the popup is open.
  const timer = window.setInterval(() => void refresh(), 1500);
  window.addEventListener("unload", () => window.clearInterval(timer));
})();
