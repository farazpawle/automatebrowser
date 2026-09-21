/**
 * A Context double for driving the B9/B02 safety gate through `callTool`.
 *
 * Shared by the MCP-shaped regression and the CLI one because they must exercise
 * the SAME gate — two harnesses would let one path quietly diverge from the
 * other, which is precisely the property those suites exist to hold.
 *
 * It answers exactly two things: where the browser is (the origin probe) and
 * which browser/tab a call is aimed at. Everything else is the minimum that keeps
 * `callTool`'s own bookkeeping — the audit line and the console/issues footer —
 * from touching the wire and polluting `sent`.
 */
import type { Context } from "@/context";
import type { Tool, ToolResult } from "@/tools/tool";

import { callTool } from "@/tools/call";
import { asToolError } from "@/tools/errors";
import { selectTools } from "@/tools/registry";
import { ALLOW_ENV, resetPolicyCache } from "@/utils/origins";

export type Target = { browser?: string; tabId?: number };

export interface Fake {
  context: Context;
  /** Every message type the gate or a tool put on the wire, in order. */
  sent: string[];
  /** The browser/tab a call is currently aimed at. */
  target: Target;
  /**
   * The relay id of the browser a call routes to. Separate from `target.browser`,
   * which is the human label the audit line prints: B05 keys the network-policy
   * acknowledgement on the id, because a reconnect brings the same browser back
   * under a new one.
   */
  browserId: string;
}

/**
 * A Context that answers the origin probe with `pageUrl`.
 *
 * `movesTo` models the one race the gate has to survive: once it has taken its
 * reading of the drive target, another call on this controller selects a
 * different browser, so the action would land somewhere the verdict never
 * covered. Applied on the read AFTER the gate's own, which is the only window
 * that exists between the check and the dispatch.
 */
export function fakeContext(pageUrl: string, movesTo?: Target): Fake {
  const f: Fake = {
    sent: [],
    target: { browser: 'chrome "A" [aaaaaaaa]', tabId: 7 },
    browserId: "aaaaaaaa-0000-4000-8000-000000000001",
    context: undefined as unknown as Context,
  };
  let readsAfterProbe = 0;
  f.context = {
    auditTarget: () => {
      const seen = f.target;
      if (movesTo && f.sent.includes("getUrl") && ++readsAfterProbe === 1) f.target = movesTo;
      return seen;
    },
    activeBrowserId: () => f.browserId,
    listClients: () => [{ id: f.browserId }],
    clientName: () => "test",
    ctrlId: () => "test",
    hasClients: () => true,
    takeNotice: () => undefined,
    // The C3a console/issues footer runs on every SUCCESSFUL call. Silent here:
    // a probe of its own would drown the assertions about what the gate sent.
    consoleErrorDelta: async () => 0,
    issuesDelta: async () => 0,
    takeNewConsole: async () => [],
    sendSocketMessage: async (type: string) => {
      f.sent.push(type);
      if (type === "getUrl") return pageUrl;
      return {};
    },
  } as unknown as Context;
  return f;
}

/**
 * A stub carrying a REAL tool's name and annotations. The gate keys on both, so
 * this exercises the policy decision for that tool without running its handler —
 * and `ran` makes "was it refused?" an observation rather than an inference.
 */
export function stubTool(name: string, readOnly = false): Tool & { ran: boolean } {
  const real = selectTools().tools.find((t) => t.schema.name === name);
  const t = {
    ran: false,
    schema: {
      name,
      description: "",
      inputSchema: {},
      annotations: real?.schema.annotations ?? { readOnlyHint: readOnly },
    },
    handle: async (): Promise<ToolResult> => {
      t.ran = true;
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as unknown as Tool & { ran: boolean };
  return t;
}

export interface Attempt {
  refused: boolean;
  code?: string;
  message: string;
}

/** Run a call and report how it ended, without every test writing try/catch. */
export async function attempt(
  f: Fake,
  tool: Tool & { ran: boolean },
  args?: Record<string, unknown>,
): Promise<Attempt> {
  try {
    await callTool(f.context, tool, args);
    return { refused: false, message: "" };
  } catch (e) {
    return {
      refused: true,
      code: asToolError(e)?.code,
      message: String((e as Error)?.message ?? e),
    };
  }
}

/** Configure an allow-list-only policy for one test. */
export function allowOnly(origin: string): void {
  process.env[ALLOW_ENV] = origin;
  resetPolicyCache();
}

/** Undo it. Call from `afterEach`, or the next file inherits the policy. */
export function clearPolicy(): void {
  delete process.env[ALLOW_ENV];
  resetPolicyCache();
}
