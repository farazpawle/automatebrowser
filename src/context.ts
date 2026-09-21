import { mcpConfig } from "@repo/config/mcp.config";
import type { MessagePayload, MessageResponse, MessageType } from "@repo/messaging/types";

import type { RecoveryState } from "@/relay-link";
import { RelayLink, RelaySendError } from "@/relay-link";
import {
  noConnectionMessage,
  relayClosedMessage,
  relayUpNoBrowsersMessage,
  renderClients,
} from "@/relay/messages";
import type { ClientInfo, ClientSelector, PeerInfo } from "@/relay/types";
import { ToolError } from "@/tools/errors";
import type { WireMessageMap } from "@/tools/messages";
import { getAuthToken } from "@/utils/auth";
import { log } from "@/utils/log";

// Re-export the client types so existing importers (`@/context`) keep working.
export type { ClientInfo, ClientMeta, ClientSelector } from "@/relay/types";

/** How many of a console batch are errors — the C3a footer's only question. */
export function countErrors(entries: Array<Record<string, unknown>>): number {
  return entries.filter((e) => e.level === "error").length;
}

/** Numeric env override with a finite-positive guard (ignores junk values). */
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * How long a tool call blocks waiting for a browser to (re)appear when the roster
 * is empty. Default 30s covers the worst-case MV3 service-worker wake latency: a
 * disconnected extension worker is evicted by Chrome and only revives on its
 * `chrome.alarms` tick (the 30s MV3 floor) / a tab event / the popup — so a 30s
 * budget lets a loaded-but-asleep extension reconnect and the call proceed instead
 * of failing at 5s. Lower it via AUTOMATE_BROWSER_CONNECT_WAIT_MS to fail fast when
 * no extension is present.
 */
const CONNECTION_WAIT_MS = numEnv("AUTOMATE_BROWSER_CONNECT_WAIT_MS", 30_000);

/**
 * Attempts for a single tool send. A relay `no_browser` is a PRE-dispatch refusal
 * (the action never reached a browser), so re-waiting for a reconnecting worker and
 * resending once is side-effect-safe and recovers the "worker was asleep" case.
 */
const MAX_SEND_ATTEMPTS = 2;

/**
 * Hard ceiling on the console-delta probe that decorates a mutating tool result.
 * It is a diagnostic garnish, so it must never cost more than the action itself:
 * the race below caps it even when `sendSocketMessage` would otherwise re-wait
 * CONNECTION_WAIT_MS for a browser that vanished mid-call.
 */
const DELTA_FOOTER_TIMEOUT_MS = numEnv("AUTOMATE_BROWSER_DELTA_FOOTER_MS", 2_000);

/**
 * Opt-out for the console-delta footer (`AUTOMATE_BROWSER_DELTA_FOOTER=off`).
 * On by default: an agent that clicks a button and gets back "Clicked" has no
 * other cheap signal that the page threw.
 */
