/**
 * B01, the cleanup half: releasing a browser must close tabs in THAT browser and
 * nowhere else.
 *
 * Real Chrome tab ids are small integers allocated per browser, so two profiles
 * hold the same number almost immediately. Cleanup used to send `browser_close_tab`
 * without pinning a browser, and the send path resolved the active one for itself
 * — so releasing Chrome could close Edge's tab of the same number. That is a user's
 * tab disappearing, which is the failure the whole ownership model exists to stop.
 *
 * The second property here is quieter and just as costly: when the owning browser
 * is NOT connected, cleanup must defer rather than either aim elsewhere or throw
 * the record away. Discarding it leaves the agent's tabs in the user's browser
 * permanently, with nothing left that knows they were ours.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.AUTOMATE_BROWSER_CONNECT_WAIT_MS = "200";

const { Context } = await import("@/context");
const { RelaySendError } = await import("@/relay-link");
const { browserInfo, createdTabs, fakeLink, pushRoster, useFakeLink } =
  await import("./helpers/fake-relay");

/**
 * Two browsers whose tab numbering collides — the whole point. Both are told to
 * hand out tab 101 when asked to open one, exactly as two real profiles would.
 */
function twoBrowsers() {
  const context = new Context({ version: "test" });
  const link = fakeLink((frame) =>
    frame.type === "browser_new_tab" ? { tabId: 101, index: 0 } : { ok: true },
  );
  useFakeLink(context, link);
  pushRoster(context, [
    browserInfo("chrome-sock", { browser: "chrome", instanceId: "chrome-profile" }),
    browserInfo("edge-sock", { browser: "edge", instanceId: "edge-profile" }),
  ]);
  return { context, link };
}

/** Every close that was sent, as `browserId:tabId` pairs. */
const closes = (link: { sent: Array<{ type: string; browserId?: string; payload: unknown }> }) =>
  link.sent
    .filter((f) => f.type === "browser_close_tab")
    .map((f) => `${f.browserId}:${(f.payload as { tabId?: number })?.tabId}`);

describe("releasing one browser when two share a tab number", () => {
  it("closes the tab on its OWN browser and never on the other", async () => {
    const { context, link } = twoBrowsers();
    context.setActive({ id: "chrome-sock" });
    // A drive provisions tab 101 on Chrome and records it as ours.
    await context.sendSocketMessage("browser_navigate", { url: "https://example.test" });
    // The user then switches the agent to Edge, which also provisions its own 101.
    context.setActive({ id: "edge-sock" });
    await context.sendSocketMessage("browser_navigate", { url: "https://example.test" });
    // Back to Chrome, and release it.
    context.setActive({ id: "chrome-sock" });

    await context.release();

    assert.deepEqual(
      closes(link),
      ["chrome-sock:101"],
      "releasing Chrome must close Chrome's tab 101 only — Edge's is the user's",
    );
    assert.deepEqual(createdTabs(context, "chrome-profile"), [], "Chrome's record is settled");
    assert.deepEqual(
      createdTabs(context, "edge-profile"),
      [101],
      "Edge's tab is still owed a cleanup, so its record must survive",
    );
  });

  it("then closes Edge's own tab when Edge is released in turn", async () => {
    const { context, link } = twoBrowsers();
    context.setActive({ id: "chrome-sock" });
    await context.sendSocketMessage("browser_navigate", { url: "https://example.test" });
    context.setActive({ id: "edge-sock" });
    await context.sendSocketMessage("browser_navigate", { url: "https://example.test" });

    await context.release();

    assert.deepEqual(closes(link), ["edge-sock:101"]);
  });
});

