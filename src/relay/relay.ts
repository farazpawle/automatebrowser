/**
 * The relay's WebSocket host. It is the SINGLE host every browser extension and
 * every IDE's MCP server connect to, replacing the old one-server-per-IDE model
 * that partitioned browsers across processes.
 *
 * One port, two peer kinds, decided by the first application frame:
 *   - a peer that sends `identify`      → a BROWSER (existing wire, unchanged)
 *   - a peer that sends `control.hello` → a CONTROLLER (an IDE's MCP server)
 *
 * The relay speaks the browser wire byte-for-byte (hello → identify, relays
 * tool frames ↔ messageResponse, answers app `ping` with `pong`), so a browser
 * cannot tell the relay from a direct server. Controllers get the live roster
 * pushed and forward tool calls via `control.send`; the relay routes each reply
 * back to the originating controller (the controller socket is captured in the
 * send handler's closure — no global request map needed).
 */
import { randomUUID } from "node:crypto";
import type { WebSocket, WebSocketServer } from "ws";

import { createAuthChallenge, getAuthToken, verifyAuthResponse } from "@/utils/auth";
import { parseFrame } from "@/utils/frame";

import { BrowserRegistry } from "./browsers";
import type { ControlClaimFrame, ControlReleaseFrame, ControlSendFrame } from "./control";
import {
  isControlClaim,
  isControlHello,
  isControlRelease,
  isControlSend,
  RELAY_ROLE,
} from "./control";
import { rlog } from "./log-file";
import { WHOLE_TAB } from "./types";
import type { ClaimInfo, ClientMeta, PeerInfo } from "./types";

/** A peer must declare its role (identify / control.hello) within this window. */
const ROLE_TIMEOUT_MS = 3_000;
/** WS protocol-level ping cadence to detect dead TCP peers. */
const HEARTBEAT_INTERVAL_MS = 20_000;
/**
 * Exit this long after the last browser AND controller leaves. Kept generous so
 * a momentarily-idle relay does not exit underneath a controller that is about
 * to reconnect (a live controller keeps peerCount > 0, so this only governs the
 * brief all-peers-gone window). Override with AUTOMATE_BROWSER_RELAY_IDLE_MS.
 */
const IDLE_EXIT_MS = numEnv("AUTOMATE_BROWSER_RELAY_IDLE_MS", 300_000);
/**
 * How long a drive claim stays valid without further activity. Renewed on every
 * control.send. Override with AUTOMATE_BROWSER_LEASE_TTL_MS (the smoke test uses a
 * short value to exercise expiry deterministically).
 */
const LEASE_TTL_MS = numEnv("AUTOMATE_BROWSER_LEASE_TTL_MS", 60_000);
/** Per-socket app-frame rate limit; high enough for automation bursts. */
const RATE_WINDOW_MS = numEnv("AUTOMATE_BROWSER_WS_RATE_WINDOW_MS", 1_000);
const RATE_MAX_MESSAGES = numEnv("AUTOMATE_BROWSER_WS_RATE_MAX", 120);
/**
 * Drop a controller that has sent nothing for this long. Backstop for a peer
 * that wedges without its TCP connection closing — the WS-level ping/pong above
 * catches a dead socket, this catches a live socket behind a dead process.
 * Controllers ping every 15 s, so the default tolerates three missed beats.
 * Override with AUTOMATE_BROWSER_CONTROLLER_STALE_MS (the smoke test uses a
 * short value to exercise the reaper deterministically).
 */
const CONTROLLER_STALE_MS = numEnv("AUTOMATE_BROWSER_CONTROLLER_STALE_MS", 45_000);
/** How often the reaper scans for stale controllers. */
const REAP_INTERVAL_MS = Math.max(1_000, Math.floor(CONTROLLER_STALE_MS / 3));

function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface ControllerConn {
  id: string;
  ws: WebSocket;
  /** Name as reported in `control.hello`; see `nameOf` for the displayed form. */
  name: string;
  /** Reported pid, used to tell two same-named controllers apart (P0-E). */
  pid?: number;
  /** Stable across this controller's own restarts; drives hello eviction (P0-C). */
  instanceId?: string;
  /** Epoch ms of the last frame from this controller; drives the reaper (P0-D). */
  lastSeenAt: number;
  /** browserId → one-shot note, delivered on this controller's NEXT drive of it. */
  takeoverNotices: Map<string, string>;
}

