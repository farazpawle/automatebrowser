/**
 * B01, the targeting half: a retry must reach the SAME browser and the SAME tab
 * the dispatch was bound to.
 *
 * The defect this pins down is the worst one in the stage, because its symptom is
 * the agent acting on the tab the USER is looking at. `_sendNow` re-resolved both
 * the browser and the tab on every attempt, so a relay `no_browser` — which means
 * nothing executed, and is therefore safe to resend — dropped the dead target and
 * then resent to whatever browser was active next. That browser owned no tab of
 * this controller, so the claiming send carried no tab id at all, and the
 * extension's own fallback drove the focused tab.
 *
 * `no_browser` is the only retried class, so it is the only one modelled here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Set BEFORE the import: the connection budget is read once at module scope, and
// the refusal cases below would otherwise wait the real 30 s.
process.env.AUTOMATE_BROWSER_CONNECT_WAIT_MS = "200";

const { Context } = await import("@/context");
const { RelaySendError } = await import("@/relay-link");
const { browserInfo, fakeLink, ownedTab, pushRoster, useFakeLink } =
  await import("./helpers/fake-relay");

/** What the relay answers when the browser it was told to use has vanished. */
const noBrowser = (): never => {
  throw new RelaySendError("no browser", { code: "no_browser" });
};

/**
 * Assert on the error CODE, not its prose. The code is the contract an agent
 * recovers from; the message is free to be reworded.
 */
const hasCode = (...codes: string[]) => {
  return (e: unknown): true => {
    const code = (e as { code?: string })?.code;
    assert.ok(
      code !== undefined && codes.includes(code),
      `expected one of ${codes.join("/")}, got ${String(code)}: ${String(e)}`,
    );
    return true;
  };
};

/**
 * A context with one connected browser that has already provisioned its own tab,
 * so a claiming send goes straight out instead of opening a tab first.
 */
function ready(respond: Parameters<typeof fakeLink>[0], browsers = [browserInfo("old")]) {
  const context = new Context({ version: "test" });
  const link = fakeLink(respond);
  useFakeLink(context, link);
  pushRoster(context, browsers);
  return { context, link };
}

