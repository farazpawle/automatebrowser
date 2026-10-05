/**
 * `browser_eval` runs the caller's JavaScript through `chrome.userScripts`, never `eval`.
 *
 * The Chrome Web Store's Manifest V3 policy names "using eval() to execute a string
 * fetched from a remote source" as a violation and allows remote logic ONLY through
 * the Debugger or User Scripts APIs. A server-supplied string run with `eval` was
 * exactly that, so the store listing could not truthfully answer "no remote code".
 *
 * What these pin down: the caller's code reaches the page only as a `userScripts`
 * injection, in the right frame and world; the extension's own packaged helpers
 * still resolve element refs; the per-extension "Allow User Scripts" toggle being
 * off is a coded refusal a person can act on, with nothing run; and no `eval(`
 * creeps back into the driver.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadExtensionModule } from "./helpers/extension-harness";

const DRIVER = "Chrome-extension/lib/automation/driver.ts";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface DriverModule {
  evaluate(tabId: number, args: Record<string, unknown>): Promise<unknown>;
}

interface Execution {
  target: { tabId: number; frameIds?: number[] };
  world?: string;
  js: { code?: string }[];
}

interface Options {
  /** `undefined` = the toggle is off (Chrome leaves the namespace undefined). */
  userScripts?: "available" | "revoked" | undefined;
  /** What the injected user script is pretended to have produced. */
  injected?: { result?: unknown; error?: string };
  /** What the packaged ref-resolving helper is pretended to have returned. */
  prep?: unknown;
}

function loadDriver(opts: Options = {}) {
  const runs: { world?: string; frameId?: number; args: unknown[] }[] = [];
  const executions: Execution[] = [];
  const userScripts =
    opts.userScripts === undefined
      ? undefined
      : {
          getScripts: () => {
            // Revoked while the worker runs: the namespace stays, every call throws.
            if (opts.userScripts === "revoked") throw new Error("API not available");
            return Promise.resolve([]);
          },
          execute: async (injection: Execution) => {
            executions.push(injection);
            return [{ frameId: 0, documentId: "d", ...(opts.injected ?? { result: "Example" }) }];
          },
        };
  const mod = loadExtensionModule<DriverModule>(DRIVER, {
    globals: {
      chrome: {
        tabs: {
          get: async () => ({ url: "https://example.test/", status: "complete" }),
          onUpdated: { addListener: () => {}, removeListener: () => {} },
        },
        userScripts,
      },
    },
    mocks: {
      "../preserved-logs": { getPreserved: async () => [] },
      "./emulate": { waitMultiplier: () => 1 },
      "./run-func": {
        runFunc: async (
          _tabId: number,
          _fn: unknown,
          args: unknown[],
          world?: string,
          frameId?: number,
        ) => {
          runs.push({ world, frameId, args });
          return opts.prep ?? { ok: true };
        },
        runFuncAllFrames: async () => [],
        unwrap: <T>(r: T) => r,
      },
    },
  });
  return { ...mod, runs, executions };
}

/** Copy a value out of the vm realm so deep comparison ignores prototype identity. */
const own = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("browser_eval via chrome.userScripts", () => {
  it("refuses with USER_SCRIPTS_DISABLED, running nothing, when the toggle is off", async () => {
    for (const state of [undefined, "revoked"] as const) {
      const driver = loadDriver({ userScripts: state });
      try {
        const err = await driver.exports.evaluate(1, { expression: "document.title" }).then(
          () => assert.fail(`expected a refusal (${state})`),
          (e: Error) => e,
        );
        assert.match(err.message, /^USER_SCRIPTS_DISABLED: /, String(state));
        assert.match(err.message, /Allow User Scripts/, "must name the toggle a person flips");
        assert.equal(driver.runs.length, 0, "nothing may be injected");
        assert.equal(driver.executions.length, 0);
      } finally {
        driver.dispose();
      }
    }
  });

  it("runs an expression as a user script in the page's MAIN world and returns its value", async () => {
    const driver = loadDriver({ userScripts: "available", injected: { result: "Example" } });
    try {
      const value = await driver.exports.evaluate(1, { expression: "document.title" });
      assert.equal(value, "Example");
      assert.equal(driver.executions.length, 1);
      const ex = own(driver.executions[0]!);
      assert.equal(ex.world, "MAIN");
      assert.deepEqual(ex.target, { tabId: 1, frameIds: [0] });
      assert.match(ex.js[0]!.code!, /document\.title/);
    } finally {
      driver.dispose();
    }
  });

  it("keeps an expression's let/const scoped, so a second call can reuse a name", async () => {
    const driver = loadDriver({ userScripts: "available" });
    try {
      await driver.exports.evaluate(1, { expression: "const t = document.title; t" });
      const code = driver.executions[0]!.js[0]!.code!;
      // A bare top-level `const` in a classic script would collide on the next call;
      // a block keeps it local and still yields the last statement's value.
      assert.match(code, /^\{[\s\S]*const t = document\.title; t[\s\S]*\}$/);
    } finally {
      driver.dispose();
    }
  });

  it("resolves refs with the packaged helper, then calls the function in that frame", async () => {
    const driver = loadDriver({ userScripts: "available", injected: { result: "Hi" } });
    try {
      const value = await driver.exports.evaluate(1, {
        function: "(el) => el.textContent",
        args: ["f3:e9c4"],
      });
      assert.equal(value, "Hi");
      assert.equal(driver.runs[0]!.frameId, 3, "refs resolve inside frame 3");
      assert.deepEqual(own(driver.runs[0]!.args[0]), ["e9c4"], "prefix stripped");
      const ex = own(driver.executions[0]!);
      assert.deepEqual(ex.target, { tabId: 1, frameIds: [3] });
      assert.ok(ex.js[0]!.code!.includes("(el) => el.textContent"), "source inlined, not eval'd");
    } finally {
      driver.dispose();
    }
  });

  it("reports a thrown error as an eval failure and still restores the page", async () => {
    const driver = loadDriver({ userScripts: "available", injected: { error: "boom" } });
    try {
      await assert.rejects(driver.exports.evaluate(1, { expression: "x()" }), /eval failed: boom/);
      assert.equal(driver.runs.length, 2, "prep then restore");
    } finally {
      driver.dispose();
    }
  });

  it("returns STALE_REF without running the caller's code when a ref is gone", async () => {
    const driver = loadDriver({
      userScripts: "available",
      prep: { ok: false, code: "REF_NOT_FOUND", error: 'Element ref "e1" not found.' },
    });
    try {
      await assert.rejects(
        driver.exports.evaluate(1, { function: "(el) => el", args: ["e1"] }),
        /^Error: STALE_REF: /,
      );
      assert.equal(driver.executions.length, 0, "the caller's code must not run");
    } finally {
      driver.dispose();
    }
  });

  it("ships no eval( in the driver — the store policy this change exists for", () => {
    const src = readFileSync(resolve(ROOT, DRIVER), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const hits = src.split("\n").filter((l) => /(^|[^.\w$])eval\s*\(/.test(l));
    assert.deepEqual(hits, [], "driver.ts must not call eval");
  });
});