function safeClose(ws: WebSocket, code = 1008, reason = "policy violation"): void {
  try {
    ws.close(code, reason);
  } catch {
    /* ignore */
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Does a drive error indicate the targeted tab no longer exists? */
function isTabGone(msg: string): boolean {
  return /no tab with id|no drivable tab|tab .*not found|invalid tab id|cannot access a chrome/i.test(
    msg,
  );
}

function isIdentifyFrame(
  msg: unknown,
): msg is { type: "identify"; payload: Record<string, unknown> } {
  return isPlainObject(msg) && msg.type === "identify" && isPlainObject(msg.payload);
}

/**
 * A frame field is a string only if it says so. An identify that arrives with a
 * number where a label belongs must read as absent, never as "3" — the roster is
 * what every peer and popup displays.
 */
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function validEnvelope(msg: unknown): msg is Record<string, unknown> {
  return (
    isPlainObject(msg) &&
    typeof msg.type === "string" &&
    (msg.id === undefined || typeof msg.id === "string") &&
    (msg.payload === undefined || isPlainObject(msg.payload))
  );
}

export interface RelayHandle {
  port: number;
  close: () => void;
}

export function startRelay(
  wss: WebSocketServer,
  port: number,
  version: string,
  /**
   * The address actually bound (C13). Defaults to loopback so every existing
   * caller keeps its behaviour; a non-loopback value is reported to controllers
   * in `control.welcome` so `browser_status` can WARN that this relay is
   * reachable from beyond this machine.
   */
  host = "127.0.0.1",
): RelayHandle {
  const browsers = new BrowserRegistry();
  const controllers = new Map<string, ControllerConn>();
  const token = getAuthToken();
  let idleTimer: NodeJS.Timeout | undefined;

  const peerCount = () => browsers.size() + controllers.size;

  function armIdleExit(): void {
    if (idleTimer || peerCount() > 0) return;
    idleTimer = setTimeout(() => {
      if (peerCount() === 0) {
        rlog.info("idle with no peers; exiting");
        try {
          wss.close();
        } catch {
          /* ignore */
        }
        process.exit(0);
      }
    }, IDLE_EXIT_MS);
    idleTimer.unref?.();
  }

  function cancelIdleExit(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  /**
   * The name shown for a controller anywhere a human reads it — peer lists, the
   * browser popup, "being driven by …" refusals. Two IDEs that both set
   * AUTOMATE_BROWSER_CLIENT_NAME to the same string are otherwise indistinguishable
   * in the roster, so a duplicate gets its pid (or a short id) appended (P0-E).
   *
   * Computed on read rather than stamped at hello, so the suffix appears the
   * moment a twin connects and disappears again when it leaves.
   */
  function displayName(c: ControllerConn): string {
    for (const other of controllers.values()) {
      if (other.id !== c.id && other.name === c.name) {
        return c.pid ? `${c.name} (pid ${c.pid})` : `${c.name} (${c.id.slice(0, 8)})`;
      }
    }
    return c.name;
  }

  /** `displayName` by controller id, with the fallback every caller used inline. */
  function nameOf(id: string | undefined): string {
    const c = id ? controllers.get(id) : undefined;
    return c ? displayName(c) : "an agent";
  }

  /**
   * Remove a controller from the roster and free its claims, THEN close its
   * socket. Synchronous removal matters: the socket's own `close` handler runs a
   * turn or more later, and until it does the departing controller would still
   * appear in the very roster we are about to broadcast. Both are idempotent, so
   * the later `onClose` is a harmless no-op.
   */
  function dropController(id: string, reason: string): void {
    const c = controllers.get(id);
    if (!c) return;
    const freed = browsers.releaseByController(id);
    controllers.delete(id);
    rlog.info(
      `controller dropped id=${id.slice(0, 8)} name="${c.name}" reason=${reason} ` +
        `freed=${freed.length} (controllers=${controllers.size})`,
    );
    safeClose(c.ws, 1000, reason);
  }

  function peerList(): PeerInfo[] {
    return [...controllers.values()].map((c) => ({ id: c.id, name: displayName(c) }));
  }

  /** Push the roster + peer list to every controller (each sees its own `self`). */
  function broadcastBrowsers(): void {
    if (controllers.size === 0) return;
    const browsersInfo = browsers.info();
    const peers = peerList();
    for (const c of controllers.values()) {
      try {
        c.ws.send(
          JSON.stringify({
            type: "control.browsers",
            payload: {
              browsers: browsersInfo,
              controllers: peers.map((p) => ({ ...p, self: p.id === c.id })),
            },
          }),
        );
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Push each browser ITS OWN live claims PLUS the connected-agent roster, so its
   * popup can list every connected agent (persistent) and annotate which tab each
   * is driving. One `agents` frame per browser. Mirrors `broadcastBrowsers` but
   * aimed at the browser wire instead of the controller wire — the browser side
   * resolves tab ids to titles locally, so the payload stays minimal.
   *
   * `controllers` is the same `peerList()` roster sent to controllers; without it
   * an idle-but-connected agent would vanish from the popup the moment its ~60s
   * lease lapsed (only live claims were sent before).
   */
  function broadcastAgents(): void {
    if (browsers.size() === 0) return;
    const peers = peerList(); // connected agents (id + name); same for every browser
    for (const b of browsers.list()) {
      const claims = browsers.liveClaimsFor(b.id); // TabClaim[]; lapsed ones dropped
      try {
        b.ws.send(JSON.stringify({ type: "agents", payload: { claims, controllers: peers } }));
      } catch {
        /* ignore */
      }
    }
  }

  /** Notify both wires after a roster/claim change (controllers + browsers' popups). */
  function broadcastRoster(): void {
    broadcastBrowsers();
    broadcastAgents();
  }

  /**
   * Stale-controller reaper (P0-D). A controller whose process has wedged can hold
   * its TCP connection open indefinitely — and with it every tab claim it owns,
   * locking other agents out of a browser nobody is actually driving. Anything the
   * controller sends counts as liveness, so a busy agent is never reaped mid-task.
   */
  const reaper = setInterval(() => {
    if (controllers.size === 0) return;
    const cutoff = Date.now() - CONTROLLER_STALE_MS;
    const stale = [...controllers.values()].filter((c) => c.lastSeenAt < cutoff);
    if (stale.length === 0) return;
    for (const c of stale) dropController(c.id, "stale");
    broadcastRoster();
    armIdleExit();
  }, REAP_INTERVAL_MS);
  reaper.unref?.();

  wss.on("connection", (ws: WebSocket) => {
    cancelIdleExit();
    const authChallenge = token ? createAuthChallenge() : undefined;

    // Announce ourselves (role:"relay") so the peer/probe can verify + prefer us.
    try {
      ws.send(
        JSON.stringify({
          id: randomUUID(),
          type: "hello",
          payload: {
            server: "automate-browser",
            version,
            port,
            role: RELAY_ROLE,
            ...(authChallenge ? { auth: authChallenge } : {}),
          },
        }),
      );
    } catch {
      /* ignore */
    }

    let role: "browser" | "controller" | undefined;
    let browserId: string | undefined;
    let controllerId: string | undefined;
    let rateWindowStartedAt = Date.now();
    let rateCount = 0;

    const roleTimer = setTimeout(() => {
      if (!role) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    }, ROLE_TIMEOUT_MS);
    roleTimer.unref?.();

    // WS-level heartbeat (independent of the app-level browser ping/pong).
    let alive = true;
    const onPong = () => {
      alive = true;
    };
    ws.on("pong", onPong);
    const hb = setInterval(() => {
      if (!alive) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        clearInterval(hb);
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        clearInterval(hb);
      }
    }, HEARTBEAT_INTERVAL_MS);
    hb.unref?.();

    async function handleControlSend(frame: ControlSendFrame): Promise<void> {
      const {
        requestId,
        browserId: targetId,
        tabId,
        noClaim,
        toolType,
        toolPayload,
        timeoutMs,
      } = frame.payload;
      const reply = (result?: unknown, error?: string, extra?: Record<string, unknown>) => {
        try {
          ws.send(
            JSON.stringify({
              type: "control.response",
              payload: { requestId, result, error, ...(extra ?? {}) },
            }),
          );
        } catch {
          /* ignore */
        }
      };
      const target = targetId
        ? browsers.get(targetId)
        : browsers.size() === 1
          ? browsers.list()[0]
          : undefined;
      if (!target) {
        // Mapped to the friendly noConnection message controller-side.
        reply(undefined, "No connected tab found", { errorCode: "no_browser" });
        return;
      }

      const me = controllerId!;
      const ctrl = controllers.get(me);
      const myName = nameOf(me);
      // A one-shot note queued for me on this browser (e.g. it was stolen).
      const takeNotice = (): string | undefined => {
        const n = ctrl?.takeoverNotices.get(target.id);
        if (n) ctrl!.takeoverNotices.delete(target.id);
        return n;
      };

      // Inject the resolved tab so the extension drives the right tab per-call
      // (never a shared global). Only for a concrete tabId. A claiming send from a
      // current controller always carries one — it owns a tab before it drives —
      // so the extension's own active-tab fallback is now reached only by a
      // noClaim discovery call or an older controller build.
      const forwardPayload =
        tabId != null && isPlainObject(toolPayload)
          ? { ...(toolPayload as Record<string, unknown>), __bmcpTabId: tabId }
          : toolPayload;

      const forward = async (notice?: string): Promise<void> => {
        try {
          const result = await target.sender(toolType, forwardPayload, {
            timeoutMs,
          });
          reply(result, undefined, notice ? { notice } : undefined);
        } catch (e) {
          const msg = (e as Error)?.message || String(e);
          if (tabId != null && isTabGone(msg)) {
            browsers.clearClaim(target.id, tabId);
            broadcastRoster();
            reply(undefined, msg, {
              errorCode: "tab_gone",
              browserId: target.id,
              tabId,
            });
            return;
          }
          reply(undefined, msg);
        }
      };

      // Pure discovery/creation calls (browser_list_tabs / browser_new_tab) skip
      // the gate so they never grab a lease that would lock out another IDE.
      if (noClaim) {
        await forward();
        return;
      }

      // ── Soft-claim gate, now per (browser, tab). The relay is the only peer
      // that sees every controller, so it enforces leases here. Resolution and
      // the claim mutation are synchronous (before the first await), so two near-
      // simultaneous sends to the SAME tab race deterministically: the first wins,
      // the second sees the live claim — no lock needed on a single event loop. ──
      const tabKey = tabId ?? WHOLE_TAB;
      const live = browsers.liveClaimsFor(target.id);
      const conflict =
        tabKey === WHOLE_TAB
          ? // A whole-browser drive conflicts with ANY claim by another controller.
            live.find((c) => c.controllerId !== me)
          : // A tab drive conflicts only with a WHOLE held by another, or the SAME tab.
            live.find(
              (c) => c.controllerId !== me && (c.tabId === WHOLE_TAB || c.tabId === tabKey),
            );
      if (conflict) {
        reply(undefined, "claimed", {
          errorCode: "claimed",
          claimedBy: conflict.controllerName,
          browserId: target.id,
          tabId: conflict.tabId,
          leaseExpiry: conflict.leaseExpiry,
          notice: takeNotice(),
        });
        return;
      }
      const wasUnclaimed = !browsers.liveClaim(target.id, tabKey);
      browsers.setClaim(target.id, tabKey, {
        controllerId: me,
        controllerName: myName,
        leaseExpiry: Date.now() + LEASE_TTL_MS,
      });
      if (wasUnclaimed) broadcastRoster(); // new owner now visible to peers + popups
      await forward(takeNotice());
    }

    /**
     * Grant/steal a claim (control.claim). `tabId` omitted ⇒ whole-browser
     * claim (which, by the precedence rule, displaces every per-tab claim too).
     * force ⇒ displace the holder(s) and notify them.
     */
    function handleControlClaim(frame: ControlClaimFrame): void {
      const { requestId, browserId, tabId, force } = frame.payload;
      const send = (p: Record<string, unknown>) => {
        try {
          ws.send(JSON.stringify({ type: "control.claimResult", payload: { requestId, ...p } }));
        } catch {
          /* ignore */
        }
      };
      const target = browsers.get(browserId);
      if (!target) {
        send({ ok: false, errorCode: "no_browser", browserId });
        return;
      }
      const me = controllerId!;
      const tabKey = tabId ?? WHOLE_TAB;
      const live = browsers.liveClaimsFor(browserId);
      // Claims this request would displace: a WHOLE claim collides with everything
      // by another controller; a tab claim collides with a WHOLE or the same tab.
      const blockers =
        tabKey === WHOLE_TAB
          ? live.filter((c) => c.controllerId !== me)
          : live.filter(
              (c) => c.controllerId !== me && (c.tabId === WHOLE_TAB || c.tabId === tabKey),
            );
      if (blockers.length && !force) {
        const b = blockers[0];
        send({
          ok: false,
          errorCode: "claimed",
          browserId,
          tabId: b.tabId,
          claimedBy: b.controllerName,
          leaseExpiry: b.leaseExpiry,
        });
        return;
      }
      if (blockers.length && force) {
        // Tell each displaced owner, then drop their claims so the steal takes
        // effect. PUSH first (B7) so a connected agent learns immediately rather
        // than discovering it when its next drive is refused, mid-task; fall back
        // to the queued one-shot note only when the push could not be delivered.
        //
        // Deliberately one or the other, never both: an agent told twice about
        // one takeover reads the second as a second takeover.
        for (const b of blockers) {
          const prev = controllers.get(b.controllerId);
          const which = b.tabId === WHOLE_TAB ? "" : ` (tab ${b.tabId})`;
          const message =
            `Heads up: your control of ${target.meta.browser}` +
            (target.meta.label ? ` "${target.meta.label}"` : "") +
            `${which} was taken over by "${nameOf(me)}".`;
          let pushed = false;
          if (prev) {
            try {
              prev.ws.send(
                JSON.stringify({
                  type: "control.leaseLost",
                  payload: {
                    browserId,
                    ...(b.tabId === WHOLE_TAB ? {} : { tabId: b.tabId }),
                    takenBy: nameOf(me),
                    message,
                  },
                }),
              );
              pushed = true;
            } catch {
              /* fall through to the queued note */
            }
          }
          if (!pushed) prev?.takeoverNotices.set(browserId, message);
          browsers.clearClaim(browserId, b.tabId);
        }
      }
      const claim: ClaimInfo = {
        controllerId: me,
        controllerName: nameOf(me),
        leaseExpiry: Date.now() + LEASE_TTL_MS,
      };
      browsers.setClaim(browserId, tabKey, claim);
      broadcastRoster();
      send({ ok: true, browserId, tabId: tabKey, claim });
    }

    /** Release this controller's claim(s) (one tab, one browser, or all). */
    function handleControlRelease(frame: ControlReleaseFrame): void {
      const { requestId, browserId, tabId } = frame.payload;
      const me = controllerId!;
      let released = false;
      if (browserId) {
        if (tabId != null) {
          const live = browsers.liveClaim(browserId, tabId);
          if (live && live.controllerId === me) {
            browsers.clearClaim(browserId, tabId);
            released = true;
          }
        } else {
          released = browsers.releaseClaimsOnBrowser(browserId, me).length > 0;
        }
      } else {
        released = browsers.releaseByController(me).length > 0;
      }
      if (released) broadcastRoster();
      try {
        ws.send(
          JSON.stringify({
            type: "control.claimResult",
            payload: { requestId, ok: true, browserId },
          }),
        );
      } catch {
        /* ignore */
      }
    }

    const onMessage = (raw: unknown) => {
      const now = Date.now();
      if (now - rateWindowStartedAt > RATE_WINDOW_MS) {
        rateWindowStartedAt = now;
        rateCount = 0;
      }
      rateCount += 1;
      // Any frame is proof of life, so a busy controller is never reaped (P0-D).
      // Stamped before the rate-limit check would let a flooding peer keep itself
      // alive, so it goes after it.
      if (rateCount > RATE_MAX_MESSAGES) {
        rlog.info("socket rejected — websocket message rate limit exceeded");
        safeClose(ws, 1008, "rate limit exceeded");
        return;
      }

      const msg = parseFrame(raw);
      if (!msg) {
        rlog.info("socket rejected — frame is not a JSON object");
        safeClose(ws, 1003, "malformed frame");
        return;
      }
      if (!validEnvelope(msg)) {
        rlog.info("socket rejected — invalid frame envelope");
        safeClose(ws, 1003, "invalid frame");
        return;
      }

      if (role === "controller" && controllerId) {
        const me = controllers.get(controllerId);
        if (me) me.lastSeenAt = now;
      }

      // App-level heartbeats (browser + controller) — answer and stop.
      if (msg.type === "ping") {
        try {
          ws.send(JSON.stringify({ type: "pong" }));
        } catch {
          /* ignore */
        }
        return;
      }
      if (msg.type === "control.ping") {
        try {
          ws.send(JSON.stringify({ type: "control.pong" }));
        } catch {
          /* ignore */
        }
        return;
      }
      if (msg.type === "control.bye") {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }

      // ── Role decision on the first identify / control.hello ──
      if (!role) {
        if (isIdentifyFrame(msg)) {
          if (
            token &&
            !verifyAuthResponse(token, authChallenge?.challenge ?? "", msg.payload.auth)
          ) {
            rlog.info("browser identify rejected — auth proof mismatch; closing");
            safeClose(ws, 1008, "auth failed");
            return;
          }
          role = "browser";
          clearTimeout(roleTimer);
          const p = (msg.payload ?? {}) as Record<string, unknown>;
          const meta: ClientMeta = {
            browser: str(p.browser) || "unknown",
            browserVersion: str(p.browserVersion),
            label: str(p.label),
            instanceId: str(p.instanceId),
            tabId: typeof p.tabId === "number" ? p.tabId : undefined,
            tabUrl: str(p.tabUrl),
            tabTitle: str(p.tabTitle),
            connectedAt: Date.now(),
          };
          browserId = browsers.add(ws, meta);
          rlog.info(
            `browser connected id=${browserId.slice(0, 8)} browser=${meta.browser}` +
              (meta.label ? ` label="${meta.label}"` : "") +
              ` (browsers=${browsers.size()})`,
          );
          broadcastRoster();
          return;
        }
        if (isControlHello(msg)) {
          if (
            token &&
            !verifyAuthResponse(token, authChallenge?.challenge ?? "", msg.payload.auth)
          ) {
            rlog.info("controller rejected — auth proof mismatch; closing");
            safeClose(ws, 1008, "auth failed");
            return;
          }
          role = "controller";
          clearTimeout(roleTimer);
          controllerId = randomUUID();
          const ctrlName =
            (msg.payload?.name && String(msg.payload.name).trim()) ||
            `mcp-${msg.payload?.pid ?? "?"}`;
          const instanceId =
            (msg.payload?.instanceId && String(msg.payload.instanceId).trim()) || undefined;
          // Same instance saying hello again ⇒ this IS that controller, restarted
          // or reconnected. Evict the old entry before adding the new one, so the
          // roster shows one agent rather than a growing pile of its own ghosts,
          // and so the claims it held are freed for the incarnation now asking
          // for them (P0-C). Older controllers send no instanceId and are exempt.
          if (instanceId) {
            for (const prev of controllers.values()) {
              if (prev.instanceId === instanceId) dropController(prev.id, "superseded");
            }
          }
          controllers.set(controllerId, {
            id: controllerId,
            ws,
            name: ctrlName,
            pid: typeof msg.payload?.pid === "number" ? msg.payload.pid : undefined,
            instanceId,
            lastSeenAt: Date.now(),
            takeoverNotices: new Map(),
          });
          rlog.info(
            `controller connected id=${controllerId.slice(0, 8)} name="${ctrlName}" (controllers=${controllers.size})`,
          );
          try {
            ws.send(
              JSON.stringify({
                type: "control.welcome",
                payload: {
                  ctrlId: controllerId,
                  // Disambiguated, so this controller reports the same name to its
                  // user that every peer and browser popup sees for it (P0-E).
                  name: nameOf(controllerId),
                  relayVersion: version,
                  relayHost: host,
                  browsers: browsers.info(),
                  controllers: peerList().map((p) => ({
                    ...p,
                    self: p.id === controllerId,
                  })),
                },
              }),
            );
          } catch {
            /* ignore */
          }
          // Let existing controllers learn the new peer, and every browser's popup
          // show the freshly-connected agent (roster changed, even with no claim).
          broadcastRoster();
          return;
        }
        rlog.info(`socket ignored unknown first frame type=${msg.type}`);
        return; // unknown first frame; roleTimer will close the socket
      }

      // ── Ongoing browser identify updates (tab/url changes) ──
      if (role === "browser" && msg.type === "identify" && browserId) {
        const p = (msg.payload ?? {}) as Record<string, unknown>;
        browsers.updateMeta(browserId, {
          browser: str(p.browser),
          browserVersion: str(p.browserVersion),
          label: str(p.label),
          instanceId: str(p.instanceId),
          tabId: typeof p.tabId === "number" ? p.tabId : undefined,
          tabUrl: str(p.tabUrl),
          tabTitle: str(p.tabTitle),
        });
        broadcastBrowsers();
        return;
      }

      // ── Controller forwards a tool call ──
      if (role === "controller" && isControlSend(msg)) {
        void handleControlSend(msg);
        return;
      }

      // ── Controller claim / release (force-steal, explicit release) ──
      if (role === "controller" && isControlClaim(msg)) {
        handleControlClaim(msg);
        return;
      }
      if (role === "controller" && isControlRelease(msg)) {
        handleControlRelease(msg);
        return;
      }
    };

    const onClose = () => {
      clearTimeout(roleTimer);
      clearInterval(hb);
      ws.off("pong", onPong);
      ws.off("message", onMessage);
      if (role === "browser" && browserId) {
        browsers.remove(browserId);
        rlog.info(`browser removed id=${browserId.slice(0, 8)} (browsers=${browsers.size()})`);
        broadcastBrowsers();
      } else if (role === "controller" && controllerId) {
        const freed = browsers.releaseByController(controllerId);
        controllers.delete(controllerId);
        rlog.info(
          `controller removed id=${controllerId.slice(0, 8)} freed=${freed.length} (controllers=${controllers.size})`,
        );
        // The roster shrank, so refresh BOTH wires unconditionally: remaining
        // controllers learn the updated peer list / freed claims, and every
        // browser's popup drops the departed agent (and any claims it held).
        // broadcastBrowsers no-ops when no controllers remain; broadcastAgents
        // no-ops when no browsers — so this is cheap in every case.
        broadcastRoster();
      }
      armIdleExit();
    };

    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", (err) => {
      // An oversized frame does not truncate — `ws` errors and CLOSES the
      // socket, so the peer vanishes and whatever was in flight can only time
      // out. Say so here, because the timeout itself cannot: it is indistinguishable
      // from a wedged page at the tool layer.
      // ponytail: log-level only. Naming the cause in the tool reply needs the
      // in-flight request to be failed at the moment the socket dies — worth
      // doing if this is ever hit again now the ceiling is 64 MiB.
      if (/max payload/i.test(String(err))) {
        rlog.error(
          `socket dropped: a peer sent a frame larger than the ${
            process.env.AUTOMATE_BROWSER_WS_MAX_PAYLOAD_BYTES ?? "64 MiB"
          } limit (${String(err)}). The peer will reconnect, but the request it was ` +
            `answering is lost and will surface as a timeout. Raise ` +
            `AUTOMATE_BROWSER_WS_MAX_PAYLOAD_BYTES if this is a legitimate reply.`,
        );
        return;
      }
      rlog.info("socket error", String(err));
    });
  });

  rlog.info(`relay listening on ws://${host}:${port}`);
  return {
    port,
    close: () => {
      clearInterval(reaper);
      try {
        wss.close();
      } catch {
        /* ignore */
      }
    },
  };
}