describe("a claiming retry after the browser vanished", () => {
  it("never resends to a different browser, even when it is the only one left", async () => {
    // Both browsers are connected; "old" is chosen explicitly, then dies.
    const { context, link } = ready(
      (frame) => (frame.browserId === "old" ? noBrowser() : { ok: true }),
      [browserInfo("old"), browserInfo("new")],
    );
    context.setActive({ id: "old" });
    // Provision a tab on "old" the way a real first drive does.
    pushRoster(context, [browserInfo("old"), browserInfo("new")]);

    await assert.rejects(
      () => context.sendSocketMessage("browser_navigate", { url: "https://example.test" }),
      hasCode("NO_BROWSER"),
    );
    assert.equal(
      link.sent.filter((f) => f.type === "browser_navigate" && f.browserId === "new").length,
      0,
      "the navigation must not be delivered to the surviving browser",
    );
  });

  it("resends to the SAME browser when it reconnects under a new relay id", async () => {
    let navs = 0;
    const context = new Context({ version: "test" });
    const link = fakeLink((frame) => {
      if (frame.type === "browser_new_tab") return { tabId: 101, index: 0 };
      if (frame.type !== "browser_navigate") return { ok: true };
      navs++;
      // The first navigation finds the browser gone; the reconnect serves the second.
      if (frame.browserId === "sock-1") return noBrowser();
      return { ok: true };
    });
    useFakeLink(context, link);
    // Same physical browser ("chrome-profile-1"), first socket.
    pushRoster(context, [browserInfo("sock-1", { instanceId: "chrome-profile-1" })]);

    const send = context.sendSocketMessage("browser_navigate", { url: "https://example.test" });
    // It comes back on a NEW relay id, as an extension reload or a revived worker does.
    setTimeout(
      () => pushRoster(context, [browserInfo("sock-2", { instanceId: "chrome-profile-1" })]),
      20,
    );
    await send;

    assert.equal(navs, 2, "exactly one retry");
    const retry = link.sent.filter((f) => f.type === "browser_navigate").at(-1);
    assert.equal(retry?.browserId, "sock-2", "the retry rides the reconnected browser");
    assert.equal(retry?.tabId, 101, "and the ORIGINAL tab, not a fresh or focused one");
    assert.equal(ownedTab(context, "sock-2"), 101, "ownership moves to the new relay id");
  });

  it("carries the original tab id rather than sending a claiming retry with none", async () => {
    const context = new Context({ version: "test" });
    const link = fakeLink((frame) => {
      if (frame.type === "browser_new_tab") return { tabId: 77, index: 0 };
      if (frame.type === "browser_click" && frame.browserId === "sock-1") return noBrowser();
      return { ok: true };
    });
    useFakeLink(context, link);
    pushRoster(context, [browserInfo("sock-1", { instanceId: "inst" })]);

    const send = context.sendSocketMessage("browser_click", { ref: "e1" });
    setTimeout(() => pushRoster(context, [browserInfo("sock-2", { instanceId: "inst" })]), 20);
    await send;

    const claiming = link.sent.filter((f) => f.type === "browser_click");
    assert.equal(claiming.length, 2);
    assert.ok(
      claiming.every((f) => f.tabId === 77),
      "a claiming send with tabId undefined lets the extension drive the user's focused tab",
    );
  });

  it("refuses rather than guessing when the browser reports no stable identity", async () => {
    // An older extension build sends no instanceId, so a reconnect cannot be
    // recognised. Matching by elimination is the bug, so this must refuse.
    const context = new Context({ version: "test" });
    const link = fakeLink((frame) =>
      frame.type === "browser_new_tab" ? { tabId: 5, index: 0 } : noBrowser(),
    );
    useFakeLink(context, link);
    pushRoster(context, [browserInfo("legacy", { instanceId: undefined })]);

    await assert.rejects(
      () => context.sendSocketMessage("browser_navigate", { url: "https://example.test" }),
      hasCode("NO_BROWSER"),
    );
    // One attempt only: with nothing to match on there is no second target.
    assert.equal(link.sent.filter((f) => f.type === "browser_navigate").length, 1);
  });

  it("refuses when the same browser returns but the intended tab is unknown", async () => {
    // Modelled by dispatching with no owned tab at all: provisioning answers
    // without a tab id, so the claiming send has nothing to carry across.
    const context = new Context({ version: "test" });
    const link = fakeLink(() => noBrowser());
    useFakeLink(context, link);
    pushRoster(context, [browserInfo("sock-1", { instanceId: "inst" })]);

    await assert.rejects(
      () => context.sendSocketMessage("browser_click", { ref: "e1" }),
      hasCode("NO_BROWSER", "TAB_GONE"),
    );
    assert.equal(
      link.sent.filter((f) => f.type === "browser_click").length,
      0,
      "provisioning failed, so no click may be attempted at all",
    );
  });
});

describe("a discovery retry", () => {
  it("stays on its own browser and carries no tab", async () => {
    const context = new Context({ version: "test" });
    const link = fakeLink((frame) =>
      frame.browserId === "sock-1" ? noBrowser() : { tabId: 9, index: 0 },
    );
    useFakeLink(context, link);
    pushRoster(context, [
      browserInfo("sock-1", { instanceId: "inst" }),
      browserInfo("other", { instanceId: "other-inst" }),
    ]);
    context.setActive({ id: "sock-1" });

    const send = context.sendSocketMessage("browser_new_tab", { active: false }, { noClaim: true });
    setTimeout(
      () =>
        pushRoster(context, [
          browserInfo("sock-2", { instanceId: "inst" }),
          browserInfo("other", { instanceId: "other-inst" }),
        ]),
      20,
    );
    await send;

    const tries = link.sent.filter((f) => f.type === "browser_new_tab");
    assert.deepEqual(
      tries.map((f) => f.browserId),
      ["sock-1", "sock-2"],
      "the retry follows the same browser, never the unrelated one",
    );
    assert.ok(
      tries.every((f) => f.tabId === undefined),
      "a discovery call targets no specific tab",
    );
  });
});
