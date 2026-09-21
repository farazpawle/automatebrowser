/**
 * D16's no-JavaScript switch — the middle setting between full trust and
 * read-only: drive and read a real logged-in session, but never run code the
 * operator did not write.
 *
 * Two halves, deliberately, for the same reason `redaction.test.ts` has two: the
 * RULE can be perfect while the call path never consults it. So `evalRefusal` is
 * tested as the pure function it is, and then `callTool` is driven end to end
 * with a stub tool — because deleting the four lines in `call.ts` would leave
 * every rule assertion below green and the switch doing nothing at all.
 *
 * The registry sweep is the third half: it fails when a NEW tool arrives whose
 * name says it runs source and nobody added it to `EVAL_PATHS`. A switch with a
 * hole in it is worse than no switch.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { callTool } from "@/tools/call";
import { asToolError } from "@/tools/errors";
import { selectTools } from "@/tools/registry";
import type { Context } from "@/context";
import type { Tool, ToolResult } from "@/tools/tool";
import {
  NO_EVAL_ENV,
  evalRefusal,
  describePolicy,
  policy,
  resetPolicyCache,
} from "@/utils/origins";

/** Enough of a Context for the gate, which refuses before touching the browser. */
const context = {
  auditTarget: () => ({}),
  clientName: () => "test",
  ctrlId: () => "test",
  hasClients: () => false,
  takeNotice: () => undefined,
} as unknown as Context;

/** A tool that records whether it ran, so "was it refused?" is not inferred. */
function stub(name: string): Tool & { ran: boolean } {
  const t = {
    ran: false,
    schema: {
      name,
      description: "",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handle: async (): Promise<ToolResult> => {
      t.ran = true;
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as unknown as Tool & { ran: boolean };
  return t;
}

afterEach(() => {
  delete process.env[NO_EVAL_ENV];
  resetPolicyCache();
});

describe("evalRefusal — which calls run JavaScript the agent wrote", () => {
  it("refuses browser_eval whatever it was asked to evaluate", () => {
    // Including a pure READ. This is why the code is not READ_ONLY: a read-only
    // expression is still the agent's own source running in a logged-in tab.
    for (const args of [
      { expression: "document.title" },
      { function: "(el) => el.innerText", args: ["e3"] },
      {},
      undefined,
    ]) {
      const why = evalRefusal("browser_eval", args);
      assert.ok(why, JSON.stringify(args));
      assert.match(why, /AUTOMATE_BROWSER_NO_EVAL/);
    }
  });

  it("names the variable AND who set it, so the agent does not report a bug", () => {
    const why = evalRefusal("browser_eval") ?? "";
    assert.match(why, /this server's environment/);
    assert.match(why, /whoever configured it/);
  });

  it("refuses browser_navigate ONLY when it carries an initScript", () => {
    assert.ok(evalRefusal("browser_navigate", { url: "https://x.test", initScript: "x=1" }));
    assert.equal(evalRefusal("browser_navigate", { url: "https://x.test" }), undefined);
    assert.equal(
      evalRefusal("browser_navigate", { url: "https://x.test", initScript: "" }),
      undefined,
    );
    assert.equal(evalRefusal("browser_navigate", { initScript: "   " }), undefined, "whitespace");
  });

  it("says how to make the refused navigation succeed", () => {
    const why = evalRefusal("browser_navigate", { initScript: "x=1" }) ?? "";
    assert.match(why, /Drop `initScript`/);
  });

  it("lets every other registered tool through", () => {
    const others = selectTools()
      .tools.map((t) => t.schema.name)
      .filter((n) => n !== "browser_eval" && n !== "browser_navigate");
    assert.ok(others.length > 20, "the registry should be non-trivial");
    for (const name of others) {
      // Args from every eval-shaped param name at once: a tool that happens to
      // take an `initScript` must be listed in EVAL_PATHS, not caught by luck.
      assert.equal(
        evalRefusal(name, { expression: "x", function: "y", initScript: "z" }),
        undefined,
        name,
      );
    }
  });

  it("has no tool named like an eval path that was left off the list", () => {
    const suspicious = selectTools()
      .tools.map((t) => t.schema.name)
      .filter((n) => /eval|script|execute|inject/i.test(n))
      .filter((n) => evalRefusal(n) === undefined);
    assert.deepEqual(suspicious, [], "a new source-running tool needs an EVAL_PATHS entry");
  });
});

describe("policy — the switch on its own is a configured policy", () => {
  it("is off with the variable unset", () => {
    resetPolicyCache();
    assert.equal(policy(), undefined);
  });

  it("configures a policy even when no origin list is set", () => {
    process.env[NO_EVAL_ENV] = "1";
    resetPolicyCache();
    assert.equal(policy()?.noEval, true);
  });

  it("reports itself in browser_status, or nobody can find out why they were refused", () => {
    process.env[NO_EVAL_ENV] = "1";
    resetPolicyCache();
    assert.match(describePolicy() ?? "", /no-eval/);
  });

  it("takes the same truthy spellings as the other switches, and nothing else", () => {
    for (const on of ["1", "on", "true", "yes", "TRUE"]) {
      process.env[NO_EVAL_ENV] = on;
      resetPolicyCache();
      assert.equal(policy()?.noEval, true, on);
    }
    for (const off of ["0", "off", "false", "no", "maybe", ""]) {
      process.env[NO_EVAL_ENV] = off;
      resetPolicyCache();
      assert.equal(policy()?.noEval ?? false, false, off);
    }
  });
});

describe("callTool — the gate is actually wired to the call path", () => {
  // The audit trail is a real file append; a unit test must not write to it.
  process.env.AUTOMATE_BROWSER_AUDIT = "off";

  it("refuses browser_eval with a typed EVAL_BLOCKED and never runs it", async () => {
    process.env[NO_EVAL_ENV] = "1";
    resetPolicyCache();
    const tool = stub("browser_eval");
    const e = await callTool(context, tool, { expression: "document.title" }).then(
      () => undefined,
      (err) => err,
    );
    assert.ok(e, "the call should have thrown");
    assert.equal(tool.ran, false, "the handler must not have run");
    const te = asToolError(e);
    assert.equal(te?.code, "EVAL_BLOCKED");
    assert.equal(te?.retryable, false, "re-issuing it cannot help");
    assert.equal(te?.recover, "browser_status");
    assert.match(te?.message ?? "", /^browser_eval refused —/);
  });

  it("still runs a non-eval tool with the switch on", async () => {
    process.env[NO_EVAL_ENV] = "1";
    resetPolicyCache();
    const tool = stub("browser_click");
    const r = await callTool(context, tool, { ref: "e1" });
    assert.equal(tool.ran, true);
    assert.deepEqual(r.content, [{ type: "text", text: "ok" }]);
  });

  it("still runs a navigation, and refuses only its initScript", async () => {
    process.env[NO_EVAL_ENV] = "1";
    resetPolicyCache();
    const plain = stub("browser_navigate");
    await callTool(context, plain, { url: "https://x.test" });
    assert.equal(plain.ran, true);

    const withScript = stub("browser_navigate");
    const e = await callTool(context, withScript, {
      url: "https://x.test",
      initScript: "Date.now = () => 0",
    }).then(
      () => undefined,
      (err) => err,
    );
    assert.equal(withScript.ran, false);
    assert.equal(asToolError(e)?.code, "EVAL_BLOCKED");
  });

  it("runs browser_eval when the switch is off — the default stays frictionless", async () => {
    resetPolicyCache();
    const tool = stub("browser_eval");
    await callTool(context, tool, { expression: "document.title" });
    assert.equal(tool.ran, true);
  });
});
