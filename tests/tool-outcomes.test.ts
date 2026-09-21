import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { Context } from "@/context";
import type { Tool, ToolResult } from "@/tools/tool";

import { callTool } from "@/tools/call";
import {
  LOST_RESPONSE,
  TRANSIENT_FAILURES,
  ToolError,
  asToolError,
  errorResult,
  isRetryable,
  renderError,
} from "@/tools/errors";
import { fillForm } from "@/tools/forms";
import { getCookies } from "@/tools/state";

/**
 * The audit trail is asserted through the REAL writer, pointed at a scratch
 * file. Stubbing the module would prove the test's own stub records an outcome;
 * this proves the line a user reads after something looks wrong carries it, and
 * that it survives being serialised and parsed back.
 */
const scratch = mkdtempSync(join(tmpdir(), "ab-outcomes-"));
let nth = 0;
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A Context stub with no policy in play — outcomes are the only thing under test. */
function stubContext(over: Partial<Record<string, unknown>> = {}): Context {
  return {
    auditTarget: () => ({ browser: "chrome", tabId: 7 }),
    clientName: () => "test",
    ctrlId: () => "ctrl",
    hasClients: () => true,
    takeNotice: () => undefined,
    consoleErrorDelta: async () => 0,
    issuesDelta: async () => 0,
    takeNewConsole: async () => [],
    sendSocketMessage: async () => ({}),
    ...over,
  } as unknown as Context;
}

type Stub = Tool & { ran: number };

/** A tool whose handler is counted, so "was it replayed?" is answerable. */
function stub(
  name: string,
  annotations: Record<string, boolean>,
  handle: (ran: number) => ToolResult | Promise<ToolResult>,
): Stub {
  const t = {
    ran: 0,
    schema: { name, description: "", inputSchema: {}, annotations },
    handle: async () => {
      t.ran += 1;
      return handle(t.ran);
    },
  } as unknown as Stub;
  return t;
}

/** A click: changes the page, declares itself non-idempotent. Never replayable. */
const clickThat = (handle: (ran: number) => ToolResult | Promise<ToolResult>): Stub =>
  stub("browser_click", { readOnlyHint: false, idempotentHint: false }, handle);

/** A read: safe to re-issue, which is what makes its lost reply a plain failure. */
const readThat = (handle: (ran: number) => ToolResult | Promise<ToolResult>): Stub =>
  stub("browser_read_page", { readOnlyHint: true, idempotentHint: true }, handle);

const textOf = (r: ToolResult): string =>
  r.content.map((p) => ("text" in p ? p.text : "")).join("\n");

const throwing = (message: string) => () => {
  throw new Error(message);
};

/** One audit line, as it was written to disk. */
type AuditLine = { ok: boolean; outcome?: string; tool: string; error?: string };

/**
 * Run a call against a fresh audit file and hand back both halves of what it
 * reported: the result (or the error the caller sees) and the line the trail got.
 */
async function outcomeOf(
  context: Context,
  tool: Tool,
  args?: Record<string, unknown>,
): Promise<{ result?: ToolResult; error?: unknown; entry: AuditLine }> {
  const file = join(scratch, `audit-${nth++}.log`);
  process.env.AUTOMATE_BROWSER_AUDIT = "on";
  process.env.AUTOMATE_BROWSER_AUDIT_FILE = file;
  let result: ToolResult | undefined;
  let error: unknown;
  try {
    result = await callTool(context, tool, args);
  } catch (e) {
    error = e;
  }
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1, "exactly one call, so exactly one audit line");
  return { result, error, entry: JSON.parse(lines[0]) as AuditLine };
}

describe("I04 — a refusal never reaches the browser, and says so", () => {
  it("records a policy-shaped refusal as refused, with the handler untouched", async () => {
    const click = clickThat(() => ({ content: [{ type: "text", text: "Clicked" }] }));
    // `include` is validated before dispatch (B04), so it is the refusal this
    // suite can raise without standing a policy up.
    const { error, entry } = await outcomeOf(stubContext(), click, { include: "consoel" });

    assert.ok(error, "the call must fail");
    assert.equal(click.ran, 0, "and the click must not have happened");
    assert.equal(entry.outcome, "refused");
    assert.equal(entry.ok, false);
  });

  it("keeps a handler-raised argument refusal a refusal, not a failure", async () => {
    const click = clickThat(() => {
      throw new ToolError("BAD_ARGS", "frames: 4 needs a filePath");
    });

    const { entry } = await outcomeOf(stubContext(), click);
    assert.equal(entry.outcome, "refused", "BAD_ARGS is raised before anything is sent");
  });
});

describe("I04 — a partial fill is neither a success nor a failure", () => {
  const fillResult = (
    filled: number,
    total: number,
    errors: Array<{ ref: string; error: string }>,
  ) => stubContext({ sendSocketMessage: async () => ({ filled, total, errors }) });

  it("reports some-of-many as partial, keeping every per-field verdict", async () => {
    const { result, entry } = await outcomeOf(
      fillResult(2, 3, [{ ref: "e5", error: "no <option> matched" }]),
      fillForm,
      { fields: [{ ref: "e1", value: "a" }] },
    );

    assert.equal(result?.outcome, "partial");
    assert.notEqual(result?.isError, true, "two fields DID get filled");
    assert.equal(entry.outcome, "partial");
    assert.equal(entry.ok, true);
    assert.match(textOf(result!), /Filled 2\/3/);
    assert.match(textOf(result!), /e5: no <option> matched/, "the field and its reason survive");
    assert.deepEqual(
      result?.structuredContent,
      { filled: 2, total: 3, errors: [{ ref: "e5", error: "no <option> matched" }] },
      "and survive structured, for an agent that does not parse prose",
    );
  });

  it("reports all-of-none as a failure, not a partial", async () => {
    const { result, entry } = await outcomeOf(
      fillResult(0, 2, [
        { ref: "e5", error: "no <option> matched" },
        { ref: "e0", error: "not found" },
      ]),
      fillForm,
      { fields: [{ ref: "e1", value: "a" }] },
    );

    assert.equal(result?.outcome, "failed");
    assert.equal(result?.isError, true);
    assert.equal(entry.outcome, "failed");
    assert.equal(entry.ok, false, "a returned failure is not an `ok` line in the trail");
  });

  it("reports every-field-filled as a plain success", async () => {
    const { result, entry } = await outcomeOf(fillResult(3, 3, []), fillForm, {
      fields: [{ ref: "e1", value: "a" }],
    });

    assert.equal(result?.outcome, "success");
    assert.equal(entry.outcome, "success");
    assert.equal(entry.ok, true);
  });
});

