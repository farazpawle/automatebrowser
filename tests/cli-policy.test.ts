/**
 * B02 at the terminal: `automate-browser` must be protected by the same gate as
 * the MCP server, and by the SAME code — not by a second copy that can drift.
 *
 * The CLI hands `--args '{…}'` to the tool almost verbatim, so it is the most
 * direct way to attach an address a call is not really going to:
 *
 *   automate-browser click --args '{"element":"b","ref":"e1","url":"https://app.test"}'
 *
 * Two halves, because either alone would pass while the protection was absent:
 *
 *   - BEHAVIOUR: the argument object a terminal user can construct is refused by
 *     the gate, with nothing reaching the page.
 *   - STRUCTURE: `src/cli.ts` reaches tools only through `callTool`, the choke
 *     point the gate lives in. A future CLI path that called a handler directly
 *     would sail past every behavioural assertion in this file, so the shape of
 *     that file is asserted too.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import { allowOnly, attempt, clearPolicy, fakeContext, stubTool } from "./helpers/policy-harness";

const ALLOWED = "https://app.test";
const DENIED_PAGE = "https://bank.example.com/accounts";

const cliSource = readFileSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf8");

/**
 * What `--args '<json>'` becomes, the way `buildArgs` in `src/cli.ts` builds it:
 * the parsed object, with an alias's positional value written over the top.
 *
 * Mirrored rather than imported because `src/cli.ts` parses `process.argv` at
 * import time — importing it would run the CLI. The structural assertions below
 * are what keep this mirror honest.
 */
function cliArgs(json: string, positional?: [string, string]): Record<string, unknown> {
  const args = JSON.parse(json) as Record<string, unknown>;
  if (positional) args[positional[0]] = positional[1];
  return args;
}

afterEach(clearPolicy);

describe("B02 at the terminal — --args cannot smuggle in an origin", () => {
  it("refuses a click whose --args names an allowed url on a denied page", async () => {
    allowOnly(ALLOWED);
    const f = fakeContext(DENIED_PAGE);
    const click = stubTool("browser_click");

    const r = await attempt(
      f,
      click,
      cliArgs(`{"element":"the button","ref":"e1","url":"${ALLOWED}/harmless"}`),
    );

    assert.equal(r.refused, true, "the CLI must not be the soft way in");
    assert.equal(r.code, "ORIGIN_BLOCKED");
    assert.match(r.message, /bank\.example\.com/);
    assert.equal(click.ran, false, "nothing may reach the page");
  });

  it("runs the same command on an allowed page — the negative control", async () => {
    allowOnly(ALLOWED);
    const f = fakeContext(`${ALLOWED}/dashboard`);
    const click = stubTool("browser_click");

    const r = await attempt(f, click, cliArgs('{"element":"the button","ref":"e1"}'));

    assert.equal(r.refused, false, r.message);
    assert.equal(click.ran, true);
  });

  it("still judges `automate-browser navigate <url>` on that url", async () => {
    // The navigate alias writes its positional into `url`, which IS the
    // destination — the one case where an argument legitimately speaks for the
    // origin. It must keep working, from a denied page, or the fix has just
    // broken the most common terminal command there is.
    allowOnly(ALLOWED);
    const f = fakeContext(DENIED_PAGE);
    const nav = stubTool("browser_navigate");

    const r = await attempt(f, nav, cliArgs("{}", ["url", `${ALLOWED}/login`]));

    assert.equal(r.refused, false, r.message);
    assert.equal(nav.ran, true);
    assert.deepEqual(f.sent, [], "a declared destination is judged without a round-trip");
  });

  it("refuses that same alias pointed at a non-allowed origin", async () => {
    allowOnly(ALLOWED);
    const f = fakeContext(`${ALLOWED}/dashboard`);
    const nav = stubTool("browser_navigate");

    const r = await attempt(f, nav, cliArgs("{}", ["url", "https://evil.example.com/"]));

    assert.equal(r.refused, true);
    assert.equal(nav.ran, false);
  });
});

describe("B02 at the terminal — the CLI has no second path to a tool", () => {
  it("invokes tools only through callTool", () => {
    assert.equal(
      (cliSource.match(/\bcallTool\(/g) ?? []).length,
      1,
      "one invocation, at one choke point",
    );
    assert.equal(
      (cliSource.match(/\.handle\(/g) ?? []).length,
      0,
      "calling a handler directly would skip the safety gate entirely",
    );
  });

  it("keeps no policy logic of its own", () => {
    // A second copy of the decision is a second copy that can be wrong. The CLI
    // must inherit the verdict, never compute one.
    for (const forbidden of ["judge(", "originOf(", "evalRefusal(", "@/utils/origins"]) {
      assert.equal(
        cliSource.includes(forbidden),
        false,
        `src/cli.ts should not reference ${forbidden}`,
      );
    }
  });

  it("passes --args through as a plain object, so the gate sees what the tool sees", () => {
    // If the CLI ever rewrote or filtered arguments between parsing and dispatch,
    // the gate and the handler could be looking at different requests.
    assert.match(cliSource, /const args = buildArgs\(/);
    assert.match(cliSource, /await callTool\(context, tool, args\)/);
  });
});
