/**
 * Emulation (roadmap A4 + A5), one handler, two halves.
 *
 * DEBUGGER-FREE (A4): geolocation and extra request headers.
 * OPT-IN CDP (A5): colour scheme, device viewport, user agent, network and CPU
 * throttling. Each of those refuses with `ADVANCED_MODE_REQUIRED` when the
 * debugger is not attached, rather than silently doing nothing or falling back
 * to something that only usually works.
 *
 * **What the debugger-free geolocation override does NOT do, verified rather
 * than assumed.** It is injected into the page AFTER load, so a site that asks
 * for a position while it is booting has already asked. Nothing debugger-free
 * fixes that: `chrome.scripting.registerContentScripts` takes bundled FILE
 * paths, never code supplied at call time (established by C9), so agent-supplied
 * values cannot reach a `document_start` script. The before-boot case already
 * has an answer — `browser_navigate {initScript}`, which is CDP and says so.
 * Most real prompts are raised on a user action ("use my location"), which this
 * does catch.
 *
 * Options are turned off by naming them in `clear`, not by passing null: a
 * nullable option costs an `anyOf` wrapper in the JSON schema, and seven of them
 * cost more than the one array does. An emulation that cannot be switched off is
 * a tab the user has to close, so the off switch is not optional — only its
 * shape was chosen for price.
 */
import * as cdp from "./cdp";
import { runFunc } from "./run-func";

/** Our header rules live in their own id band. B9's block rules own 91000-91499. */
const HEADER_RULE_ID_BASE = 91_500;
const MAX_HEADER_RULES = 100;

export interface EmulateArgs {
  /** `[latitude, longitude]` — an array, not an object: the schema is cheaper. */
  geolocation?: number[];
  headers?: Record<string, string>;
  colorScheme?: "light" | "dark";
  /** `[width, height]`. */
  viewport?: number[];
  mobile?: boolean;
  userAgent?: string;
  network?: "offline" | "slow-3g" | "fast-3g" | "slow-4g";
  cpuThrottling?: number;
  /** Names of options to turn off. A `null` per option would have cost an `anyOf` each. */
  clear?: string[];
}

/**
 * Both pair options arrive as plain `number[]`, not as tuples.
 *
 * The server's zod schema does pin them to exactly two numbers — but `.length(2)`
 * on an array refines the VALUE and not the inferred type, so `number[]` is what
 * the generated contract says and what actually crosses the wire. These were
 * declared `[number, number]` here until 2026-09-14: a claim about data this side
 * never checks, which would have handed CDP `undefined` for a width the moment
 * the server's parse stopped being the only thing standing behind it.
 */
function pair(v: number[] | undefined, option: string): [number, number] | undefined {
  if (!v) return undefined;
  const [a, b] = v;
  if (typeof a !== "number" || typeof b !== "number") {
    throw new Error(
      `BAD_ARGS: ${option} needs exactly two numbers, got ${JSON.stringify(v)}.`,
    );
  }
  return [a, b];
}

/** What is currently emulated, per tab, so `browser_emulate {}` can report it. */
type ActiveState = Omit<EmulateArgs, "clear">;
const active = new Map<number, ActiveState>();

/** Downlink/uplink/latency per preset. Named presets cost far fewer schema tokens than four numbers. */
const NETWORK_PRESETS: Record<string, { download: number; upload: number; latency: number; offline: boolean }> = {
  offline: { download: 0, upload: 0, latency: 0, offline: true },
  "slow-3g": { download: (400 * 1024) / 8, upload: (400 * 1024) / 8, latency: 2000, offline: false },
  "fast-3g": { download: (1.6 * 1024 * 1024) / 8, upload: (750 * 1024) / 8, latency: 562, offline: false },
  "slow-4g": { download: (3 * 1024 * 1024) / 8, upload: (1.5 * 1024 * 1024) / 8, latency: 150, offline: false },
  "no-throttle": { download: -1, upload: -1, latency: 0, offline: false },
};

/**
 * Override `navigator.geolocation` in the page's MAIN world. Self-contained:
 * `runFunc` serialises it by source.
 */
