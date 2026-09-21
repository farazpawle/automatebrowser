/**
 * B01, the provisioning half: the tab opened for a dispatch must be recorded
 * against the browser that actually opened it, and provisioning must not deadlock
 * on the queue slot it is already holding.
 *
 * Two distinct failures meet here. A browser that blips during the very
 * `browser_new_tab` send comes back under a new relay id, so the tab was recorded
 * against a dead one: the send that provisioning existed to serve then owned no
 * tab on its real target, and the record was orphaned — a tab the agent opened
 * that release could never close. The code even carried a warning admitting the
 * gap rather than closing it.
 *
 * The deadlock is the constraint any fix here has to respect. Provisioning runs
 * inside the send queue's own slot, so it must never re-enter the queue; the
 * timing assertion below is what catches a regression that reintroduces it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.AUTOMATE_BROWSER_CONNECT_WAIT_MS = "200";

const { Context } = await import("@/context");
const { RelaySendError } = await import("@/relay-link");
const { browserInfo, createdTabs, fakeLink, ownedTab, pushRoster, useFakeLink } =
  await import("./helpers/fake-relay");

const noBrowser = (): never => {
  throw new RelaySendError("no browser", { code: "no_browser" });
};

describe("a browser that reconnects during provisioning", () => {
  it("records the new tab against the browser that actually opened it", async () => {
    const context = new Context({ version: "test" });
    const link = fakeLink((frame) => {
      // The first provisioning attempt finds the browser gone; the reconnect
      // serves the second and hands back the tab it really opened.
      if (frame.type === "browser_new_tab" && frame.browserId === "sock-1") return noBrowser();
      if (frame.type === "browser_new_tab") return { tabId: 314, index: 0 };
      return { ok: true };
    });
    useFakeLink(context, link);
    pushRoster(context, [browserInfo("sock-1", { instanceId: "inst" })]);

    const send = context.sendSocketMessage("browser_navigate", { url: "https://example.test" });
    setTimeout(() => pushRoster(context, [browserInfo("sock-2", { instanceId: "inst" })]), 20);
    await send;

    assert.equal(ownedTab(context, "sock-2"), 314, "the live relay id owns the tab");
    assert.equal(ownedTab(context, "sock-1"), undefined, "the dead relay id owns nothing");
    const drive = link.sent.filter((f) => f.type === "browser_navigate").at(-1);
    assert.equal(drive?.browserId, "sock-2");
    assert.equal(drive?.tabId, 314, "the drive rides the tab provisioning just opened for it");
  });

  it("keeps the tab cleanable, rather than warning and losing the record", async () => {
    const context = new Context({ version: "test" });
    const link = fakeLink((frame) => {
      if (frame.type === "browser_new_tab" && frame.browserId === "sock-1") return noBrowser();
      if (frame.type === "browser_new_tab") return { tabId: 314, index: 0 };
      return { ok: true };
    });
    useFakeLink(context, link);
    pushRoster(context, [browserInfo("sock-1", { instanceId: "inst" })]);

    const send = context.sendSocketMessage("browser_navigate", { url: "https://example.test" });
    setTimeout(() => pushRoster(context, [browserInfo("sock-2", { instanceId: "inst" })]), 20);
    await send;

    // Keyed by the stable identity, which a reconnect does not change.
    assert.deepEqual(createdTabs(context, "inst"), [314]);
    await context.release();
    const closed = link.sent
      .filter((f) => f.type === "browser_close_tab")
      .map((f) => (f.payload as { tabId?: number })?.tabId);
    assert.deepEqual(closed, [314], "an orphaned record is a tab left in the user's browser");
  });
});

describe("provisioning and the send queue", () => {
  it("opens one tab per browser, not one per call", async () => {
    let opened = 0;
    const context = new Context({ version: "test" });
    const link = fakeLink((frame) => {
      if (frame.type === "browser_new_tab") return { tabId: 900 + opened++, index: 0 };
      return { ok: true };
    });
    useFakeLink(context, link);
    pushRoster(context, [browserInfo("sock", { instanceId: "inst" })]);

    await context.sendSocketMessage("browser_navigate", { url: "https://a.test" });
    await context.sendSocketMessage("browser_click", { ref: "e1" });
    await context.sendSocketMessage("browser_type", {
      ref: "e2",
      element: "the field",
      text: "x",
      submit: false,
    });

    assert.equal(opened, 1, "a round-trip per browser per session, not per tool call");
  });

  it("completes instead of deadlocking on the slot it already holds", async () => {
    // The failure mode this guards is a HANG, so it is asserted as one: a
    // provisioning path that re-entered the queue would never settle.
    const context = new Context({ version: "test" });
    const link = fakeLink((frame) =>
      frame.type === "browser_new_tab" ? { tabId: 5, index: 0 } : { ok: true },
    );
    useFakeLink(context, link);
    pushRoster(context, [browserInfo("sock", { instanceId: "inst" })]);

    const settled = await Promise.race([
      context.sendSocketMessage("browser_click", { ref: "e1" }).then(() => "sent"),
      new Promise((r) => setTimeout(() => r("deadlocked"), 1000).unref()),
    ]);
    assert.equal(settled, "sent");
  });

  it("keeps concurrent calls in the order they were issued", async () => {
    const context = new Context({ version: "test" });
    const link = fakeLink((frame) => {
      if (frame.type === "browser_new_tab") return { tabId: 5, index: 0 };
      // A slow first reply: without the queue the second call would overtake it.
      if (frame.type === "browser_navigate") {
        return new Promise((r) => setTimeout(() => r({ ok: true }), 40));
      }
      return { ok: true };
    });
    useFakeLink(context, link);
    pushRoster(context, [browserInfo("sock", { instanceId: "inst" })]);

    await Promise.all([
      context.sendSocketMessage("browser_navigate", { url: "https://a.test" }),
      context.sendSocketMessage("browser_click", { ref: "e1" }),
    ]);

    assert.deepEqual(
      link.sent.map((f) => f.type),
      ["browser_new_tab", "browser_navigate", "browser_click"],
      "a click must not reach the page before the navigation it was queued behind",
    );
  });
});