function deltaFooterEnabled(): boolean {
  const v = (process.env.AUTOMATE_BROWSER_DELTA_FOOTER ?? "").toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

/** Options for one dispatch. */
interface SendOptions {
  timeoutMs?: number;
  noClaim?: boolean;
  /**
   * Pin this send to one browser id rather than resolving the active one, and do
   * NOT wait for that browser to come back if it has gone.
   *
   * The two halves belong together. A pinned send names one specific browser
   * because no other browser is an acceptable substitute; waiting is only ever
   * worth it when you would accept the reconnected instance instead. Its only
   * caller is teardown, where a 30 s wait per tab would turn releasing a browser
   * that just closed into a minute of hanging — deferring to the next release is
   * strictly better than blocking the one in progress.
   */
  browserId?: string;
}

/** Diagnostics snapshot returned to the browser_status tool. */
export interface StatusInfo {
  relayPort?: number;
  relayVersion?: string;
  /** The address the relay is bound to; anything but loopback is reachable off-machine. */
  relayHost?: string;
  /** This controller's own build version, for the relay-mismatch warning. */
  serverVersion: string;
  ctrlId?: string;
  clientName: string;
  browsers: ClientInfo[];
  controllers: PeerInfo[];
  legacyPorts: number[];
  notice?: string;
  /** Whether the link is connected, coming back, or finished (I01). */
  recovery: RecoveryState;
}

/** This controller's human name (per-IDE), used so peers can see who drives what. */
function resolveClientName(): string {
  const n = process.env.AUTOMATE_BROWSER_CLIENT_NAME;
  return n && n.trim() ? n.trim() : `mcp-${process.pid}`;
}

/**
 * Tool-facing facade over the relay. Browsers no longer connect to this process
 * — they connect to the singleton relay, which pushes the roster here. Context
 * keeps the SAME public surface the tools rely on (`sendSocketMessage`,
 * `listClients`, `setActive`, `hasClients`, `close`) and the SAME semantics:
 * selection/disambiguation is decided locally against the cached roster, the
 * resolved `browserId` is sent to the relay, and the relay routes it to that
 * browser. A single MCP server can therefore see and drive every browser the
 * relay holds, alongside other IDEs' servers.
 */
export class Context {
  private readonly _link: RelayLink;
  private readonly _version: string;
  private readonly _clientName = resolveClientName();
  /** Roster cache, keyed by browser id, pushed by the relay (active recomputed). */
  private _cache = new Map<string, ClientInfo>();
  /** The browser tool calls are routed to. */
  private _activeId: string | undefined;
  /** True once a client was chosen via `setActive` (not just auto-selected). */
  private _activeExplicit = false;
  /**
   * Which tab this controller OWNS, per browser id. Set only by an explicit
   * adoption — `browser_select_tab` / `switch_tab` / `new_tab`, or `ensureOwnTab`
   * provisioning a fresh background tab — and sent on every drive so two IDEs can
   * hold two different tabs of one browser.
   *
   * There is deliberately no fallback to the browser's focused tab. That fallback
   * is what let an agent silently adopt and navigate away the tab the USER was
   * working in; `ensureOwnTab` fills the gap by opening a tab of our own instead.
   */
  private _activeTabId = new Map<string, number>();
  /**
   * Tabs this controller OPENED, per browser id — as opposed to tabs it adopted
   * from the user via `browser_select_tab`. Only these are closed on release.
   *
   * The distinction is the whole point: closing a tab the user had open would be
   * the original data-loss bug wearing a different hat. When in doubt, a tab is
   * NOT ours and is left alone.
   */
  private _createdTabId = new Map<string, Set<number>>();
  /**
   * The browser the most recent dispatch was ACTUALLY served by, with its owner
   * key captured while that browser was still in the roster.
   *
   * `setActiveTab` needs this rather than `_activeId`. The two differ in exactly
   * one case, and it is the case that loses data: the browser blipped during the
   * very `browser_new_tab` send, so `_forgetBrowser` cleared `_activeId`, and the
   * tool then had a real tab it had just opened and nowhere to record it. That
   * used to warn and drop the record, leaving a tab that release could never
   * close. Every caller of `setActiveTab`/`clearActiveTab` awaits a send in the
   * same handler first, so this is always that handler's own browser.
   */
  private _lastDispatch: { id: string; key: string } | undefined;
  /**
   * Key `_createdTabId` by the BROWSER, not by its connection.
   *
   * A relay id belongs to a socket: reloading the extension, or an MV3 worker
   * being evicted and revived, brings the same browser back under a brand-new
   * one. `instanceId` is persisted in the extension's own storage and survives
   * both. Keying ownership by the connection meant a reconnect silently orphaned
   * every tab this agent had opened — `release()` then closed nothing and left
   * them sitting in the user's browser, which is the exact litter this ownership
   * model exists to prevent.
   *
   * Measured 2026-09-02 (D8): reproduced on demand by opening a tab, reloading
   * the extension, and releasing — the tab survived. A 90-second idle spell did
   * NOT reproduce it, because the keepalive alarm holds the worker; it is the
   * reconnect that matters, never the idleness.
   *
   * Falls back to the relay id when a browser reports no `instanceId` (an older
   * extension build), which is precisely today's behaviour — never a guess, since
   * a wrong match here would close a tab belonging to a different browser.
   */
  private _ownerKey(id: string): string {
    return this._cache.get(id)?.instanceId ?? id;
  }
  /**
   * High-water mark (epoch ms) for console entries this controller has already
   * reported. Seeded at construction so errors the page logged BEFORE this
   * server existed are never blamed on the agent's first action.
   */
  private _consoleSeenTs = Date.now();
  /** The same high-water mark, for browser-detected issues (C4). Seeded alike. */
  private _issuesSeenTs = Date.now();
  /**
   * Tail of this controller's send queue (roadmap C18). Every `sendSocketMessage`
   * links onto it, so one agent's calls reach the browser strictly in the order
   * it issued them. Without it, two tool calls the client fires concurrently race
   * each other through the relay and can land out of order — a click arriving
   * before the navigation that was supposed to precede it.
   *
   * Per CONTROLLER, not per browser: cross-agent ordering is the relay's job (the
   * per-tab claim), and serializing across agents here would let one idle IDE
   * stall another. A rejected send never wedges the queue — the tail swallows the
   * failure, and the caller still sees the original rejection.
   */
  private _sendQueue: Promise<unknown> = Promise.resolve();
  /** One-shot note pushed by the relay (e.g. a takeover), surfaced via status/list. */
  private _pendingNotice: string | undefined;
  private _waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    /** Wake only when this holds; a roster push alone is not enough. */
    ready?: () => boolean;
  }> = [];

  constructor(opts: { version: string }) {
    this._version = opts.version;
    this._link = new RelayLink(
      { version: opts.version, token: getAuthToken(), name: this._clientName },
      (list) => this._setBrowsers(list),
      // B7/3.5: a takeover reaches the agent with the taxonomy's code on the
      // front, exactly like an error does — `renderError`'s `CODE: message`
      // shape is the one contract an agent has to learn, and a notice that
      // opted out of it would be prose to match again.
      (note, code) => {
        this._pendingNotice = code ? `${code}: ${note}` : note;
      },
    );
  }

  clientName(): string {
    return this._clientName;
  }

  ctrlId(): string | undefined {
    return this._link.ctrlId();
  }

  /** Other connected agents (controllers), for peer visibility. */
  peers(): PeerInfo[] {
    return this._link.peers();
  }

  /** Consume the one-shot relay note (if any). */
  takeNotice(): string | undefined {
    const n = this._pendingNotice;
    this._pendingNotice = undefined;
    return n;
  }

  /** Ensure the relay is up and the controller link is registered. */
  async start(): Promise<void> {
    await this._link.start();
  }

  hasClients(): boolean {
    return this._cache.size > 0;
  }

  /** Snapshot of every connected browser, for `browser_list_clients`. */
  listClients(): ClientInfo[] {
    return [...this._cache.values()].map((c) => ({
      ...c,
      active: c.id === this._activeId,
    }));
  }

  /**
   * Resolve a selector to exactly one connected browser, throwing the same
   * helpful errors `browser_select_client` always raised. Shared by setActive
   * and forceClaim.
   */
  private _resolve(selector: ClientSelector): ClientInfo {
    const all = [...this._cache.values()];
    if (all.length === 0) throw new Error(noConnectionMessage);

    const matches = all.filter((c) => {
      if (selector.id) {
        return c.id === selector.id || c.id.startsWith(selector.id);
      }
      if (selector.label) {
        return (c.label ?? "").toLowerCase() === selector.label.toLowerCase();
      }
      if (selector.browser) {
        return c.browser.toLowerCase() === selector.browser.toLowerCase();
      }
      return false;
    });

    if (matches.length === 0) {
      throw new Error(
        `No connected browser matches ${JSON.stringify(selector)}.\n${renderClients(this._withActive(all))}`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Selector ${JSON.stringify(selector)} matches ${matches.length} browsers — narrow it by id.\n${renderClients(this._withActive(matches))}`,
      );
    }
    return matches[0];
  }

  /** Choose the active browser by id (full or 8-char prefix), browser, or label. */
  setActive(selector: ClientSelector): ClientInfo {
    const chosen = this._resolve(selector);
    this._activeId = chosen.id;
    this._activeExplicit = true;
    return { ...chosen, active: true };
  }

  /**
   * Take over a browser even if another agent is driving it (relay-enforced
   * steal), and make it active. The previous owner is notified on its next
   * action. Throws if the selector doesn't resolve to exactly one browser.
   */
  async forceClaim(selector: ClientSelector): Promise<ClientInfo> {
    const chosen = this._resolve(selector);
    const res = await this._link.claim(chosen.id, true);
    if (!res.ok) {
      throw new Error(
        `Could not take over ${chosen.browser} [id=${chosen.id.slice(0, 8)}]` +
          (res.claimedBy ? ` (held by "${res.claimedBy}")` : "") +
          ".",
      );
    }
    this._activeId = chosen.id;
    this._activeExplicit = true;
    return { ...chosen, active: true };
  }

  /**
   * Release this agent's claim on the active browser so another agent can drive,
   * tidying up after itself first: every tab this controller OPENED is closed. A
   * tab it merely adopted from the user is deliberately left exactly where it was
   * — closing that would be the data-loss bug all over again.
   */
  async release(): Promise<ClientInfo | undefined> {
    if (!this._activeId) return undefined;
    const id = this._activeId;
    const released = this._cache.get(id);
    await this._closeCreatedTabs(id);
    await this._link.release(id);
    return released ? { ...released, active: false } : undefined;
  }

  /**
   * Close the tabs this controller opened on `id`.
   *
   * Every failure is swallowed: the user may have closed the tab already, and a
   * cleanup that turns "released" into an error would be worse than a tab left
   * open. `noClaim` throughout — this is teardown, not a drive, and it must not
   * re-provision a tab through the `ensureOwnTab` hook.
   *
   * Pinned to `id` with `browserId`. A close aimed at "whatever browser is active
   * now" is how releasing Chrome closed Edge's tab of the same number: real tab
   * ids are per-browser and small, so two profiles collide constantly.
   */
  private async _closeCreatedTabs(id: string): Promise<void> {
    const key = this._ownerKey(id);
    const created = this._createdTabId.get(key);
    if (!created?.size) return;
    // Nothing to clean up THROUGH. Keeping the record is the point: the browser
    // is usually about to reconnect, and the next release then closes these tabs
    // for real. Discarding it here would leave them in the user's browser
    // forever, and sending anyway would aim them at another profile.
    if (!this._cache.has(id)) {
      log.debug(
        `[context] release: ${created.size} tab(s) left open — browser ${id.slice(0, 8)} is ` +
          `not connected, so cleanup is deferred rather than aimed elsewhere`,
      );
      return;
    }
    const closed: number[] = [];
    for (const tabId of created) {
      // The browser can go away DURING the sweep — the user quitting it is the
      // ordinary case. Stop here and leave the rest owed: continuing would send
      // closes at a browser that is no longer listening, and the send path would
      // then have to decide where they go instead.
      if (!this._cache.has(id)) {
        log.debug(
          `[context] release: browser ${id.slice(0, 8)} went away mid-sweep; ` +
            `${created.size - closed.length} tab(s) stay owed`,
        );
        break;
      }
      try {
        await this.sendSocketMessage(
          "browser_close_tab",
          { tabId },
          {
            noClaim: true,
            browserId: id,
          },
        );
        closed.push(tabId);
      } catch {
        /* already closed by the user, or the browser went away */
      }
      if (this._activeTabId.get(id) === tabId) this._activeTabId.delete(id);
    }
    // A tab still listed here either no longer exists (the user closed it — done
    // with, forget it) or could not be reached because the browser went away
    // mid-sweep. Only the second is worth keeping for a later release, and the
    // roster tells the two apart without guessing at swallowed error text.
    if (this._cache.has(id)) {
      this._createdTabId.delete(key);
      return;
    }
    for (const tabId of closed) created.delete(tabId);
    if (created.size === 0) this._createdTabId.delete(key);
  }

  /**
   * The browser a call would be routed to right now, or `undefined` when there
   * is none — or when several are connected and none was chosen, which is a
   * question only `_requireActiveId` may answer (by refusing).
   *
   * The RELAY id, deliberately, and not the extension's stable `instanceId`: it
   * identifies one connection, so anything keyed by it is invalidated the moment
   * that connection is replaced. B05's network-policy acknowledgement wants
   * exactly that — see `pushNetPolicy`.
   */
  activeBrowserId(): string | undefined {
    return this._activeId ?? (this._cache.size === 1 ? [...this._cache.keys()][0] : undefined);
  }

  /**
   * Which browser and tab a call is aimed at right now, for the B10 audit line.
   *
   * Reads the SAME state the drive itself uses, so the audit names the tab that
   * was actually driven — and does it locally, with no probe: an audit line that
   * cost a round-trip would be a tax on every single tool call.
   */
  auditTarget(): { browser?: string; tabId?: number } {
    const id = this.activeBrowserId();
    if (!id) return {};
    const c = this._cache.get(id);
    return {
      browser: c
        ? `${c.browser}${c.label ? ` "${c.label}"` : ""} [${id.slice(0, 8)}]`
        : id.slice(0, 8),
      tabId: this._resolveDriveTab(id),
    };
  }

  /** Diagnostics snapshot for browser_status. */
  status(): StatusInfo {
    return {
      relayPort: this._link.relayPort(),
      relayVersion: this._link.relayVersion(),
      relayHost: this._link.relayHost(),
      serverVersion: this._version,
      ctrlId: this._link.ctrlId(),
      // Prefer the name the relay resolved for us: it disambiguates duplicates
      // (P0-E), so "you:" matches what every peer and browser popup shows for
      // this agent. Falls back to the local name before the relay welcomes us.
      clientName: this._link.name() ?? this._clientName,
      browsers: this.listClients(),
      controllers: this._link.peers(),
      legacyPorts: this._link.legacyPorts(),
      notice: this.takeNotice(),
      recovery: this._link.recovery(),
    };
  }

  /**
   * Send one message to the active browser, queued behind this controller's
   * previous send. Safe to call again from inside a tool handler: handlers await
   * one send before starting the next (e.g. an action then its snapshot), so the
   * chain only ever queues — nothing here waits on a send made later.
   */
  async sendSocketMessage<T extends MessageType<WireMessageMap>>(
    type: T,
    payload: MessagePayload<WireMessageMap, T>,
    options: SendOptions = {},
  ) {
    const run = this._sendQueue
      .catch(() => undefined)
      .then(async () => {
        // Resolve the target browser ONCE, here, and hand the same id to
        // provisioning, the send, and every retry inside it. Each step used to
        // resolve the active browser for itself, so a browser that changed
        // mid-dispatch could have the tab provisioned on one browser and the
        // action delivered to another.
        const bound = options.browserId ?? (await this._requireActiveId());
        // Every claiming send drives a tab this controller owns. Provisioning
        // runs INSIDE the queue slot (not via a nested sendSocketMessage, which
        // would await the tail this send is already holding — a deadlock), so the
        // new tab is guaranteed to exist before the send that needs it and after
        // every send this agent issued earlier.
        //
        // It returns the browser it ended up owning a tab on, which is not always
        // the one it was given: provisioning can itself cross a reconnect, moving
        // the browser to a new relay id. Sending to the id we started with would
        // aim at a dead socket AND carry no tab, since the tab is now recorded
        // against the live one.
        const target = options.noClaim ? bound : await this.ensureOwnTab(bound);
        return this._sendNow(type, payload, options, target);
      });
    this._sendQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Guarantee this controller has a tab of its OWN on the active browser, opening
   * a background one if it has none. Idempotent: returns immediately once a tab is
   * adopted, so it costs a round-trip once per browser per session, not per call.
   *
   * This is the rule that stops an agent hijacking the tab the user is working in.
   * The provisioning send is `noClaim` — the same shape `browser_new_tab` uses —
   * both because creating a tab is not tab-exclusive and because a claiming send
   * here would re-enter the hook in `sendSocketMessage` and recurse.
   *
   * Bypasses the send queue on purpose; it is only ever called from within a queue
   * slot. Do not call it from a tool handler.
   *
   * `bound` is the browser its caller's dispatch is pinned to. Provisioning a tab
   * on a browser the following send will not use is worse than useless: the send
   * then owns no tab on its own target and falls back to the user's focused one.
   *
   * Returns the browser that now owns the tab. That is `bound` in every ordinary
   * case, and its reconnected relay id when the browser came back mid-provision —
   * which is the id the caller must then drive.
   */
  async ensureOwnTab(bound?: string): Promise<string> {
    const id = bound ?? (await this._requireActiveId());
    if (this._activeTabId.has(id)) return id;
    const result = (await this._sendNow(
      "browser_new_tab",
      { active: false },
      {
        noClaim: true,
      },
      id,
    )) as { tabId?: number } | undefined;
    if (typeof result?.tabId !== "number") {
      // No tab, so no safe target — and falling back to the focused tab is exactly
      // the bug this method exists to prevent. TAB_GONE rather than a new code: the
      // agent's situation ("you have no tab") and its way out are identical.
      throw new ToolError(
        "TAB_GONE",
        `Could not open a background tab to work in, so there is nothing safe to drive ` +
          `(driving the tab you are viewing is not allowed). Run browser_list_tabs and ` +
          `adopt one deliberately with browser_select_tab.`,
        { recover: "browser_select_tab" },
      );
    }
    // Record the tab against the browser that actually OPENED it. If the browser
    // reconnected during this very send, `_sendNow` completed against its new
    // relay id and `id` above is already dead — recording there would leave the
    // following send with no owned tab on its real target, and a tab nothing can
    // ever clean up.
    const owner = this._lastDispatch ?? { id, key: this._ownerKey(id) };
    this._activeTabId.set(owner.id, result.tabId);
    const created = this._createdTabId.get(owner.key) ?? new Set<number>();
    created.add(result.tabId);
    this._createdTabId.set(owner.key, created);
    log.debug(
      `[context] ensureOwnTab: opened background tab ${result.tabId} on ${owner.id.slice(0, 8)}`,
    );
    return owner.id;
  }

  /**
   * Dispatch one message to ONE browser, retrying a pre-dispatch `no_browser`
   * exactly once — against the SAME physical browser and the SAME tab.
   *
   * The browser and tab are resolved ONCE, before the loop. Resolving them per
   * attempt was the B01 defect: `_forgetBrowser` drops the dead target, so the
   * retry re-resolved whatever was active next — another profile, or the same
   * browser back under a new relay id. Either way the new id owned no tab of
   * ours, so a claiming retry went out with no tab at all and the extension fell
   * back to the tab the USER was looking at.
   */
  private async _sendNow<T extends MessageType<WireMessageMap>>(
    type: T,
    payload: MessagePayload<WireMessageMap, T>,
    options: SendOptions,
    bound?: string,
  ): Promise<MessageResponse<WireMessageMap, T>> {
    const timeoutMs = options.timeoutMs ?? mcpConfig.timeouts.default;
    let id = bound ?? (await this._requireActiveId());
    // The bound browser's connection-independent identity, captured BEFORE any
    // retry: `_forgetBrowser` deletes the roster entry `_ownerKey` reads, so
    // after it there is nothing left to recognise a reconnect by.
    const instanceId = this._cache.get(id)?.instanceId;
    // Discovery/creation calls (noClaim) target no specific tab; everything else
    // rides the tab this controller explicitly owns, so per-tab claims work and
    // two agents on two tabs never collide.
    const tabId = options.noClaim ? undefined : this._resolveDriveTab(id);
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
      this._lastDispatch = { id, key: this._ownerKey(id) };
      try {
        // The wire hands back JSON, so the link answers `unknown`. This is the one
        // place the declared response is asserted: the map says what a message
        // means, and `Answer` (unknown) is what most of it honestly claims.
        return (await this._link.send(
          id,
          type as string,
          payload,
          timeoutMs,
          tabId,
          options.noClaim,
        )) as MessageResponse<WireMessageMap, T>;
      } catch (e) {
        lastErr = e;
        // The owned tab is gone — drop it so the next drive provisions a fresh
        // background tab instead of re-targeting a dead id.
        if (e instanceof RelaySendError && e.code === "tab_gone") {
          this._activeTabId.delete(id);
        }
        // `no_browser` means the relay refused BEFORE dispatching (targeted browser
        // vanished — slept MV3 worker / identify race), so nothing executed. Forget
        // the dead target and retry once: _requireActiveId then blocks for a
        // reconnecting worker (up to CONNECTION_WAIT_MS) instead of failing now.
        const isNoBrowser =
          (e instanceof RelaySendError && e.code === "no_browser") ||
          (e instanceof Error && e.message === mcpConfig.errors.noConnectedTab);
        // A pinned send does not wait for a reconnect — see `SendOptions`.
        if (isNoBrowser && attempt + 1 < MAX_SEND_ATTEMPTS && options.browserId === undefined) {
          this._forgetBrowser(id);
          // Only the SAME browser coming back may be retried against. Any other
          // browser is a different profile with different tabs and a different
          // logged-in session; delivering there is not a recovery.
          const back = await this._awaitSameBrowser(instanceId);
          if (back === undefined) throw this._mapSendError(e);
          if (!options.noClaim) {
            // A claiming retry must carry the tab the dispatch was bound to.
            // Sending without one is precisely how the extension ends up driving
            // whatever the user is viewing, so this refuses instead.
            if (tabId == null) {
              throw new ToolError(
                "TAB_GONE",
                `The tab this action was aimed at could not be recovered after the browser ` +
                  `reconnected, so it was NOT retried (driving a different tab could act on ` +
                  `the page you are viewing). Run browser_list_tabs and adopt one with ` +
                  `browser_select_tab, then repeat the action.`,
                { recover: "browser_select_tab" },
              );
            }
            // Same physical browser, so the same real tab id — re-register it
            // under the new relay id the reconnect brought it back on.
            this._activeTabId.set(back, tabId);
          }
          log.debug(
            `[context] no_browser on ${String(type)} (browser ${id.slice(0, 8)} gone); ` +
              `same browser is back as ${back.slice(0, 8)}, retrying on tab ${tabId ?? "-"} ` +
              `(attempt ${attempt + 2}/${MAX_SEND_ATTEMPTS})`,
          );
          id = back;
          continue;
        }
        throw this._mapSendError(e);
      }
    }
    throw this._mapSendError(lastErr);
  }

  /**
   * Count console errors the driven tab logged since the last check, then advance
   * the high-water mark. Returns 0 when the footer is opted out, when nothing new
   * errored, or when the probe fails for ANY reason — a diagnostic garnish must
   * never turn a successful action into an error, so nothing here throws.
   *
   * Known limits (documented, not hidden): console only — a network 500 the page
   * swallows is invisible until the extension-side counter lands (C4/B1), and a
   * navigation that replaces the page also replaces the ring buffer, so errors
   * from the previous document are lost rather than reported late.
   */
  /**
   * New browser-detected issues since the last probe (C4 + the Stage 4 footer).
   *
   * Separate from the console count on purpose: these are precisely the failures
   * that produce NO console error — a CSP block, a failed request — so folding
   * them into "console errors" would mislabel them and send the agent to the
   * wrong tool. Same contract as the console probe: bounded, swallowed on any
   * failure, and can therefore only ever ADD a line.
   */
  async issuesDelta(): Promise<number> {
    if (!deltaFooterEnabled()) return 0;
    try {
      const r = await Promise.race([
        this.sendSocketMessage(
          "browser_issues",
          {},
          {
            timeoutMs: DELTA_FOOTER_TIMEOUT_MS,
          },
        ),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("issues-delta probe timed out")),
            DELTA_FOOTER_TIMEOUT_MS,
          ).unref();
        }),
      ]);
      const list = (r as { issues?: Array<{ ts?: unknown }> })?.issues;
      if (!Array.isArray(list)) return 0; // older extension build: no such message
      const mark = this._issuesSeenTs;
      let newest = mark;
      let fresh = 0;
      for (const i of list) {
        const ts = typeof i?.ts === "number" ? i.ts : 0;
        if (ts > newest) newest = ts;
        if (ts > mark) fresh++;
      }
      this._issuesSeenTs = newest;
      return fresh;
    } catch {
      return 0;
    }
  }

  /**
   * Console entries that are NEW since the last look, advancing the one
   * high-water mark as it goes.
   *
   * This is the single primitive both the C3a footer and C3b's `include` read
   * from: a second mark would let the footer and the attached payload disagree
   * about what "new" means, which is precisely the drift C3b must not introduce.
   * One probe per call, whichever of the two asked for it.
   */
  async takeNewConsole(): Promise<Array<Record<string, unknown>>> {
    const startedAt = Date.now();
    try {
      const logs = await Promise.race([
        this.sendSocketMessage(
          "browser_get_console_logs",
          {},
          {
            timeoutMs: DELTA_FOOTER_TIMEOUT_MS,
          },
        ),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("console-delta probe timed out")),
            DELTA_FOOTER_TIMEOUT_MS,
          ).unref();
        }),
      ]);
      if (!Array.isArray(logs)) return [];

      const mark = this._consoleSeenTs;
      let newest = mark;
      const fresh: Array<Record<string, unknown>> = [];
      for (const entry of logs as Array<{ level?: unknown; ts?: unknown }>) {
        const ts = typeof entry?.ts === "number" ? entry.ts : 0;
        if (ts > newest) newest = ts;
        if (ts > mark) fresh.push(entry as Record<string, unknown>);
      }
      // Advance to the newest entry actually seen, not to `now`: an entry that
      // lands while this round-trip is in flight must still be counted next time.
      this._consoleSeenTs = newest;
      log.debug(`[context] console-delta fresh=${fresh.length} ms=${Date.now() - startedAt}`);
      return fresh;
    } catch (e) {
      log.debug(`[context] console-delta skipped after ${Date.now() - startedAt}ms: ${String(e)}`);
      return [];
    }
  }

  async consoleErrorDelta(): Promise<number> {
    if (!deltaFooterEnabled()) return 0;
    try {
      return countErrors(await this.takeNewConsole());
    } catch {
      return 0;
    }
  }

  /**
   * Record which tab this controller drives on the active browser. Called by the
   * tab tools after they resolve/create a tab. Subsequent drives ride this tab.
   */
  setActiveTab(tabId: number, opts: { created?: boolean } = {}): void {
    const owner = this._tabOwner();
    if (!owner) {
      // Only reachable when nothing has been dispatched at all, so there is no
      // tab to have created either. A `created` tab with no owner used to be
      // possible — a browser blipping during the very `browser_new_tab` send
      // cleared `_activeId` and the record was dropped with a warning, leaving a
      // tab release could never close. `_lastDispatch` closes that gap.
      if (opts.created) {
        log.warn(
          `[context] tab ${tabId} was opened by this agent but could NOT be recorded as ours ` +
            `(no browser had been dispatched to) — it will not be closed on release`,
        );
      }
      return;
    }
    this._activeTabId.set(owner.id, tabId);
    if (opts.created) {
      const set = this._createdTabId.get(owner.key) ?? new Set<number>();
      set.add(tabId);
      this._createdTabId.set(owner.key, set);
    }
  }

  /** Forget the active-tab selection (e.g. after closing it) for the active browser. */
  clearActiveTab(tabId?: number): void {
    const owner = this._tabOwner();
    if (!owner) return;
    if (tabId == null || this._activeTabId.get(owner.id) === tabId) {
      this._activeTabId.delete(owner.id);
    }
    // A closed tab is no longer ours to clean up on release.
    if (tabId == null) this._createdTabId.delete(owner.key);
    else this._createdTabId.get(owner.key)?.delete(tabId);
  }

  /**
   * Which browser a tab-ownership record belongs to: the one the calling
   * handler's send was actually served by, falling back to the active selection
   * when nothing has been dispatched yet. See `_lastDispatch`.
   */
  private _tabOwner(): { id: string; key: string } | undefined {
    if (this._lastDispatch) return this._lastDispatch;
    if (!this._activeId) return undefined;
    return { id: this._activeId, key: this._ownerKey(this._activeId) };
  }

  /**
   * Resolve which tab THIS controller drives on browser `id` for a claiming send:
   * the tab it explicitly owns, or `undefined` when it owns none.
   *
   * There is no fallback to the browser's focused tab, and there must never be one
   * again. The fallback silently adopted whatever the USER happened to be looking
   * at, so an agent asked to test a URL could navigate away a tab holding unsaved
   * work. A claiming send now always runs after `ensureOwnTab`, so `undefined` here
   * only ever reaches the audit line (which does not provision).
   */
  private _resolveDriveTab(id: string): number | undefined {
    return this._activeTabId.get(id);
  }

  /**
   * Wait for the browser identified by `instanceId` to come back in the roster
   * under its new relay id, and return that id. `undefined` means it did not
   * return within the connection budget, or cannot be recognised at all.
   *
   * A missing `instanceId` is the second case: an older extension build reports
   * no stable identity, so there is nothing to match a reconnect against.
   * Matching "the only browser still connected" by elimination is exactly how a
   * retry ended up driving a different profile, so this refuses to guess.
   */
  private async _awaitSameBrowser(instanceId: string | undefined): Promise<string | undefined> {
    if (!instanceId) return undefined;
    const find = (): string | undefined =>
      [...this._cache.values()].find((c) => c.instanceId === instanceId)?.id;
    const already = find();
    if (already) return already;
    try {
      await this._waitForConnection(() => find() !== undefined);
    } catch {
      return undefined;
    }
    return find();
  }

  /** Translate a relay/link failure into the user-facing, actionable message. */
  private _mapSendError(e: unknown): Error {
    // Browser/tab claimed by another agent — name them and offer the way forward.
    if (e instanceof RelaySendError && e.code === "claimed") {
      const b = (e.browserId && this._cache.get(e.browserId)) || undefined;
      const fam = b?.browser ?? "that browser";
      const cap = fam.charAt(0).toUpperCase() + fam.slice(1);
      const what =
        e.tabId != null && e.tabId >= 0
          ? `Tab ${e.tabId} of ${cap}${b?.label ? ` "${b.label}"` : ""}`
          : `${cap}${b?.label ? ` "${b.label}"` : ""}`;
      return new ToolError(
        "TAB_CLAIMED",
        `${what} is currently being driven by "${e.claimedBy ?? "another agent"}". ` +
          `Wait for it to finish, drive a different tab (browser_select_tab) or browser ` +
          `(browser_select_client), or call browser_force_claim to take over.`,
        { recover: "browser_force_claim" },
      );
    }
    // The selected tab no longer exists — guide the agent to re-pick one.
    if (e instanceof RelaySendError && e.code === "tab_gone") {
      return new ToolError(
        "TAB_GONE",
        `The tab you were driving${e.tabId != null ? ` (tabId=${e.tabId})` : ""} has closed. ` +
          `Run browser_list_tabs and pick another with browser_select_tab.`,
        { recover: "browser_list_tabs" },
      );
    }
    // The browser we targeted is gone / none connected.
    if (
      (e instanceof RelaySendError && e.code === "no_browser") ||
      (e instanceof Error && e.message === mcpConfig.errors.noConnectedTab)
    ) {
      // Not retryable HERE: _sendNow already re-waited and resent once before it
      // got this far, so a third attempt would only re-burn CONNECTION_WAIT_MS.
      return new ToolError("NO_BROWSER", this._noTargetMessage());
    }
    // Relay link dropped mid-call — retryable.
    if (e instanceof Error && e.message === "relay connection closed") {
      return new ToolError("NO_BROWSER", relayClosedMessage, { retryable: true });
    }
    return e instanceof Error ? e : new Error(String(e));
  }

  /**
   * Drop a browser that the relay just reported gone, so the next _requireActiveId
   * blocks for a fresh one instead of instantly re-resolving the dead id. Mirrors
   * the reconciliation _setBrowsers does on a roster push.
   */
  private _forgetBrowser(id: string): void {
    this._cache.delete(id);
    this._activeTabId.delete(id);
    // `_createdTabId` is deliberately LEFT BEHIND. This runs on the `no_browser`
    // retry — a browser that has usually just gone away for a moment and is
    // about to reconnect under a new id. Deleting here would destroy the record
    // before the next roster push gets the chance to carry it over by
    // `instanceId` (see `_setBrowsers`), and `release()` would then leave the
    // agent's tabs open in the user's browser. If the browser really is gone for
    // good, that same roster push finds no heir and prunes the entry.
    if (this._activeId === id) {
      this._activeId = undefined;
      this._activeExplicit = false;
    }
  }

  /** Distinguish "relay up, 0 browsers" / "your browser disconnected" / generic. */
  private _noTargetMessage(): string {
    if (this._cache.size === 0) {
      return this._link.relayPort() != null ? relayUpNoBrowsersMessage : noConnectionMessage;
    }
    return noConnectionMessage;
  }

  async close() {
    const waiters = this._waiters.splice(0);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("Server shutting down"));
    }
    await this._link.close();
    this._cache.clear();
    this._activeId = undefined;
    this._activeExplicit = false;
  }

  private _withActive(list: ClientInfo[]): ClientInfo[] {
    return list.map((c) => ({ ...c, active: c.id === this._activeId }));
  }

  /**
   * Apply a roster push from the relay and reconcile the active selection:
   * a vanished active falls back (single remaining → implicit active), matching
   * the old addClient/removeClient behaviour.
   */
  private _setBrowsers(list: ClientInfo[]): void {
    this._cache = new Map(list.map((c) => [c.id, { ...c, active: false }]));
    // Drop owned-tab entries for browsers that have gone (avoids stale ids
    // surviving an MV3 worker eviction that re-registers the browser fresh).
    for (const id of this._activeTabId.keys()) {
      if (!this._cache.has(id)) this._activeTabId.delete(id);
    }
    // `_createdTabId` is NOT pruned here — see `_ownerKey`. It is keyed by the
    // extension's own stable id, which a reconnect does not change, so there are
    // no dead entries to sweep. Pruning on absence is exactly what used to lose
    // the record: a reload is a disconnect and THEN a reconnect, so there is no
    // moment when the old and new ids are both present to hand over between.
    if (this._activeId && !this._cache.has(this._activeId)) {
      this._activeId = undefined;
      this._activeExplicit = false;
    }
    if (!this._activeId && this._cache.size === 1) {
      this._activeId = [...this._cache.keys()][0];
    }
    if (this._cache.size > 0) this._flushWaiters();
  }

  /**
   * Resolve which browser id to send to: wait briefly if none connected yet
   * (instant-connect path), refuse to guess when several are connected and none
   * was explicitly chosen.
   */
  private async _requireActiveId(): Promise<string> {
    if (this._cache.size === 0) {
      await this._waitForConnection();
    }
    if (this._cache.size > 1 && !this._activeExplicit) {
      throw new Error(
        `Multiple browsers are connected; choose one with browser_select_client ` +
          `({ browser: "edge" } | { label: "…" } | { id: "…" }).\n` +
          renderClients(this.listClients()),
      );
    }
    if (this._activeId && this._cache.has(this._activeId)) return this._activeId;
    if (this._cache.size === 1) {
      this._activeId = [...this._cache.keys()][0];
      return this._activeId;
    }
    throw new Error(noConnectionMessage);
  }

  /**
   * Block until `ready` holds (default: any browser is connected), or reject at
   * CONNECTION_WAIT_MS. The predicate exists so a retry can wait for ITS OWN
   * browser: without it, a roster push carrying some other browser satisfied the
   * wait and the caller had to treat an unrelated arrival as its reconnect.
   */
  private _waitForConnection(ready?: () => boolean): Promise<void> {
    const done = ready ?? ((): boolean => this._cache.size > 0);
    if (done()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this._waiters.splice(idx, 1);
        reject(new Error(noConnectionMessage));
      }, CONNECTION_WAIT_MS);
      this._waiters.push({ resolve, reject, timer, ready: done });
    });
  }

  private _flushWaiters(): void {
    const keep: typeof this._waiters = [];
    for (const w of this._waiters) {
      // A waiter still waiting for its own condition stays asleep. Waking it on
      // any roster push is what made "wait for a browser" mean "wait for one".
      if (w.ready && !w.ready()) {
        keep.push(w);
        continue;
      }
      clearTimeout(w.timer);
      w.resolve();
    }
    this._waiters = keep;
  }
}
