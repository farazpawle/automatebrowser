/**
 * The browser-side WebSocket client. This is where the connection fix lives.
 *
 *   1. It connects on service-worker startup and stays connected — it does NOT
 *      wait for the user to pick a tab. "Connecting" and "which tab to drive"
 *      are now independent (targeting lives in selected-tab.ts / the handlers).
 *   2. Fast discovery: it tries the last-known-good port first, otherwise races
 *      all of 9009-9013 at once and keeps whichever returns a valid `hello`,
 *      closing the rest — so a first connect is ~one round-trip, and every
 *      reconnect after that is effectively instant.
 *   3. It verifies the server's `hello` (`server === "automate-browser"`) before
 *      trusting the socket, then sends `identify` (browser family + label).
 *   4. It dispatches request frames to the automation handlers and replies with
 *      `messageResponse`.
 *
 * Reconnect/keepalive hardening:
 *   - Reconnect uses exponential backoff with jitter (was a fixed 1s interval
 *     that hammered the port range). A clean disconnect retries fast (last-port);
 *     repeated failures back off up to MAX_RECONNECT_MS.
 *   - An application-level ping/pong runs over the live socket so a *half-open*
 *     server (TCP still open but wedged — e.g. laptop sleep/resume) is detected
 *     and the socket dropped, instead of waiting on a TCP close that never comes.
 *     (The browser WebSocket API can't send protocol ping frames, so this is a
 *     JSON `ping` the server answers with `pong`.)
 *   - `reconnect()` is exposed so the popup can force a fresh connect.
 */
import {
  type BrowserCommand,
  type CommandPayload,
  isBrowserCommand,
} from "./generated/browser-messages";
import { buildIdentify, getAuthToken, getRelayHost, signAuthChallenge } from "./identity";
import { loadLastPort, saveLastPort } from "./last-port";
import {
  type AgentClaim,
  type AgentPeer,
  type AuthChallenge,
  isAgents,
  isHello,
  isRelay,
  isRequestFrame,
  isServerValid,
  makeResponse,
  WS_PORT_RANGE,
} from "./protocol";

export type MessageHandler<K extends BrowserCommand> = (
  payload: CommandPayload<K>,
) => Promise<unknown> | unknown;

/**
 * One handler per command the server can send — no more, no fewer. It was
 * `Record<string, (payload: any) => unknown>`, which accepted a typo for a key
 * and typed every payload as `any`; a server-side field rename then compiled on
 * both halves and failed on a user's browser. A command with no handler is now a
 * compile error here, and each handler's payload is the generated shape.
 */
export type HandlerMap = { [K in BrowserCommand]: MessageHandler<K> };

/**
 * The one cast in the dispatch path, and the only place it belongs: an envelope
 * validated at runtime still carries `unknown` arguments, and the generated types
 * describe what the server sends, not what arrived. Generic in `K` so the cast is
 * to that command's own payload rather than to `any`.
 */
function invoke<K extends BrowserCommand>(
  handlers: HandlerMap,
  type: K,
  payload: Record<string, unknown> | undefined,
): Promise<unknown> | unknown {
  return handlers[type]((payload ?? {}) as CommandPayload<K>);
}

export interface ConnectionDeps {
  /** Automation handlers keyed by message type. */
  handlers: HandlerMap;
  /** Called once the socket is confirmed to be a automate-browser server. */
  onConnected?: (port: number) => void;
  /** Called when the live socket closes. */
  onDisconnected?: () => void;
  /**
   * Called on each relay `agents` push with this browser's live claims AND the
   * connected-agent roster (`controllers`; empty from an older relay). The popup
   * lists the roster and annotates each agent with its live claims.
   */
  onAgents?: (claims: AgentClaim[], controllers: AgentPeer[]) => void;
}

