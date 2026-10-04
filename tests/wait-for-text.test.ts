/**
 * wait_for text takes a /regex/ and can wait for text to go (plan 14, F13).
 *
 * Benchmark T12 waited for "Result:" to show an answer. The page already said
 * "Result: n/a", so a plain substring test passed at once and the run read the
 * old value. `text` now accepts `/.../` the way `urlPattern` always has, and
 * `state: "detached"` (or "hidden") waits until the text is GONE.
 *
 * The real poller runs against a fake page whose text the test changes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadExtensionModule } from "./helpers/extension-harness";

interface WaitForModule {
  waitForCondition(tabId: number, args: Record<string, unknown>): Promise<{ ok: true }>;
}

/** Run the real poller on a page saying `text`; `later` changes it after 150 ms. */
async function waitOn(text: string, args: Record<string, unknown>, later?: string) {
  const page = { body: { innerText: text } };
  const mod = loadExtensionModule<WaitForModule>("Chrome-extension/lib/automation/wait-for.ts", {
    globals: {
      document: page,
      location: { href: "http://a.test/" },
      chrome: {
        scripting: {
          executeScript: async (o: { func: (...a: unknown[]) => unknown; args: unknown[] }) => [
            { result: await o.func(...o.args) },
          ],
        },
      },
    },
  });
  if (later !== undefined) setTimeout(() => (page.body.innerText = later), 150);
  try {
    // Spread: an object from the vm realm fails a strict deepEqual on its prototype.
    return {
      ...(await mod.exports.waitForCondition(1, { timeoutMs: 600, state: "visible", ...args })),
    };
  } finally {
    mod.dispose();
  }
}

describe("wait_for text as a /regex/", () => {
  it("does not match text that only shares the prefix", async () => {
    await assert.rejects(
      waitOn("Result: n/a", { text: "/Result: \\d+/", timeoutMs: 300 }),
      /not met/,
    );
  });

  it("matches once the page shows a number", async () => {
    assert.deepEqual(await waitOn("Result: n/a", { text: "/Result: \\d+/" }, "Result: 42"), {
      ok: true,
    });
  });

  it("plain text is still a substring", async () => {
    assert.deepEqual(await waitOn("Result: n/a", { text: "Result:" }), { ok: true });
  });

  it("a bad regex falls back to a substring, as urlPattern does", async () => {
    assert.deepEqual(await waitOn("a /(/ b", { text: "/(/" }), { ok: true });
  });
});

describe("wait_for text until it is gone", () => {
  it("detached waits while the text is there", async () => {
    await assert.rejects(
      waitOn("Loading...", { text: "Loading", state: "detached", timeoutMs: 300 }),
      /not met/,
    );
  });

  it("detached resolves once the text has gone", async () => {
    assert.deepEqual(await waitOn("Loading...", { text: "Loading", state: "detached" }, "Done"), {
      ok: true,
    });
  });

  it("hidden means gone too", async () => {
    assert.deepEqual(await waitOn("Done", { text: "Loading", state: "hidden" }), { ok: true });
  });

  it("the default still waits for the text to appear", async () => {
    await assert.rejects(waitOn("Done", { text: "Loading", timeoutMs: 300 }), /not met/);
  });
});