describe("releasing a browser that is no longer connected", () => {
  it("sends no close at all rather than aiming it at another browser", async () => {
    const { context, link } = twoBrowsers();
    context.setActive({ id: "chrome-sock" });
    await context.sendSocketMessage("browser_navigate", { url: "https://example.test" });
    // Chrome drops off the roster; Edge is still there and would be chosen by any
    // path that resolves "the active browser" at cleanup time.
    pushRoster(context, [
      browserInfo("edge-sock", { browser: "edge", instanceId: "edge-profile" }),
    ]);

    await context.release();

    assert.deepEqual(closes(link), [], "no close may be sent to a browser that does not own it");
  });

  it("keeps the ownership record so a later release still cleans up", async () => {
    const { context, link } = twoBrowsers();
    context.setActive({ id: "chrome-sock" });
    await context.sendSocketMessage("browser_navigate", { url: "https://example.test" });
    pushRoster(context, [
      browserInfo("edge-sock", { browser: "edge", instanceId: "edge-profile" }),
    ]);
    await context.release();

    assert.deepEqual(
      createdTabs(context, "chrome-profile"),
      [101],
      "a deferred cleanup that forgot the tab would leave it open forever",
    );

    // Chrome comes back on a NEW relay id, as a reloaded extension does.
    pushRoster(context, [
      browserInfo("edge-sock", { browser: "edge", instanceId: "edge-profile" }),
      browserInfo("chrome-sock-2", { browser: "chrome", instanceId: "chrome-profile" }),
    ]);
    context.setActive({ id: "chrome-sock-2" });
    await context.release();

    assert.deepEqual(closes(link), ["chrome-sock-2:101"], "the deferred close lands on reconnect");
  });
});

describe("a browser that quits part-way through the sweep", () => {
  it("stops rather than sending the rest of the closes anywhere else", async () => {
    const context = new Context({ version: "test" });
    const link = fakeLink((frame) => {
      if (frame.type === "browser_new_tab") return { tabId: 101, index: 0 };
      if (frame.type === "browser_close_tab") {
        // Answering the first close is the last thing this browser does.
        pushRoster(context, [
          browserInfo("edge-sock", { browser: "edge", instanceId: "edge-profile" }),
        ]);
        throw new RelaySendError("no browser", { code: "no_browser" });
      }
      return { ok: true };
    });
    useFakeLink(context, link);
    pushRoster(context, [
      browserInfo("chrome-sock", { browser: "chrome", instanceId: "chrome-profile" }),
      browserInfo("edge-sock", { browser: "edge", instanceId: "edge-profile" }),
    ]);
    context.setActive({ id: "chrome-sock" });
    await context.sendSocketMessage("browser_navigate", { url: "https://a.test" });
    // A second owned tab, so there is still something left to misdirect.
    context.setActiveTab(102, { created: true });

    await context.release();

    assert.deepEqual(
      closes(link).filter((c) => c.startsWith("edge-sock")),
      [],
      "the remaining closes must not follow the roster to the surviving browser",
    );
    assert.deepEqual(
      createdTabs(context, "chrome-profile").sort(),
      [101, 102],
      "nothing was confirmed closed, so nothing may be forgotten",
    );
  });

  it("does not block waiting for that browser to come back", async () => {
    // Teardown must never wait out the reconnect budget: with several owed tabs
    // that turns closing a browser into a minute of hanging, and deferring to the
    // next release is strictly better than stalling the release in progress.
    const context = new Context({ version: "test" });
    const link = fakeLink((frame) => {
      if (frame.type === "browser_new_tab") return { tabId: 101, index: 0 };
      if (frame.type === "browser_close_tab") {
        throw new RelaySendError("no browser", { code: "no_browser" });
      }
      return { ok: true };
    });
    useFakeLink(context, link);
    pushRoster(context, [browserInfo("chrome-sock", { instanceId: "chrome-profile" })]);
    await context.sendSocketMessage("browser_navigate", { url: "https://a.test" });

    const outcome = await Promise.race([
      context.release().then(() => "released"),
      new Promise((r) => setTimeout(() => r("stalled"), 400).unref()),
    ]);
    assert.equal(outcome, "released");
  });
});

describe("tabs adopted from the user", () => {
  it("are never closed on release, on any browser", async () => {
    const { context, link } = twoBrowsers();
    context.setActive({ id: "chrome-sock" });
    // Adopted, not created: exactly what browser_select_tab records.
    await context.sendSocketMessage("browser_select_tab", { tabId: 4242 }, { noClaim: true });
    context.setActiveTab(4242);

    await context.release();

    assert.deepEqual(closes(link), [], "a tab the user had open is not the agent's to close");
  });
});
