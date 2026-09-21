/**
 * Browser identity: how this extension instance tells the server whether it is
 * Chrome, Edge, Brave, … plus a stable per-profile id and an optional user
 * label (set in the popup). This is what makes "connect the correct browser"
 * deterministic when several browsers are connected at once.
 */
import { type AuthChallenge, type AuthResponse, type IdentifyPayload } from "./protocol";

const LABEL_KEY = "local:browserLabel";
const INSTANCE_KEY = "local:instanceId";
const TOKEN_KEY = "local:authToken";
const HOST_KEY = "local:relayHost";

/** Normalise the running browser to a short family name. */
export function detectBrowser(): string {
  try {
    const brands = (navigator as any).userAgentData?.brands ?? [];
    for (const b of brands) {
      const n = String(b.brand || "").toLowerCase();
      if (n.includes("edge")) return "edge";
      if (n.includes("opera") || n.includes("opr")) return "opera";
    }
  } catch {
    /* userAgentData not available */
  }
  const ua = (navigator.userAgent || "").toLowerCase();
  if (ua.includes("edg/") || ua.includes("edg ")) return "edge";
  if ((navigator as any).brave) return "brave";
  if (ua.includes("opr/")) return "opera";
  return "chrome";
}

function detectVersion(): string {
  try {
    const brands = (navigator as any).userAgentData?.brands ?? [];
    if (brands.length) {
      return brands.map((b: any) => `${b.brand}/${b.version}`).join(", ");
    }
  } catch {
    /* ignore */
  }
  return navigator.userAgent;
}

/** Read the user-set label (e.g. "Work Chrome"), if any. */
export async function getLabel(): Promise<string | undefined> {
  const v = await chrome.storage.local.get(LABEL_KEY);
  const label = v[LABEL_KEY];
  return typeof label === "string" && label.trim() ? label : undefined;
}

export async function setLabel(label: string): Promise<void> {
  await chrome.storage.local.set({ [LABEL_KEY]: label });
}

/**
 * Optional shared-secret token (set in the popup) for WS auth. New relays prove
 * possession with a challenge-response; the raw token is only sent to legacy
 * direct hosts that still use the old token-echo handshake.
 */
export async function getAuthToken(): Promise<string | undefined> {
  const v = await chrome.storage.local.get(TOKEN_KEY);
  const t = v[TOKEN_KEY];
  return typeof t === "string" && t.trim() ? t.trim() : undefined;
}

export async function setAuthToken(token: string): Promise<void> {
  const t = token.trim();
  if (t) await chrome.storage.local.set({ [TOKEN_KEY]: t });
  else await chrome.storage.local.remove(TOKEN_KEY);
}

/** Addresses that cannot leave this machine. Mirrors `src/utils/host.ts`. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h.startsWith("127.");
}

/**
 * C13 — which machine the relay is on. Loopback unless the user typed something
 * else in the popup, which is how this browser can be driven by an IDE on
 * ANOTHER machine.
 *
 * A non-loopback host with NO token is ignored and loopback used instead: this
 * socket lets whoever is on the other end drive the browser the user is signed
 * into, so an unauthenticated link to a remote address is refused on this side
 * too, exactly as the relay refuses to listen on one.
 */
export async function getRelayHost(): Promise<string> {
  const v = await chrome.storage.local.get(HOST_KEY);
  const raw = typeof v[HOST_KEY] === "string" ? v[HOST_KEY].trim() : "";
  if (!raw || isLoopbackHost(raw)) return raw || "127.0.0.1";
  return (await getAuthToken()) ? raw : "127.0.0.1";
}

/** The stored value as typed, for the popup — never the loopback substitution. */
export async function getRelayHostSetting(): Promise<string> {
  const v = await chrome.storage.local.get(HOST_KEY);
  return typeof v[HOST_KEY] === "string" ? v[HOST_KEY] : "";
}

export async function setRelayHost(host: string): Promise<void> {
  const h = host.trim();
  if (h && !isLoopbackHost(h)) await chrome.storage.local.set({ [HOST_KEY]: h });
  else await chrome.storage.local.remove(HOST_KEY);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function signAuthChallenge(
  token: string,
  auth: AuthChallenge,
): Promise<AuthResponse> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(auth.challenge));
  return {
    scheme: auth.scheme,
    challenge: auth.challenge,
    response: base64Url(new Uint8Array(sig)),
  };
}

/**
 * One-time cleanup of the obsolete port pin. The singleton relay always owns the
 * lowest free port (9009), so a manual pin could only ever dial a dead port; the
 * popup field and the pin logic were removed. This clears any leftover value from
 * an older install. Safe to call repeatedly.
 */
export async function clearObsoletePinnedPort(): Promise<void> {
  try {
    await chrome.storage.local.remove("local:pinnedPort");
  } catch {
    /* best-effort */
  }
}

/** Stable id for this browser profile, generated once and persisted. */
export async function getInstanceId(): Promise<string> {
  const v = await chrome.storage.local.get(INSTANCE_KEY);
  const stored = v[INSTANCE_KEY];
  let id: string | undefined = typeof stored === "string" ? stored : undefined;
  if (!id) {
    id = crypto.randomUUID();
    await chrome.storage.local.set({ [INSTANCE_KEY]: id });
  }
  return id;
}

/** Build the identify payload, enriching with a representative tab when available. */
export async function buildIdentify(
  tabId?: number,
  auth?: AuthResponse,
  legacyToken?: string,
): Promise<IdentifyPayload> {
  const [label, instanceId] = await Promise.all([
    getLabel(),
    getInstanceId(),
  ]);
  const payload: IdentifyPayload = {
    browser: detectBrowser(),
    browserVersion: detectVersion(),
    label,
    instanceId,
    auth,
    token: legacyToken,
  };
  try {
    // Use the given tab, or fall back to the active tab so the server's client
    // list shows a representative URL/title even with no explicit selection.
    const tab = (
      tabId != null
        ? await chrome.tabs.get(tabId)
        : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
    ) as chrome.tabs.Tab | undefined;
    if (tab?.id != null) {
      payload.tabId = tab.id;
      payload.tabUrl = typeof tab.url === "string" ? tab.url : undefined;
      payload.tabTitle = typeof tab.title === "string" ? tab.title : undefined;
    }
  } catch {
    /* best-effort */
  }
  return payload;
}
