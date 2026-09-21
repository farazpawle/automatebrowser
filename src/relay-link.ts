/**
 * The controller end of the relay link, owned by the Context. It connects to the
 * relay (spawning it if needed via ensureRelay), registers as a controller (with
 * a human name), caches the browser roster + peer list the relay pushes, forwards
 * tool calls, and routes each `control.response` back to the awaiting caller by
 * `requestId`.
 *
 * Resilience: if the relay link drops (relay crash, etc.) it auto-reconnects with
 * bounded backoff — re-running ensureRelay, which re-spawns the relay if no other
 * controller kept it alive, and re-sends `control.hello`. In-flight requests
 * reject with a retryable error so the agent can retry.
 */
import { createHash, randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import { debugLog } from "@/utils/log";
import { signAuthChallenge } from "@/utils/auth";
import { parseFrame } from "@/utils/frame";

import { ensureRelay } from "./relay-ensure";
import type {
  ControlBrowsersFrame,
  ControlClaimResultFrame,
  ControlErrorCode,
  ControlResponseFrame,
  ControlWelcomeFrame,
} from "./relay/control";
import type { ClaimInfo, ClientInfo, PeerInfo } from "./relay/types";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface ClaimPending {
  resolve: (v: ClaimResult) => void;
  timer: NodeJS.Timeout;
}

/** Outcome of a control.claim / control.release round-trip. */
export interface ClaimResult {
  ok: boolean;
  browserId?: string;
  tabId?: number;
  claim?: ClaimInfo;
  errorCode?: ControlErrorCode;
  claimedBy?: string;
  leaseExpiry?: number;
}

/** Error thrown by `send()` carrying the relay's structured refusal reason. */
export class RelaySendError extends Error {
  code?: ControlErrorCode;
  claimedBy?: string;
  browserId?: string;
  tabId?: number;
  leaseExpiry?: number;
  constructor(message: string, fields?: Partial<RelaySendError>) {
    super(message);
    this.name = "RelaySendError";
    if (fields) Object.assign(this, fields);
  }
}

/** Controller→relay app-level heartbeat cadence. */
const CONTROL_PING_MS = 15_000;
/** Extra slack on top of a tool's own timeout before the link gives up locally. */
const RESPONSE_SLACK_MS = 2_000;
/** Reconnect backoff bounds. */
const BASE_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 8_000;
/** Ceiling on a reported failure reason, so one long message cannot flood a status reply. */
const MAX_REASON_CHARS = 200;
/** Budget for a claim/release round-trip. */
const CLAIM_TIMEOUT_MS = 5_000;
/**
 * How long a fresh connect waits for `control.welcome` before reporting ready.
 * The welcome carries this controller's id, the relay version and the current
 * roster, so resolving `start()` on the socket alone leaves a one-shot caller
 * (the CLI) rendering an empty, id-less status. Bounded and non-fatal.
 */
const WELCOME_TIMEOUT_MS = 2_000;

/**
 * A stable id for THIS controller across its own restarts, sent in `control.hello`
 * so the relay can evict our previous roster entry instead of double-counting a
 * reconnect or an IDE-driven relaunch (roadmap P0-C).
 *
 * Derived rather than stored on disk: the IDE that spawns us keeps its pid and
 * working directory across an MCP-server relaunch, so the hash is unchanged,
 * while two genuinely separate IDEs differ in at least one input. A file would
 * need the same triple as its key anyway, plus a cleanup story.
 *
 * The name is included ONLY when explicitly configured — `resolveClientName`'s
 * `mcp-<pid>` fallback changes on every relaunch and would defeat the whole
 * point, while an explicit name is what lets several controllers share one
 * parent and cwd (the smoke harness, and a user running two servers by hand)
 * without evicting each other. `AUTOMATE_BROWSER_INSTANCE_ID` overrides it.
 */
function resolveInstanceId(): string {
  const explicit = process.env.AUTOMATE_BROWSER_INSTANCE_ID?.trim();
  if (explicit) return explicit;
  const name = process.env.AUTOMATE_BROWSER_CLIENT_NAME?.trim() ?? "";
  return createHash("sha256")
    .update(JSON.stringify([name, process.ppid, process.cwd()]))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Where the link to the relay currently stands (I01).
 *
 * `connected` and `waiting` are deliberately separate: being on the relay says
 * nothing about there being a browser to drive, and reporting both as
 * "connected" is what turns "it says it is connected" into a dead end.
 */
export interface RecoveryState {
  state: "connected" | "waiting" | "connecting" | "retrying" | "stopped";
  /** Consecutive failed connection attempts since the last completed handshake. */
  attempts: number;
  /** Only while `retrying`: how long until the next attempt. */
  nextRetryInMs?: number;
  /** The most recent failure, bounded and with the token removed. One, not a log. */
  lastError?: string;
}

export class RelayLink {
  private ws: WebSocket | null = null;
  private _browsers: ClientInfo[] = [];
  private _controllers: PeerInfo[] = [];
  private readonly _pending = new Map<string, Pending>();
  private readonly _claimPending = new Map<string, ClaimPending>();
  private _stopped = false;
  private _starting: Promise<void> | null = null;
  private _pingTimer: NodeJS.Timeout | undefined;
  private _reconnectMs = BASE_RECONNECT_MS;
  /**
   * The ONE pending reconnect. B06 — retry scheduling used to live inside
   * `_onClose` alone, which meant a failed attempt scheduled nothing after
   * itself and automatic recovery ended after exactly one try; a startup that
   * could not reach the relay scheduled nothing at all. Every path that wants
   * another attempt now goes through `_scheduleRetry`, and holding the handle
   * here is what makes "at most one timer" enforceable and shutdown able to
   * cancel it.
   */
  private _retryTimer: NodeJS.Timeout | undefined;
  /**
   * Recovery bookkeeping (I01). Three small fields, because the question
   * "is it coming back?" cannot be answered from `ws.readyState` alone: a link
   * that is retrying and a link that has given up look identical there.
   *
   * Bounded on purpose — a count, one deadline and ONE reason. No history
   * buffer: a list of every failure since start would grow without limit in
   * exactly the situation where nobody is reading it.
   */
  private _attempts = 0;
  private _retryAt: number | undefined;
  private _lastError: string | undefined;
  /** Resolver for the in-flight `control.welcome` wait, if a connect is handshaking. */
  private _onWelcome: (() => void) | null = null;
  // Captured from control.welcome (for browser_status / owner rendering).
  private _ctrlId: string | undefined;
  private _name: string | undefined;
  private _relayVersion: string | undefined;
  private _relayHost: string | undefined;
  private _relayPort: number | undefined;
  private _legacyPorts: number[] = [];

  constructor(
    private readonly opts: { version: string; token?: string; name: string },
    private readonly onBrowsers: (list: ClientInfo[]) => void,
    /**
     * Called when the relay attaches a one-shot note to a response, or pushes
     * one unprompted. `code` is the taxonomy code the note belongs to, so the
     * agent reads a machine-readable head rather than having to match prose.
     */
    private readonly onNotice?: (text: string, code?: "LEASE_LOST") => void,
  ) {}

  /** Connect (idempotent): a single in-flight connect is shared by callers. */
  async start(): Promise<void> {
    if (this._stopped) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this._starting) return this._starting;
    this._starting = this._connect()
      .catch((e: unknown) => {
        // B06 — the caller still gets the failure (a tool call must not pretend
        // it reached a browser), but the link keeps trying on its own. Without
        // this, a server that started while the relay was briefly unavailable
        // stayed disconnected until something else happened to call `start()`.
        this._attempts++;
        this._lastError = this._safeReason(e);
        this._scheduleRetry();
        throw e;
      })
      .finally(() => {
        this._starting = null;
      });
    return this._starting;
  }

  /**
   * Queue the next connection attempt, backing off, unless one is already queued
   * or this controller has been deliberately stopped.
   *
   * Every failure path funnels here — a dropped link, a failed reconnect, a
   * failed startup — so there is one place that decides whether another attempt
   * happens and exactly one timer that can exist. Two schedulers would each
   * think they were the only one, and a link that dropped while a retry was
   * already pending would end up with two chains of attempts racing each other.
   */
  private _scheduleRetry(): void {
    if (this._stopped || this._retryTimer) return;
    const delay = this._reconnectMs;
    this._reconnectMs = Math.min(this._reconnectMs * 2, MAX_RECONNECT_MS);
    this._retryAt = Date.now() + delay;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = undefined;
      this._retryAt = undefined;
      if (this._stopped) return;
      // `start()` schedules the next attempt itself when this one fails, so the
      // chain continues rather than ending on the first failure — which is the
      // whole bug. It is `void`ed deliberately: nobody is awaiting a background
      // reconnect, and the rejection is already logged by `start()`'s own path.
      void this.start().catch((e) => {
        debugLog("[relay-link] reconnect failed:", String(e));
      });
    }, delay);
    // Unref'd, like the ping and the welcome wait. The chain is now unbounded in
    // LENGTH — that is the fix — so a ref'd timer would keep a process alive for
    // as long as the relay stayed down, which for a one-shot CLI invocation
    // means forever. The MCP server is held open by its stdio transport, so its
    // retries still fire.
    this._retryTimer.unref?.();
  }

  /**
   * A failure reason fit to print back to an agent: the message, bounded, with
   * this controller's token removed.
   *
   * The message only — never the stack, which carries absolute paths from this
   * machine. The token is spliced out by value rather than by pattern: a
   * connect error can quote the url it dialled, and if that url ever carries the
   * token then matching on "something that looks like a secret" would be a
   * guess, while matching the actual secret cannot miss it.
   */
  private _safeReason(e: unknown): string {
    let msg = e instanceof Error ? e.message : String(e);
    const token = this.opts.token;
    if (token) msg = msg.split(token).join("***");
    return msg.length > MAX_REASON_CHARS ? `${msg.slice(0, MAX_REASON_CHARS)}…` : msg;
  }

  /**
   * Whether this link is connected, coming back, or finished — the question
   * `ws.readyState` cannot answer, because a link that is retrying and one that
   * has given up are both simply "not open" (I01).
   *
   * `stopped` is checked FIRST and can never report a retry: `close()` clears
   * the timer, but a state derived in the other order would still describe a
   * shutting-down server as recovering.
   */
  recovery(): RecoveryState {
    const retryInMs =
      this._retryAt === undefined ? undefined : Math.max(0, this._retryAt - Date.now());
    if (this._stopped) return { state: "stopped", attempts: this._attempts };
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Connected to the RELAY is not the same as having something to drive, and
      // conflating them is what makes "it says connected but nothing works".
      return this._browsers.length > 0
        ? { state: "connected", attempts: 0 }
        : { state: "waiting", attempts: 0 };
    }
    if (this._retryTimer) {
      return {
        state: "retrying",
        attempts: this._attempts,
        nextRetryInMs: retryInMs,
        lastError: this._lastError,
      };
    }
    return { state: "connecting", attempts: this._attempts, lastError: this._lastError };
  }

  /** Fail every in-flight request, so a dropped link never leaves one hanging. */
  private _settlePending(reason: string): void {
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this._pending.clear();
    for (const cp of this._claimPending.values()) {
      clearTimeout(cp.timer);
      cp.resolve({ ok: false, errorCode: "no_browser" });
    }
    this._claimPending.clear();
  }

  listBrowsers(): ClientInfo[] {
    return this._browsers;
  }

  peers(): PeerInfo[] {
    return this._controllers;
  }

  ctrlId(): string | undefined {
    return this._ctrlId;
  }

  name(): string | undefined {
    return this._name;
  }

  relayPort(): number | undefined {
    return this._relayPort;
  }

  relayVersion(): string | undefined {
    return this._relayVersion;
  }

  /** The address the relay is BOUND to — not the one we dialled (C13). */
  relayHost(): string | undefined {
    return this._relayHost;
  }

  legacyPorts(): number[] {
    return this._legacyPorts;
  }

  // Returns `any` (not `unknown`) to match the previous direct-sender contract,
  // so tools can use the result without re-casting (e.g. console-log arrays).
  async send(
    browserId: string | undefined,
    toolType: string,
    toolPayload: unknown,
    timeoutMs: number,
    /** The specific tab to drive/claim; omitted ⇒ whole-browser lease. */
    tabId?: number,
    /** Skip the relay claim gate (discovery/creation calls). */
    noClaim?: boolean,
  ): Promise<unknown> {
    await this._ensureConnected();
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(requestId);
        reject(new Error("Socket message timeout"));
      }, timeoutMs + RESPONSE_SLACK_MS);
      this._pending.set(requestId, { resolve, reject, timer });
      try {
        this.ws!.send(
          JSON.stringify({
            id: requestId,
            type: "control.send",
            payload: { requestId, browserId, tabId, noClaim, toolType, toolPayload, timeoutMs },
          }),
        );
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(requestId);
        reject(e as Error);
      }
    });
  }

  /** Explicitly claim a browser/tab (force ⇒ steal from another controller). */
  async claim(browserId: string, force = false, tabId?: number): Promise<ClaimResult> {
    return this._claimCall({ type: "control.claim", extra: { browserId, tabId, force } });
  }

  /** Release this controller's claim on a browser/tab (or all, if omitted). */
  async release(browserId?: string, tabId?: number): Promise<ClaimResult> {
    return this._claimCall({ type: "control.release", extra: { browserId, tabId } });
  }

  private async _claimCall(args: {
    type: "control.claim" | "control.release";
    extra: Record<string, unknown>;
  }): Promise<ClaimResult> {
    await this._ensureConnected();
    const requestId = randomUUID();
    return new Promise<ClaimResult>((resolve) => {
      const timer = setTimeout(() => {
        this._claimPending.delete(requestId);
        resolve({ ok: false, errorCode: "no_browser" });
      }, CLAIM_TIMEOUT_MS);
      this._claimPending.set(requestId, { resolve, timer });
      try {
        this.ws!.send(
          JSON.stringify({
            id: requestId,
            type: args.type,
            payload: { requestId, ...args.extra },
          }),
        );
      } catch {
        clearTimeout(timer);
        this._claimPending.delete(requestId);
        resolve({ ok: false, errorCode: "no_browser" });
      }
    });
  }

  async close(): Promise<void> {
    this._stopped = true;
    this._stopPing();
    // A deliberately stopped controller must not come back. The `_stopped` guard
    // inside the callback already refuses to reconnect, but leaving the timer
    // armed keeps the event loop alive for up to the full backoff after the
    // server has finished shutting down.
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = undefined;
    }
    // Settled here as well as on the socket's close event: a socket still
    // CONNECTING when we shut down may never emit one, and a caller awaiting a
    // response to a link that is gone would wait out its whole timeout.
    this._settlePending("relay connection closed");
    // Release a connect that is still waiting on control.welcome, rather than
    // leaving it to time out after the link is already gone.
    this._onWelcome?.();
    try {
      this.ws?.send(JSON.stringify({ type: "control.bye" }));
    } catch {
      /* ignore */
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private async _ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    await this.start();
  }

  private async _connect(): Promise<void> {
    const { ws, port, legacyPorts, authChallenge } = await ensureRelay({
      version: this.opts.version,
    });
    this._relayPort = port;
    this._legacyPorts = legacyPorts;
    if (this._stopped) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }
    this.ws = ws;
    ws.on("message", (raw) => this._onMessage(raw));
    // The socket is passed back so a SUPERSEDED one closing late cannot null out
    // the live link or restart the backoff chain behind it.
    ws.once("close", () => this._onClose(ws));
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
    const auth =
      this.opts.token && authChallenge
        ? signAuthChallenge(this.opts.token, authChallenge.challenge)
        : undefined;
    ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "control.hello",
        payload: {
          role: "controller",
          auth,
          pid: process.pid,
          name: this.opts.name,
          instanceId: resolveInstanceId(),
        },
      }),
    );
    this._startPing();

    // Report ready only once the relay has welcomed us. `control.hello` is
    // fire-and-forget, so without this `start()` resolves on the raw socket and
    // an immediate reader sees no ctrlId, no relay version and an empty roster —
    // exactly what `automate-browser status` printed before this wait existed.
    // A relay that never welcomes still yields a usable link after the timeout.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this._onWelcome = null;
        debugLog(`[relay-link] no control.welcome within ${WELCOME_TIMEOUT_MS}ms; continuing`);
        resolve();
      }, WELCOME_TIMEOUT_MS);
      timer.unref?.();
      this._onWelcome = () => {
        clearTimeout(timer);
        this._onWelcome = null;
        resolve();
      };
    });
  }

  private _onMessage(raw: unknown): void {
    const msg = parseFrame(raw);
    if (!msg) return;
    if (msg.type === "control.pong") return;

    if (msg.type === "control.welcome") {
      // B06 — backoff resets HERE, on a handshake the relay actually completed,
      // and not when the socket merely opened. A relay that accepts the
      // connection and then drops it (a rejected token, a version it refuses)
      // used to reset the delay on every attempt, turning bounded backoff into
      // an unbounded loop at the 500 ms floor.
      this._reconnectMs = BASE_RECONNECT_MS;
      // I01 — and for the same reason: the recovery story ends on a handshake
      // the relay completed, not on a socket that merely opened. Clearing these
      // when the socket opened would report "connected, 0 failures" about a link
      // the relay is about to reject.
      this._attempts = 0;
      this._lastError = undefined;
      const p = (msg.payload ?? {}) as Partial<ControlWelcomeFrame["payload"]>;
      this._ctrlId = p.ctrlId;
      this._name = p.name;
      this._relayVersion = p.relayVersion;
      this._relayHost = p.relayHost;
      this._controllers = Array.isArray(p.controllers) ? p.controllers : [];
      this._browsers = Array.isArray(p.browsers) ? p.browsers : [];
      this.onBrowsers(this._browsers);
      this._onWelcome?.();
      return;
    }
    // B7: unprompted — the relay tells us our claim was force-stolen. Routed
    // through the same one-shot notice slot as the queued note, so there is one
    // place that surfaces a takeover and it cannot be reported twice.
    if (msg.type === "control.leaseLost") {
      const text = msg.payload?.message;
      if (typeof text === "string" && text) this.onNotice?.(text, "LEASE_LOST");
      return;
    }
    if (msg.type === "control.browsers") {
      const p = (msg.payload ?? {}) as Partial<ControlBrowsersFrame["payload"]>;
      if (Array.isArray(p.controllers)) {
        this._controllers = p.controllers;
        // Our own display name can change after the welcome: the relay suffixes
        // duplicates (P0-E), so a second IDE with the same name renames us both.
        // Without this refresh `browser_status` would print a "you:" that no
        // other seat in the mesh agrees with.
        const self = this._controllers.find((c) => c.self);
        if (self?.name) this._name = self.name;
      }
      this._browsers = Array.isArray(p.browsers) ? p.browsers : [];
      this.onBrowsers(this._browsers);
      return;
    }

    if (msg.type === "control.response") {
      const {
        requestId,
        result,
        error,
        errorCode,
        claimedBy,
        browserId,
        tabId,
        leaseExpiry,
        notice,
      } = (msg.payload ?? {}) as Partial<ControlResponseFrame["payload"]>;
      if (notice) {
        try {
          // Same event as the push above — the QUEUED fallback for a controller
          // whose socket could not be written to — so it carries the same code.
          this.onNotice?.(notice, "LEASE_LOST");
        } catch {
          /* ignore */
        }
      }
      if (typeof requestId !== "string") return; // no correlation id ⇒ nothing to resolve
      const p = this._pending.get(requestId);
      if (!p) return;
      this._pending.delete(requestId);
      clearTimeout(p.timer);
      if (error) {
        p.reject(
          errorCode
            ? new RelaySendError(error, {
                code: errorCode,
                claimedBy,
                browserId,
                tabId,
                leaseExpiry,
              })
            : new Error(error),
        );
      } else {
        p.resolve(result);
      }
      return;
    }

    if (msg.type === "control.claimResult") {
      const { requestId, ...rest } = (msg.payload ?? {}) as Partial<
        ControlClaimResultFrame["payload"]
      >;
      if (typeof requestId !== "string") return; // no correlation id ⇒ nothing to resolve
      const cp = this._claimPending.get(requestId);
      if (!cp) return;
      this._claimPending.delete(requestId);
      clearTimeout(cp.timer);
      cp.resolve(rest as ClaimResult);
      return;
    }
  }

  private _onClose(ws: WebSocket): void {
    // A socket we have already replaced, reporting its own close after the fact.
    // Acting on it would null a live link, wipe a roster that is current, and
    // start a second chain of reconnects behind the one that succeeded.
    if (this.ws && this.ws !== ws) return;
    this.ws = null;
    this._settlePending("relay connection closed");
    this._browsers = [];
    this._controllers = [];
    this.onBrowsers(this._browsers);
    this._stopPing();
    this._scheduleRetry();
  }

  private _startPing(): void {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ type: "control.ping" }));
      } catch {
        /* ignore */
      }
    }, CONTROL_PING_MS);
    this._pingTimer.unref?.();
  }

  private _stopPing(): void {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = undefined;
    }
  }
}
