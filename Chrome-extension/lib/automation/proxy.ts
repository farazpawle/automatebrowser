/**
 * C12 — proxy control over `chrome.proxy`.
 *
 * THIS IS BROWSER-WIDE. Every other automation handler in this folder acts on
 * one tab; this changes a setting for the whole profile, including the tabs the
 * human is using. That is not an oversight — Chrome has no per-tab proxy — and
 * it is why the roadmap's "browser-wide mutation is suspect" rule (the rule that
 * killed A1 window resize) applies here. It ships because the user explicitly
 * asked for it, with the scope stated in the tool description and in the result
 * of every call that changes anything, and with an off switch that RESTORES the
 * browser's own setting rather than forcing "direct".
 *
 * `chrome.proxy` is an extension-only API — CDP cannot do this cleanly — so this
 * is one of the two places AutomateBrowser can do something chrome-devtools-mcp
 * cannot do at all.
 */

export interface ProxyArgs {
  mode?: "direct" | "system" | "auto_detect" | "fixed_servers" | "pac_script";
  /** For fixed_servers: "host:port", optionally "scheme://host:port". */
  server?: string;
  /** For pac_script: the PAC file URL. */
  pacUrl?: string;
  /** Hosts that bypass the proxy (fixed_servers only). */
  bypass?: string[];
  /** Restore the browser's own setting and stop controlling it. */
  clear?: boolean;
}

export interface ProxyResult {
  mode: string;
  levelOfControl: string;
  changed: boolean;
  /** Human-readable rendering of what is now in force. */
  detail?: string;
  /** Present when this extension is NOT the one in control. */
  warning?: string;
}

function parseServer(server: string): { scheme?: string; host: string; port?: number } {
  const m = server.trim().match(/^(?:(\w+):\/\/)?([^:/]+)(?::(\d+))?$/);
  if (!m) throw new Error(`Not a proxy address: "${server}". Use host:port or scheme://host:port.`);
  return { scheme: m[1] || undefined, host: m[2]!, port: m[3] ? Number(m[3]) : undefined };
}

function describe(value: any): string {
  const mode = value?.mode ?? "unknown";
  if (mode === "fixed_servers") {
    const s = value?.rules?.singleProxy;
    const bypass = value?.rules?.bypassList ?? [];
    return (
      `fixed_servers → ${s ? `${s.scheme ?? "http"}://${s.host}${s.port ? `:${s.port}` : ""}` : "(no single proxy)"}` +
      (bypass.length ? ` (bypass: ${bypass.join(", ")})` : "")
    );
  }
  if (mode === "pac_script") return `pac_script → ${value?.pacScript?.url ?? "(inline script)"}`;
  return String(mode);
}

async function read(): Promise<{ value: any; levelOfControl: string }> {
  return (await chrome.proxy.settings.get({})) as { value: any; levelOfControl: string };
}

export async function setProxy(args: ProxyArgs): Promise<ProxyResult> {
  // An extension built before the permission was added has no chrome.proxy at
  // all. Say which reload fixes it instead of throwing "cannot read settings of
  // undefined" at the agent.
  if (!chrome.proxy?.settings) {
    throw new Error(
      "This browser extension build has no proxy permission. Reload the AutomateBrowser " +
        "extension (chrome://extensions → Reload) and re-approve it, then try again.",
    );
  }

  if (args.clear) {
    await chrome.proxy.settings.clear({ scope: "regular" });
    const after = await read();
    return {
      mode: after.value?.mode ?? "unknown",
      levelOfControl: after.levelOfControl,
      changed: true,
      detail: describe(after.value),
    };
  }

  if (!args.mode) {
    const now = await read();
    return {
      mode: now.value?.mode ?? "unknown",
      levelOfControl: now.levelOfControl,
      changed: false,
      detail: describe(now.value),
    };
  }

  let value: any;
  if (args.mode === "fixed_servers") {
    if (!args.server) throw new Error("mode 'fixed_servers' needs `server` (host:port).");
    const { scheme, host, port } = parseServer(args.server);
    value = {
      mode: "fixed_servers",
      rules: {
        singleProxy: { scheme: scheme ?? "http", host, ...(port ? { port } : {}) },
        ...(args.bypass?.length ? { bypassList: args.bypass } : {}),
      },
    };
  } else if (args.mode === "pac_script") {
    if (!args.pacUrl) throw new Error("mode 'pac_script' needs `pacUrl`.");
    value = { mode: "pac_script", pacScript: { url: args.pacUrl, mandatory: true } };
  } else {
    value = { mode: args.mode };
  }

  await chrome.proxy.settings.set({ value, scope: "regular" });
  const after = await read();
  // Another extension can outrank us. Without this the call would report success
  // while the browser kept routing traffic exactly as before.
  const controlled = after.levelOfControl === "controlled_by_this_extension";
  return {
    mode: after.value?.mode ?? "unknown",
    levelOfControl: after.levelOfControl,
    changed: controlled,
    detail: describe(after.value),
    warning: controlled
      ? undefined
      : `The proxy setting is ${after.levelOfControl.replace(/_/g, " ")} — this change did NOT take effect.`,
  };
}