/** Handle returned by startConnectionLoop for lifecycle control. */
export interface ConnectionHandle {
  /** Permanently stop the loop and close the live socket. */
  stop: () => void;
  /** Force-close the current socket (if any) and reconnect immediately. */
  reconnect: () => void;
  /** Re-send identify on the live socket so the relay roster shows the current tab. */
  refreshIdentity: () => void;
}

/** Send an identify frame (best-effort) describing this browser + a tab. */
function sendIdentify(
  socket: WebSocket,
  authChallenge?: AuthChallenge,
  legacyToken?: string,
): void {
  void (async () => {
    const token = await getAuthToken();
    const auth =
      token && authChallenge
        ? await signAuthChallenge(token, authChallenge)
        : undefined;
    return buildIdentify(undefined, auth, legacyToken);
  })()
    .then((payload) => {
      try {
        socket.send(
          JSON.stringify({
            id: `identify-${crypto.randomUUID()}`,
            type: "identify",
            payload,
          }),
        );
      } catch {
        /* ignore */
      }
    })
    .catch(() => {
      /* identify is best-effort */
    });
}

/** First retry delay; a clean disconnect resets to this for a fast reconnect. */
const BASE_RECONNECT_MS = 500;
/** Cap for the exponential backoff between failed connect attempts. */
const MAX_RECONNECT_MS = 8_000;
/** ± fraction of randomness applied to each backoff delay (anti-thundering-herd). */
const RECONNECT_JITTER = 0.2;
/** How long a candidate socket has to deliver `hello` before we give up on it. */
const HELLO_TIMEOUT_MS = 1_000;
/**
 * After a non-relay (legacy direct) hello wins the race, hold this long for a
 * possible relay hello and prefer it — so during a mixed rollout the browser
 * migrates to the relay instead of sticking to whichever direct host answered
 * first. A relay hello is taken immediately (no wait).
 */
const RELAY_PREFER_MS = 150;
/** App-level keepalive cadence; a missed pong by the next tick drops the socket. */
const PING_INTERVAL_MS = 15_000;

interface Candidate {
  socket: WebSocket;
  port: number;
  /** The host this candidate was dialled on — remembered with the port (C13). */
  host: string;
  authChallenge?: AuthChallenge;
  legacyToken?: string;
}

