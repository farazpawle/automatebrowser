/**
 * A stand-in for the relay link, so `Context`'s ownership, targeting and retry
 * rules can be tested without a relay process, a browser or a socket.
 *
 * Why replace the link rather than drive the real one: the defects these tests
 * cover (B01) live entirely in which browser and which tab a dispatch is aimed
 * at. That decision is made before a single byte leaves the process, so a fake
 * that records the outgoing frame observes it exactly — and a test that has to
 * boot a relay to check it would be slower, flakier, and no more truthful.
 *
 * The link is swapped in AFTER construction. `RelayLink`'s constructor only
 * stores its arguments, so building one is inert and the real object is simply
 * discarded. Roster pushes are delivered by calling `Context`'s own private
 * `_setBrowsers`, which is precisely the entry point the real link calls.
 */
import type { Context } from "@/context";
import type { ClientInfo } from "@/relay/types";

/** One outgoing dispatch, as the relay would have received it. */
export interface SentFrame {
  browserId: string | undefined;
  type: string;
  payload: unknown;
  tabId: number | undefined;
  noClaim: boolean | undefined;
}

/** What a fake browser does with a frame: return a result, or throw. */
export type Responder = (frame: SentFrame, nth: number) => unknown;

export interface FakeLink {
  /** Every frame sent, in order. The whole point of the fake. */
  sent: SentFrame[];
  /** Browser ids passed to `release`, in order. */
  released: Array<string | undefined>;
}

/**
 * Build a fake link. `respond` sees each frame and the 1-based count of frames
 * sent so far, so a test can fail the first attempt and succeed on the retry.
 */
export function fakeLink(respond: Responder): FakeLink {
  const sent: SentFrame[] = [];
  const released: Array<string | undefined> = [];
  return {
    sent,
    released,
    async send(
      browserId: string | undefined,
      type: string,
      payload: unknown,
      _timeoutMs: number,
      tabId?: number,
      noClaim?: boolean,
    ): Promise<unknown> {
      const frame: SentFrame = { browserId, type, payload, tabId, noClaim };
      sent.push(frame);
      return respond(frame, sent.length);
    },
    async release(browserId?: string): Promise<{ ok: boolean }> {
      released.push(browserId);
      return { ok: true };
    },
    async claim(): Promise<{ ok: boolean }> {
      return { ok: true };
    },
    async start(): Promise<void> {},
    async close(): Promise<void> {},
    ctrlId: () => "ctrl-test",
    name: () => "test-agent",
    peers: () => [],
    relayPort: () => 9009,
    relayVersion: () => "test",
    relayHost: () => "127.0.0.1",
    legacyPorts: () => [],
    listBrowsers: () => [],
  } as unknown as FakeLink;
}

/** Replace the context's relay link with a fake. */
export function useFakeLink(context: Context, link: FakeLink): void {
  (context as unknown as { _link: FakeLink })._link = link;
}

/** Deliver a roster push, exactly as the relay does. */
export function pushRoster(context: Context, list: ClientInfo[]): void {
  (context as unknown as { _setBrowsers(l: ClientInfo[]): void })._setBrowsers(list);
}

/**
 * A connected browser. `instanceId` defaults to the id so each fake browser has
 * a stable identity by default; pass `instanceId: undefined` explicitly to model
 * an older extension build that reports none.
 */
export function browserInfo(id: string, over: Partial<ClientInfo> = {}): ClientInfo {
  return {
    id,
    browser: "chrome",
    instanceId: id,
    connectedAt: 0,
    active: false,
    ...over,
  };
}

/** The tab this controller currently owns on `browserId`, if any. */
export function ownedTab(context: Context, browserId: string): number | undefined {
  return (context as unknown as { _activeTabId: Map<string, number> })._activeTabId.get(browserId);
}

/** The set of tabs recorded as OPENED by this controller, keyed by owner. */
export function createdTabs(context: Context, ownerKey: string): number[] {
  const map = (context as unknown as { _createdTabId: Map<string, Set<number>> })._createdTabId;
  return [...(map.get(ownerKey) ?? [])];
}
