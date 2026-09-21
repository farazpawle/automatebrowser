/**
 * Types shared between the relay process (`src/relay/*`) and the server-side
 * controller code (`src/context.ts`, `src/relay-link.ts`). Kept in one neutral
 * module so the browser-identity shape never drifts between the two sides.
 */

/**
 * Sentinel tab key for a WHOLE-browser claim — used when a controller drives a
 * browser without selecting a specific tab (the legacy single-IDE path). Real
 * Chrome tab ids are always positive, so -1 can never collide with one. A
 * WHOLE claim conflicts with every other controller's claim on that browser;
 * a per-tab claim only conflicts with the same tab (or a WHOLE held by another).
 */
export const WHOLE_TAB = -1;

/** Metadata a connected browser reports about itself via the `identify` frame. */
export interface ClientMeta {
  browser: string;
  browserVersion?: string;
  label?: string;
  instanceId?: string;
  /** Representative (active/last-focused) tab id reported by the browser. */
  tabId?: number;
  tabUrl?: string;
  tabTitle?: string;
  connectedAt: number;
}

/**
 * Who currently holds the soft lease on a (browser, tab). Relay-enforced: only
 * the relay (which sees every controller) can grant/revoke it. Checked lazily
 * against `Date.now()` — an expired lease is treated as absent.
 */
export interface ClaimInfo {
  controllerId: string;
  controllerName: string;
  /** Epoch ms when the lease lapses (renewed on every drive). */
  leaseExpiry: number;
}

/** A live claim plus the tab it covers (WHOLE_TAB = whole-browser), for the roster. */
export interface TabClaim extends ClaimInfo {
  tabId: number;
}

/** A connected controller (an IDE's MCP server), for peer visibility. */
export interface PeerInfo {
  id: string;
  name: string;
  /** True in the per-controller view delivered to that same controller. */
  self?: boolean;
}

/** Public, serialisable view of a connected browser (used by the tools). */
export interface ClientInfo extends ClientMeta {
  id: string;
  active: boolean;
  /**
   * Every live claim on this browser, one entry per claimed tab (tabId ===
   * WHOLE_TAB means a whole-browser lease). Empty/absent when nobody drives it.
   */
  claims?: TabClaim[];
}

/** Selector accepted by `browser_select_client`. */
export interface ClientSelector {
  id?: string;
  browser?: string;
  label?: string;
}