describe("I04 — a lost reply is not a failure, and not a licence to retry", () => {
  for (const message of LOST_RESPONSE) {
    it(`says a click MAY have landed when the link dropped ("${message.slice(0, 24)}…")`, async () => {
      const click = clickThat(throwing(message));
      const { error, entry } = await outcomeOf(stubContext(), click);

      assert.equal(click.ran, 1, "the uncertain action must NOT be replayed");
      assert.equal(entry.outcome, "unknown");
      assert.match(
        String((error as Error).message),
        /MAY have taken effect/,
        "the one thing the agent has to be told",
      );
      assert.equal(isRetryable(error), false, "and it must not be advertised as safe to repeat");
      assert.match(renderError(error), /Recover: call browser_snapshot\./);
    });
  }

  it("leaves a read's lost reply exactly as it was — retried once, then reported", async () => {
    const read = readThat(throwing("relay connection closed"));
    const { error, entry } = await outcomeOf(stubContext(), read);

    assert.equal(read.ran, 2, "an idempotent read still gets its one automatic retry");
    assert.equal(entry.outcome, "failed", "nothing uncertain about a read that changed nothing");
    assert.doesNotMatch(String((error as Error).message), /MAY have taken effect/);
  });

  it("does not claim uncertainty for a failure that never got started", async () => {
    // "receiving end does not exist" is transient too, but it means the content
    // script was not there to run it — nothing happened, and saying otherwise
    // would send the agent checking the page for a change that cannot exist.
    const click = clickThat(
      throwing("Could not establish connection. Receiving end does not exist."),
    );
    const { error, entry } = await outcomeOf(stubContext(), click);

    assert.equal(entry.outcome, "failed");
    assert.doesNotMatch(String((error as Error).message), /MAY have taken effect/);
  });

  it("keeps the uncertain set a subset of the transient one", () => {
    for (const m of LOST_RESPONSE) {
      assert.ok(
        (TRANSIENT_FAILURES as readonly string[]).includes(m),
        `${m} must stay in TRANSIENT_FAILURES, or the retry rule and the certainty rule disagree`,
      );
    }
  });
});

describe("I04 — an optional attachment is a footnote, never a demotion", () => {
  it("stays a success when the console read fails after the click", async () => {
    const click = clickThat(() => ({ content: [{ type: "text", text: "Clicked" }] }));
    const context = stubContext({
      takeNewConsole: async () => {
        throw new Error("console read timed out");
      },
    });

    const { result, entry } = await outcomeOf(context, click, { include: "console" });

    assert.equal(entry.outcome, "success");
    assert.equal(entry.ok, true);
    assert.notEqual(result?.isError, true);
    assert.match(textOf(result!), /--- console --- \(unavailable/);
  });

  it("stays a success when the page logged errors of its own", async () => {
    const click = clickThat(() => ({ content: [{ type: "text", text: "Clicked" }] }));
    const context = stubContext({ consoleErrorDelta: async () => 2 });

    const { result, entry } = await outcomeOf(context, click);

    assert.equal(entry.outcome, "success", "the PAGE threw; the click still landed");
    assert.match(textOf(result!), /2 new console errors since this action/);
  });
});

describe("I04 — MCP and the CLI report the same failure", () => {
  it("gives a tool with no output schema the machine-readable head", async () => {
    // Spelt the way a failure raised INSIDE the extension actually arrives: a
    // plain Error whose message carries the code, adopted on the way through.
    const out = errorResult(fillForm, new Error("STALE_REF: ref e9 is gone"));

    assert.equal(out.isError, true);
    assert.deepEqual(out.structuredContent, {
      code: "STALE_REF",
      message: "ref e9 is gone",
      retryable: false,
      recover: "browser_snapshot",
    });
    assert.match(textOf(out), /^STALE_REF: ref e9 is gone/);
  });

  it("withholds it from a tool that declares one, rather than failing validation", async () => {
    assert.ok(getCookies.schema.outputSchema, "this test is only meaningful for such a tool");
    const out = errorResult(getCookies, new Error("TAB_GONE: the tab has closed"));

    assert.equal(out.structuredContent, undefined);
    assert.equal(out.isError, true);
    assert.match(
      textOf(out),
      /TAB_GONE: the tab has closed[\s\S]*Recover: call browser_list_tabs\./,
      "the code and the next step still reach the agent, through the text",
    );
  });

  it("leaves an uncoded failure without a code, so neither side invents one", () => {
    // The CLI prints the bare message for these (a terminal does not want
    // `toString`'s "Error: " in front of its help text); the MCP path renders
    // the same prose. Neither pretends there is a code to recover from.
    const bare = new Error('Unknown command "nope".');
    assert.equal(asToolError(bare), undefined);
    assert.match(renderError(bare), /Unknown command "nope"\./);
  });
});
