/**
 * The relay's registry of connected browsers. Each entry wraps the live socket
 * with the same request/response sender the server used to use directly — so
 * forwarding a tool call from a controller is just `sender(type, payload)`,
 * with the browser's `messageResponse` correlated by the sender internally.
 */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

import { createSocketMessageSender } from "@r2r/messaging/ws/sender";

import type { ClaimInfo, ClientInfo, ClientMeta, TabClaim } from "./types";

/**
 * The relay is a PIPE: it forwards whatever type name and payload a controller
 * sent, without interpreting either. So it is deliberately typed against an open
 * map rather than the server's `WireMessageMap` — the relay must keep forwarding a
 * message a newer controller knows about and this build does not.
 */
type RelayMessageMap = Record<string, { payload: unknown; response: unknown }>;

type Sender = ReturnType<typeof createSocketMessageSender<RelayMessageMap>>["sendSocketMessage"];

export interface BrowserConn {
  id: string;
  ws: WebSocket;
  sender: Sender;
  meta: ClientMeta;
  /**
   * Soft leases keyed by tab id (WHOLE_TAB ⇒ a whole-browser lease). Two
   * controllers can hold claims on different tabs of the same browser at once,
   * which is what lets two IDEs drive two tabs concurrently.
   */
  claims: Map<number, ClaimInfo>;
}

export class BrowserRegistry {
  private _map = new Map<string, BrowserConn>();

  add(ws: WebSocket, meta: ClientMeta): string {
    const id = randomUUID();
    const sender = createSocketMessageSender<RelayMessageMap>(ws).sendSocketMessage;
    this._map.set(id, { id, ws, sender, meta, claims: new Map() });
    return id;
  }

  updateMeta(id: string, partial: Partial<ClientMeta>): void {
    const c = this._map.get(id);
    if (!c) return;
    // Only overwrite fields that arrived (don't clobber with undefined).
    Object.assign(
      c.meta,
      Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined)),
    );
  }

  remove(id: string): void {
    this._map.delete(id);
  }

  get(id: string): BrowserConn | undefined {
    return this._map.get(id);
  }

  list(): BrowserConn[] {
    return [...this._map.values()];
  }

  size(): number {
    return this._map.size;
  }

  /** The live (non-expired) claim on a given tab key, lazily clearing a lapsed one. */
  liveClaim(id: string, tabKey: number): ClaimInfo | undefined {
    const c = this._map.get(id);
    const claim = c?.claims.get(tabKey);
    if (!claim) return undefined;
    if (claim.leaseExpiry <= Date.now()) {
      c!.claims.delete(tabKey);
      return undefined;
    }
    return claim;
  }

  /** All live claims on a browser (lazily clearing lapsed ones), with their tab ids. */
  liveClaimsFor(id: string): TabClaim[] {
    const c = this._map.get(id);
    if (!c) return [];
    const now = Date.now();
    const out: TabClaim[] = [];
    for (const [tabId, claim] of c.claims) {
      if (claim.leaseExpiry <= now) {
        c.claims.delete(tabId);
        continue;
      }
      out.push({ ...claim, tabId });
    }
    return out;
  }

  setClaim(id: string, tabKey: number, claim: ClaimInfo): void {
    const c = this._map.get(id);
    if (c) c.claims.set(tabKey, claim);
  }

  clearClaim(id: string, tabKey: number): void {
    const c = this._map.get(id);
    c?.claims.delete(tabKey);
  }

  /**
   * Drop every claim this controller holds on one browser. Returns the tab keys
   * that were freed (so the caller can decide whether to broadcast).
   */
  releaseClaimsOnBrowser(id: string, controllerId: string): number[] {
    const c = this._map.get(id);
    if (!c) return [];
    const freed: number[] = [];
    for (const [tabKey, claim] of c.claims) {
      if (claim.controllerId === controllerId) {
        c.claims.delete(tabKey);
        freed.push(tabKey);
      }
    }
    return freed;
  }

  /** Drop every claim owned by a controller; returns the affected {browserId, tabId}. */
  releaseByController(controllerId: string): Array<{ browserId: string; tabId: number }> {
    const hit: Array<{ browserId: string; tabId: number }> = [];
    for (const c of this._map.values()) {
      for (const [tabKey, claim] of c.claims) {
        if (claim.controllerId === controllerId) {
          c.claims.delete(tabKey);
          hit.push({ browserId: c.id, tabId: tabKey });
        }
      }
    }
    return hit;
  }

  /**
   * Serialisable roster for control frames. `active` is decided per-controller
   * (Context recomputes it), so it is always false here. Live (non-expired)
   * claims are included so controllers can show who is driving each tab.
   */
  info(): ClientInfo[] {
    return this.list().map((c) => {
      const claims = this.liveClaimsFor(c.id);
      return {
        ...c.meta,
        id: c.id,
        active: false,
        ...(claims.length ? { claims } : {}),
      };
    });
  }
}