export function startConnectionLoop(deps: ConnectionDeps): ConnectionHandle {
  /** The live, hello-validated socket (null while disconnected). */
  let ws: WebSocket | null = null;
  let liveAuthChallenge: AuthChallenge | undefined;
  let liveLegacyToken: string | undefined;
  let connecting = false;
  let stopped = false;
  /** Current backoff delay; grows on failure, resets to base on success. */
  let backoff = BASE_RECONNECT_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  function clearReconnectTimer(): void {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  function scheduleReconnect(delay: number): void {
    if (stopped) return;
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => void tick(), delay);
  }

  /** Apply ±RECONNECT_JITTER randomness so many clients don't retry in lockstep. */
  function jitter(ms: number): number {
    const span = ms * RECONNECT_JITTER;
    return Math.round(ms - span + Math.random() * span * 2);
  }

  /** Grow the backoff after a failed attempt and schedule the next try. */
  function backoffAndRetry(): void {
    scheduleReconnect(jitter(backoff));
    backoff = Math.min(backoff * 2, MAX_RECONNECT_MS);
  }

  async function tick(): Promise<void> {
    if (stopped || ws || connecting) return;
    connecting = true;
    try {
      const winner = await connectOnce();
      if (winner && !stopped) {
        ws = winner.socket;
        liveAuthChallenge = winner.authChallenge;
        liveLegacyToken = winner.legacyToken;
        backoff = BASE_RECONNECT_MS; // reset on success
        await saveLastPort(winner.host, winner.port);
        bindLive(winner.socket, winner.port);
        deps.onConnected?.(winner.port);
      } else if (winner && stopped) {
        try {
          winner.socket.close();
        } catch {
          /* ignore */
        }
      } else {
        backoffAndRetry();
      }
    } catch {
      backoffAndRetry();
    } finally {
      connecting = false;
    }
  }

  // Connect immediately on startup instead of waiting a full interval.
  void tick();

  /**
   * Build the ordered candidate port list: last-good first, then the range. With
   * the singleton relay there is exactly one WS host (the lowest free port, 9009
   * by default), so we always discover it by racing the range — there is no
   * per-port pin to set (a pin would only ever dial a dead port and break the
   * connection, which is why the popup's Server-port field was removed).
   */
  async function candidatePorts(host: string): Promise<number[]> {
    const [start, end] = WS_PORT_RANGE;
    const last = await loadLastPort(host);
    const ports: number[] = [];
    if (last != null && last >= start && last <= end) ports.push(last);
    for (let p = start; p <= end; p++) if (p !== last) ports.push(p);
    return ports;
  }

  /**
   * Open all candidate ports at once; resolve with the first socket that passes
   * the `hello` handshake, closing every other socket. Resolves null if none
   * answer in time.
   */
  async function connectOnce(): Promise<Candidate | null> {
    // C13: normally 127.0.0.1. A non-loopback value means the relay — and the
    // IDE driving this browser — is on ANOTHER machine, and `getRelayHost`
    // refuses to return one unless a token is set.
    const host = await getRelayHost();
    const ports = await candidatePorts(host);
    // Optional shared-secret: if the user set a token in the popup, only trust a
    // server whose `hello` carries the SAME token (rejects rogue local servers).
    const expectedToken = await getAuthToken();
    return new Promise<Candidate | null>((resolve) => {
      const sockets: WebSocket[] = [];
      let settled = false;
      // A valid non-relay (legacy) candidate held while we wait for a relay.
      let preferred: Candidate | null = null;
      let preferTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (winner: Candidate | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (preferTimer !== undefined) clearTimeout(preferTimer);
        for (const s of sockets) {
          if (!winner || s !== winner.socket) {
            try {
              s.close();
            } catch {
              /* ignore */
            }
          }
        }
        resolve(winner);
      };

      const timeout = setTimeout(() => finish(preferred), HELLO_TIMEOUT_MS + 400);

      for (const port of ports) {
        let socket: WebSocket;
        try {
          socket = new WebSocket(`ws://${host}:${port}`);
        } catch {
          continue;
        }
        sockets.push(socket);

        const onHello = (ev: MessageEvent) => {
          let msg: any;
          try {
            msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
          } catch {
            return; // ignore non-JSON / binary frames
          }
          if (!isHello(msg)) return;
          socket.removeEventListener("message", onHello);
          const authChallenge = msg.payload.auth;
          const hasChallenge =
            !!authChallenge &&
            authChallenge.scheme === "hmac-sha256" &&
            typeof authChallenge.challenge === "string";
          const legacyToken =
            expectedToken && msg.payload.token === expectedToken
              ? expectedToken
              : undefined;
          const tokenOk = !expectedToken || hasChallenge || !!legacyToken;
          if (!isServerValid(msg) || !tokenOk) {
            try {
              socket.close();
            } catch {
              /* ignore */
            }
            return;
          }
          // The relay is authoritative (every browser there) — take it at once.
          if (isRelay(msg)) {
            finish({
              socket,
              port,
              host,
              authChallenge: hasChallenge ? authChallenge : undefined,
              legacyToken,
            });
            return;
          }
          // A legacy direct host: keep the first one, but give a relay a brief
          // chance to answer and win before we settle on it.
          if (!preferred) {
            preferred = {
              socket,
              port,
              host,
              authChallenge: hasChallenge ? authChallenge : undefined,
              legacyToken,
            };
            preferTimer = setTimeout(() => finish(preferred), RELAY_PREFER_MS);
          }
        };

        socket.addEventListener("message", onHello);
        // A refused port (no server) just errors — let the others race on.
        socket.addEventListener("error", () => {
          /* ignore; the timeout or another port resolves */
        });
      }

      if (ports.length === 0) finish(null);
    });
  }

  /** Wire the winning socket for ongoing request dispatch + send identify. */
  function bindLive(socket: WebSocket, _port: number): void {
    let awaitingPong = false;

    const stopPing = () => {
      if (pingTimer !== undefined) {
        clearInterval(pingTimer);
        pingTimer = undefined;
      }
    };

    // App-level heartbeat: if a ping goes unanswered by the next tick the socket
    // is half-open (wedged server / suspended machine) — drop it so the reconnect
    // loop can pick a fresh server. Outbound pings + the server's pong replies
    // also count as activity that keeps the MV3 worker warm while connected.
    const startPing = () => {
      awaitingPong = false;
      pingTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (awaitingPong) {
          try {
            socket.close();
          } catch {
            /* ignore */
          }
          return;
        }
        awaitingPong = true;
        try {
          socket.send(
            JSON.stringify({ id: `ping-${crypto.randomUUID()}`, type: "ping" }),
          );
        } catch {
          try {
            socket.close();
          } catch {
            /* ignore */
          }
        }
      }, PING_INTERVAL_MS) as unknown as ReturnType<typeof setInterval>;
    };

    // Identify ourselves (best-effort) so the agent can target this browser.
    sendIdentify(socket, liveAuthChallenge, liveLegacyToken);

    const onMessage = async (ev: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!msg) return;
      if (msg.type === "messageResponse") return; // our own replies
      if (msg.type === "pong") {
        awaitingPong = false; // heartbeat acknowledged
        return;
      }
      // One-way relay push of this browser's live claims + connected-agent
      // roster (no `id`, no reply). `controllers` is absent from an older relay.
      if (isAgents(msg)) {
        deps.onAgents?.(
          Array.isArray(msg.payload.claims) ? msg.payload.claims : [],
          Array.isArray(msg.payload.controllers) ? msg.payload.controllers : [],
        );
        return;
      }
      // A malformed envelope is dropped, not answered: without a usable `id`
      // there is nothing to correlate a reply to, and replying to an arbitrary
      // frame is how a rogue sender gets an echo.
      if (!isRequestFrame(msg)) return;

      if (!isBrowserCommand(msg.type)) {
        socket.send(
          JSON.stringify(
            makeResponse(msg.id, undefined, `Unknown message type: ${msg.type}`),
          ),
        );
        return;
      }
      try {
        const result = await invoke(deps.handlers, msg.type, msg.payload);
        socket.send(JSON.stringify(makeResponse(msg.id, result)));
      } catch (e: any) {
        socket.send(
          JSON.stringify(makeResponse(msg.id, undefined, e?.message || String(e))),
        );
      }
    };

    const onClose = () => {
      socket.removeEventListener("message", onMessage);
      stopPing();
      if (ws === socket) {
        ws = null;
        liveAuthChallenge = undefined;
        liveLegacyToken = undefined;
        deps.onDisconnected?.();
        // A clean disconnect should retry fast (last-port hits immediately).
        backoff = BASE_RECONNECT_MS;
        scheduleReconnect(0);
      }
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    });

    startPing();
  }

  return {
    stop() {
      stopped = true;
      clearReconnectTimer();
      if (pingTimer !== undefined) {
        clearInterval(pingTimer);
        pingTimer = undefined;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
    },
    reconnect() {
      if (stopped) return;
      backoff = BASE_RECONNECT_MS;
      if (ws) {
        // onClose will schedule an immediate reconnect.
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      } else {
        scheduleReconnect(0);
      }
    },
    refreshIdentity() {
      // Re-send identify so the relay roster reflects the current tab (URL/title).
      // No-op while disconnected — the next connect sends a fresh identify anyway.
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendIdentify(ws, liveAuthChallenge, liveLegacyToken);
      }
    },
  };
}
