/**
 * The WebSocket wire contract between the MCP server (host) and this extension
 * (client). Mirrors the server's `src/vendor/types/messages-ws.ts`.
 *
 *   request  (server -> ext): { id, type, payload }
 *   response (ext -> server): { type: "messageResponse",
 *                               payload: { requestId, result, error } }
 *
 * Control frames added for robust multi-browser connection:
 *   - hello    (server -> ext): server announces itself; we verify it before trusting the socket.
 *   - identify (ext -> server): we report which browser this is so the agent can target it.
 *   - agents   (server -> ext): one-way push of THIS browser's live claims, so the
 *                               popup can list which agents are driving it. No reply.
 */

export const SERVER_NAME = "automate-browser";

/** Inclusive port range scanned to find the server (and that the server binds). */
export const WS_PORT_RANGE: readonly [number, number] = [9009, 9013];

export interface RequestFrame {
  id: string;
  type: string;
  /**
   * Always an object when present. Handlers read fields off it (`p?.action`,
   * `p ?? {}`), so a string or a number here is not a payload with a missing
   * field — it is a frame that should never have been dispatched.
   */
  payload?: Record<string, unknown>;
}

/**
 * The runtime half of the wire contract. `lib/generated/browser-messages.ts` says
 * what each command's payload SHOULD look like; nothing about a generated type
 * survives to runtime, so every frame off the socket is checked here first.
 *
 * Deliberately shallow: it validates the ENVELOPE, not the arguments. The server
 * already parses and polices those against the zod schema the generated types are
 * derived from, and re-deriving that check here is the hand-copy the generator
 * exists to delete.
 */
export function isRequestFrame(msg: unknown): msg is RequestFrame {
  if (typeof msg !== "object" || msg === null) return false;
  const frame = msg as Record<string, unknown>;
  if (typeof frame.id !== "string" || frame.id === "") return false;
  if (typeof frame.type !== "string" || frame.type === "") return false;
  const { payload } = frame;
  if (payload === undefined || payload === null) return true;
  return typeof payload === "object" && !Array.isArray(payload);
}

export interface ResponseFrame {
  type: "messageResponse";
  payload: { requestId: string; result?: unknown; error?: string };
}

export interface HelloFrame {
  id?: string;
  type: "hello";
  payload: {
    server: string;
    version: string;
    port: number;
    token?: string;
    auth?: AuthChallenge;
    /** "relay" for the singleton relay, "direct"/absent for a legacy host. */
    role?: string;
  };
}

export interface AuthChallenge {
  scheme: "hmac-sha256";
  challenge: string;
}

export interface AuthResponse extends AuthChallenge {
  response: string;
}

export interface IdentifyFrame {
  id: string;
  type: "identify";
  payload: IdentifyPayload;
}

export interface IdentifyPayload {
  browser: string;
  browserVersion?: string;
  label?: string;
  instanceId?: string;
  auth?: AuthResponse;
  /** Legacy direct-host fallback only. New relays use `auth` and never receive this. */
  token?: string;
  tabId?: number;
  tabUrl?: string;
  tabTitle?: string;
}

/**
 * Sentinel tab id for a WHOLE-browser claim (an agent driving without selecting a
 * specific tab). Mirrors `WHOLE_TAB` in the server's `src/relay/types.ts`; real
 * Chrome tab ids are always positive, so -1 can never collide with one.
 */
export const WHOLE_TAB = -1;

/**
 * One agent's live soft-lease on a tab of THIS browser, as pushed by the relay in
 * the `agents` frame. Mirrors the server's `TabClaim` (`src/relay/types.ts`).
 */
export interface AgentClaim {
  /** Claimed tab id, or `WHOLE_TAB` for a whole-browser drive (its active tab). */
  tabId: number;
  controllerId: string;
  /** Friendly agent name (e.g. "Claude Code"), shown in the popup. */
  controllerName: string;
  /** Epoch ms when the lease lapses; the popup ignores already-expired claims. */
  leaseExpiry: number;
}

/**
 * One connected agent (controller) in the relay's roster, as pushed in the
 * `agents` frame. Mirrors the server's `PeerInfo` (`src/relay/types.ts`). Unlike
 * `AgentClaim`, a peer is listed while merely CONNECTED — it need not hold a live
 * lease — so the popup can show idle agents instead of only active drivers.
 */
export interface AgentPeer {
  id: string;
  /** Friendly agent name (e.g. "Claude Code"), shown in the popup. */
  name: string;
}

export interface AgentsFrame {
  type: "agents";
  /**
   * `controllers` is optional for back-compat: an older relay sends only
   * `claims`, and the popup then falls back to claim-based rows.
   */
  payload: { claims: AgentClaim[]; controllers?: AgentPeer[] };
}

export function isHello(msg: any): msg is HelloFrame {
  return !!msg && msg.type === "hello" && !!msg.payload;
}

export function isServerValid(msg: HelloFrame): boolean {
  return msg.payload.server === SERVER_NAME;
}

/** True when the hello came from the singleton relay (preferred over a legacy host). */
export function isRelay(msg: HelloFrame): boolean {
  return msg.payload.role === "relay";
}

/** True for the relay's one-way `agents` push (this browser's live claims). */
export function isAgents(msg: any): msg is AgentsFrame {
  return !!msg && msg.type === "agents" && !!msg.payload;
}

export function makeResponse(
  requestId: string,
  result?: unknown,
  error?: string,
): ResponseFrame {
  return { type: "messageResponse", payload: { requestId, result, error } };
}