function geoPage(lat: number | null, lon: number | null, accuracy: number): boolean {
  const w = window as any;
  if (lat === null || lon === null) {
    if (w.__bmcpGeoOriginal) {
      navigator.geolocation.getCurrentPosition = w.__bmcpGeoOriginal.get;
      navigator.geolocation.watchPosition = w.__bmcpGeoOriginal.watch;
      delete w.__bmcpGeoOriginal;
    }
    return true;
  }
  if (!w.__bmcpGeoOriginal) {
    w.__bmcpGeoOriginal = {
      get: navigator.geolocation.getCurrentPosition.bind(navigator.geolocation),
      watch: navigator.geolocation.watchPosition.bind(navigator.geolocation),
    };
  }
  const position = {
    coords: {
      latitude: lat,
      longitude: lon,
      accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: Date.now(),
  };
  navigator.geolocation.getCurrentPosition = (ok: any) => ok(position);
  // A watch that never fires again is indistinguishable from a broken one, so
  // deliver the fixed position once and hand back a real (unused) id.
  navigator.geolocation.watchPosition = (ok: any) => {
    ok(position);
    return 1;
  };
  return true;
}

async function setHeaders(headers: Record<string, string> | null): Promise<void> {
  if (!chrome.declarativeNetRequest) {
    throw new Error(
      "declarativeNetRequest permission not granted in the extension — reload the rebuilt extension.",
    );
  }
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .map((r) => r.id)
    .filter((id) => id >= HEADER_RULE_ID_BASE && id < HEADER_RULE_ID_BASE + MAX_HEADER_RULES);
  const entries = Object.entries(headers ?? {}).slice(0, MAX_HEADER_RULES);
  // One rule carrying every header: a rule per header would burn the quota and
  // they all apply to the same requests anyway.
  const addRules = entries.length
    ? [
        {
          id: HEADER_RULE_ID_BASE,
          priority: 1,
          action: {
            type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
            requestHeaders: entries.map(([header, value]) => ({
              header,
              operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
              value,
            })),
          },
          condition: { urlFilter: "*" },
        },
      ]
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

function requireAdvanced(tabId: number, what: string): void {
  if (!cdp.isAttached(tabId)) {
    throw new Error(
      `ADVANCED_MODE_REQUIRED: ${what} needs the debugger. Call browser_advanced_mode {enable:true} first.`,
    );
  }
}

export async function emulate(
  tabId: number,
  args: EmulateArgs,
): Promise<{ active: ActiveState; applied: string[] }> {
  const state: ActiveState = active.get(tabId) ?? {};
  const applied: string[] = [];
  const off = new Set(args.clear ?? []);
  /** "set", "clear", or nothing to do for this option. */
  const asked = (k: keyof EmulateArgs): "set" | "clear" | null =>
    Object.prototype.hasOwnProperty.call(args, k) && args[k] !== undefined
      ? "set"
      : off.has(k)
        ? "clear"
        : null;

  const geo = asked("geolocation");
  if (geo) {
    const g = geo === "set" ? pair(args.geolocation, "geolocation")! : null;
    await runFunc(tabId, geoPage, [g ? g[0] : null, g ? g[1] : null, 10], "MAIN");
    if (g) state.geolocation = g;
    else delete state.geolocation;
    applied.push("geolocation");
  }

  const hdr = asked("headers");
  if (hdr) {
    const h = hdr === "set" ? args.headers! : null;
    await setHeaders(h);
    if (h && Object.keys(h).length) state.headers = h;
    else delete state.headers;
    applied.push("headers");
  }

  const cs = asked("colorScheme");
  if (cs) {
    requireAdvanced(tabId, "colorScheme");
    await cdp.sendCommand(tabId, "Emulation.setEmulatedMedia", {
      features:
        cs === "set" ? [{ name: "prefers-color-scheme", value: args.colorScheme }] : [],
    });
    if (cs === "set") state.colorScheme = args.colorScheme;
    else delete state.colorScheme;
    applied.push("colorScheme");
  }

  // `mobile` is not an option of its own — it modifies the viewport override, so
  // a change to it re-applies the viewport rather than doing nothing.
  const vp = asked("viewport") ?? (asked("mobile") && state.viewport ? "set" : null);
  if (vp) {
    requireAdvanced(tabId, "viewport");
    const v = vp === "set" ? pair(args.viewport ?? state.viewport, "viewport") : undefined;
    const mobile = args.mobile ?? state.mobile ?? false;
    if (v) {
      await cdp.sendCommand(tabId, "Emulation.setDeviceMetricsOverride", {
        width: v[0],
        height: v[1],
        deviceScaleFactor: 0,
        mobile,
      });
      // `mobile` on setDeviceMetricsOverride changes LAYOUT only — it does not
      // give the page touch support, so `'ontouchstart' in window` stayed false
      // and `navigator.maxTouchPoints` stayed 0 (checked on a real page
      // 2026-08-27). Any site that feature-detects touch took the desktop path
      // while claiming to be emulating a phone. Touch is its own CDP domain.
      await cdp.sendCommand(tabId, "Emulation.setTouchEmulationEnabled", {
        enabled: mobile,
        maxTouchPoints: mobile ? 5 : 1,
      });
      state.viewport = v;
      state.mobile = mobile;
    } else {
      await cdp.sendCommand(tabId, "Emulation.clearDeviceMetricsOverride", {});
      // Clearing the viewport must clear the touch override with it, or a tab
      // keeps pretending to be a touch device after emulation is switched off.
      await cdp.sendCommand(tabId, "Emulation.setTouchEmulationEnabled", {
        enabled: false,
      });
      delete state.viewport;
      delete state.mobile;
    }
    applied.push("viewport");
  }

  const ua = asked("userAgent");
  if (ua) {
    requireAdvanced(tabId, "userAgent");
    // There is no clearUserAgentOverride; an empty string restores the default.
    await cdp.sendCommand(tabId, "Network.setUserAgentOverride", {
      userAgent: ua === "set" ? args.userAgent : "",
    });
    if (ua === "set") state.userAgent = args.userAgent;
    else delete state.userAgent;
    applied.push("userAgent");
  }

  const net = asked("network");
  if (net) {
    requireAdvanced(tabId, "network");
    const key = net === "set" ? args.network! : "no-throttle";
    const preset = NETWORK_PRESETS[key];
    if (!preset) throw new Error(`Unknown network preset "${key}".`);
    await cdp.sendCommand(tabId, "Network.emulateNetworkConditions", {
      offline: preset.offline,
      downloadThroughput: preset.download,
      uploadThroughput: preset.upload,
      latency: preset.latency,
    });
    if (net === "set") state.network = args.network;
    else delete state.network;
    applied.push("network");
  }

  const cpu = asked("cpuThrottling");
  if (cpu) {
    requireAdvanced(tabId, "cpuThrottling");
    const rate = cpu === "set" ? args.cpuThrottling! : 1;
    await cdp.sendCommand(tabId, "Emulation.setCPUThrottlingRate", { rate });
    if (rate > 1) state.cpuThrottling = rate;
    else delete state.cpuThrottling;
    applied.push("cpuThrottling");
  }

  active.set(tabId, state);
  return { active: visible(tabId, state), applied };
}

/**
 * CDP overrides die with the debugger session — Chrome clears them on detach,
 * and the user can detach from the banner without telling us. So the CDP-only
 * half of the state is filtered at READ time rather than cleaned up on an event
 * we might not receive; reporting an emulation that is no longer in force is
 * worse than reporting none.
 */
function visible(tabId: number, state: ActiveState): ActiveState {
  if (cdp.isAttached(tabId)) return state;
  const { geolocation, headers } = state;
  return { ...(geolocation ? { geolocation } : {}), ...(headers ? { headers } : {}) };
}

/**
 * The slowdown every fixed wait must be scaled by while this tab is throttled
 * (B3's amendment). A 4x CPU throttle makes a 1000ms actionability gate wrong.
 */
export function waitMultiplier(tabId: number): number {
  if (!cdp.isAttached(tabId)) return 1;
  const s = active.get(tabId);
  const cpu = s?.cpuThrottling && s.cpuThrottling > 1 ? s.cpuThrottling : 1;
  const net = s?.network ? 2 : 1;
  return Math.min(cpu * net, 8);
}
