/**
 * The control-plane wire contract between an IDE's MCP server (a "controller")
 * and the relay. Mirrors the existing `{id, type, payload}` envelope used on the
 * browser side, but every type is namespaced `control.*` so it can never collide
 * with a browser tool message.
 *
 *   controller -> relay : control.hello (register+auth), control.send (forward a
 *                         tool call to the controller's selected browser),
 *                         control.ping, control.bye
 *   relay -> controller : hello (role:"relay"), control.welcome (initial snapshot
 *                         + ctrlId), control.browsers (live roster push),
 *                         control.response (a browser's reply), control.pong
 *
 * Browser selection/disambiguation is resolved CONTROLLER-SIDE against the cached
 * roster (see Context); the controller passes the chosen `browserId` in each
 * `control.send`, so the relay only routes — it never decides which browser.
 *
 * One relay -> BROWSER push rides the browser wire (NOT control.*-namespaced):
 *   relay -> browser : agents { claims: TabClaim[]; controllers: PeerInfo[] } —
 *                      each browser's own live claims PLUS the connected-agent
 *                      roster, pushed on every claim/roster change so its extension
 *                      popup can list every connected agent (even idle ones) and
 *                      annotate which tab each is driving (see `broadcastAgents` in
 *                      relay.ts). One-way; the browser never replies to it.
 */
import type { ClaimInfo, ClientInfo, PeerInfo } from "./types";
import type { AuthResponse } from "@/utils/auth";
import type { Frame } from "@/utils/frame";

/** Advertised in the relay's `hello` so peers/probes can tell it from a legacy direct host. */
export const RELAY_ROLE = "relay";
/** A new direct (non-relay) server advertises this so the extension can prefer the relay. */
export const DIRECT_ROLE = "direct";

/** Structured reason a tool/claim was refused (controller maps these to friendly text). */
export type ControlErrorCode =
  | "claimed"
  | "no_browser"
  | "browser_gone"
  /** The targeted tab no longer exists in the browser (closed mid-session). */
  | "tab_gone";

export interface ControlHelloFrame {
  id?: string;
  type: "control.hello";
  /**
   * `name` (env AUTOMATE_BROWSER_CLIENT_NAME) lets peers see which IDE drives what.
   * `instanceId` is stable across THIS controller's own restarts (see
   * `resolveInstanceId` in relay-link.ts): on hello the relay evicts any existing
   * controller carrying the same id, so an IDE that relaunches its MCP server
   * replaces its old roster entry instead of double-counting. Absent ⇒ no eviction.
   */
  payload: {
    role: "controller";
    auth?: AuthResponse;
    pid?: number;
    name?: string;
    instanceId?: string;
  };
}

export interface ControlWelcomeFrame {
  type: "control.welcome";
  payload: {
    ctrlId: string;
    /** The name the relay recorded for THIS controller (resolved fallback included). */
    name: string;
    relayVersion: string;
    /** The address the relay bound to — anything but loopback is reachable off-machine. */
    relayHost: string;
    browsers: ClientInfo[];
    controllers: PeerInfo[];
  };
}

export interface ControlBrowsersFrame {
  type: "control.browsers";
  payload: { browsers: ClientInfo[]; controllers: PeerInfo[] };
}

/**
 * Pushed to a controller whose claim was just force-stolen (roadmap B7).
 *
 * Unprompted, unlike everything else on this link: the whole point is that the
 * losing agent finds out WITHOUT having to act first. Before this it discovered
 * the loss only when its next drive of that browser was refused — mid-task,
 * after wasting an action.
 */
export interface ControlLeaseLostFrame {
  type: "control.leaseLost";
  payload: {
    browserId: string;
    /** The tab that was taken; absent for a whole-browser claim. */
    tabId?: number;
    takenBy: string;
    message: string;
  };
}

export interface ControlSendFrame {
  id?: string;
  type: "control.send";
  payload: {
    requestId: string;
    /** The browser the controller resolved to drive; omitted ⇒ relay uses the sole browser. */
    browserId?: string;
    /**
     * The specific tab to drive. Omitted ⇒ a WHOLE-browser claim, and the extension
     * falls back to its active tab. A current controller always sends one on a
     * claiming call (it owns a tab before it drives, so it can never wander onto the
     * user's focused tab); this is now reached only by an older controller build.
     * The relay both gates the claim on this and forwards it to the extension as
     * `__bmcpTabId` in the payload.
     */
    tabId?: number;
    /**
     * Skip the claim gate entirely (pure discovery/creation calls like
     * browser_list_tabs / browser_new_tab that must not lock out another IDE).
     */
    noClaim?: boolean;
    toolType: string;
    toolPayload: unknown;
    timeoutMs?: number;
  };
}

export interface ControlResponseFrame {
  type: "control.response";
  payload: {
    requestId: string;
    result?: unknown;
    /** Legacy human-readable error (kept for back-compat). */
    error?: string;
    /** Machine-readable reason so the controller can render targeted guidance. */
    errorCode?: ControlErrorCode;
    /** When errorCode==="claimed": the name of the controller currently driving. */
    claimedBy?: string;
    browserId?: string;
    /** When errorCode==="claimed"/"tab_gone": the tab involved (WHOLE_TAB ⇒ whole browser). */
    tabId?: number;
    leaseExpiry?: number;
    /** One-shot note prefixed to a successful result (e.g. "your control was taken over…"). */
    notice?: string;
  };
}

/** Controller → relay: explicitly claim a browser (optionally stealing it). */
export interface ControlClaimFrame {
  id?: string;
  type: "control.claim";
  /** `tabId` omitted ⇒ whole-browser claim/steal. */
  payload: { requestId: string; browserId: string; tabId?: number; force?: boolean };
}

/** Controller → relay: release this controller's claim (one browser/tab, or all). */
export interface ControlReleaseFrame {
  id?: string;
  type: "control.release";
  /** `browserId` omitted ⇒ release everything; `tabId` omitted ⇒ all of that browser's. */
  payload: { requestId: string; browserId?: string; tabId?: number };
}

/** Relay → controller: result of a control.claim / control.release. */
export interface ControlClaimResultFrame {
  type: "control.claimResult";
  payload: {
    requestId: string;
    ok: boolean;
    browserId?: string;
    /** Tab the claim/steal covered (WHOLE_TAB ⇒ whole browser). */
    tabId?: number;
    claim?: ClaimInfo;
    errorCode?: ControlErrorCode;
    claimedBy?: string;
    leaseExpiry?: number;
  };
}

export function isControlHello(msg: Frame): msg is ControlHelloFrame & Frame {
  return msg.type === "control.hello" && !!msg.payload && msg.payload.role === "controller";
}

export function isControlSend(msg: Frame): msg is ControlSendFrame & Frame {
  return (
    msg.type === "control.send" &&
    !!msg.payload &&
    typeof msg.payload.requestId === "string" &&
    typeof msg.payload.toolType === "string"
  );
}

export function isControlClaim(msg: Frame): msg is ControlClaimFrame & Frame {
  return (
    msg.type === "control.claim" &&
    !!msg.payload &&
    typeof msg.payload.requestId === "string" &&
    typeof msg.payload.browserId === "string"
  );
}

export function isControlRelease(msg: Frame): msg is ControlReleaseFrame & Frame {
  return (
    msg.type === "control.release" &&
    !!msg.payload &&
    typeof msg.payload.requestId === "string" &&
    (msg.payload.browserId === undefined || typeof msg.payload.browserId === "string")
  );
}
