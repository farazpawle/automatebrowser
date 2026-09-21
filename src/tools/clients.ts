import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { Context, ClientInfo } from "@/context";
import { WHOLE_TAB } from "@/relay/types";
import type { TabClaim } from "@/relay/types";

import type { Tool } from "./tool";

const SelectArgs = z
  .object({
    id: z
      .string()
      .optional()
      .describe("Client id (full or 8-char prefix) from browser_list_clients."),
    browser: z.string().optional().describe('Browser family, e.g. "chrome", "edge", "brave".'),
    label: z.string().optional().describe("User-set label from the extension popup."),
    force: z
      .boolean()
      .optional()
      .describe(
        "Take over even if another agent is currently driving this browser (notifies them).",
      ),
  })
  .refine((v) => v.id || v.browser || v.label, "Provide one of: id, browser, label");
const ListClientsOutput = z.object({
  clients: z.array(z.record(z.unknown())),
  controllers: z.array(z.record(z.unknown())),
  notice: z.string().optional(),
});

/** Summarise who drives each tab of a browser (a WHOLE lease prints as the whole browser). */
function renderDrivers(claims: TabClaim[] | undefined, selfCtrlId?: string): string {
  if (!claims || claims.length === 0) return "";
  const who = (cl: TabClaim) => (cl.controllerId === selfCtrlId ? "you" : `"${cl.controllerName}"`);
  const whole = claims.find((cl) => cl.tabId === WHOLE_TAB);
  if (whole) return `  (driven by ${who(whole)})`;
  const parts = claims
    .slice()
    .sort((a, b) => a.tabId - b.tabId)
    .map((cl) => `tab ${cl.tabId} by ${who(cl)}`);
  return `  (${parts.join(", ")})`;
}

/** Render one browser line, including who is driving each tab (if anyone). */
export function renderClient(c: ClientInfo, selfCtrlId?: string): string {
  const label = c.label ? ` "${c.label}"` : "";
  const tab = c.tabUrl ? ` — ${c.tabTitle ?? ""} ${c.tabUrl}` : "";
  const driver = renderDrivers(c.claims, selfCtrlId);
  return `${c.active ? "* " : "  "}[id=${c.id.slice(0, 8)}] ${c.browser}${label}${tab}${driver}`;
}

/** Footer listing the OTHER agents (controllers) connected to the relay. */
function peerFooter(context: Context): string {
  const others = context.peers().filter((p) => !p.self);
  if (others.length === 0) return "";
  return `\n\nOther agents connected: ${others.map((p) => p.name).join(", ")}`;
}

export const listClients: Tool = {
  schema: {
    name: "browser_list_clients",
    description:
      "List every browser connected to the shared AutomateBrowser relay (e.g. Chrome and Edge " +
      "when both have the extension connected), across all IDEs. Returns id, browser, label, " +
      "the active marker (*), the current tab, and who is currently driving each browser " +
      '((driven by you) / (driven by "<agent>")). Use this first when more than one browser ' +
      "may be connected, then browser_select_client to choose which one your tools act on.",
    inputSchema: zodToJsonSchema(z.object({}).strict()),
    outputSchema: zodToJsonSchema(ListClientsOutput),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context) => {
    const clients = context.listClients();
    const notice = context.takeNotice();
    if (clients.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "No browsers connected to the relay. Open a browser with the AutomateBrowser " +
              "extension on a normal http(s) tab; it connects automatically. Run browser_status " +
              "for relay diagnostics.",
          },
        ],
        structuredContent: {
          clients,
          controllers: context.peers(),
          ...(notice ? { notice } : {}),
        },
      };
    }
    const self = context.ctrlId();
    const body = clients.map((c) => renderClient(c, self)).join("\n");
    const text = (notice ? `${notice}\n\n` : "") + body + peerFooter(context);
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        clients,
        controllers: context.peers(),
        ...(notice ? { notice } : {}),
      },
    };
  },
};

export const selectClient: Tool = {
  schema: {
    name: "browser_select_client",
    description:
      "Choose which connected browser your subsequent tools act on. Select by `browser` " +
      '(e.g. "edge"), `label`, or `id` from browser_list_clients. Required when two or ' +
      "more browsers are connected; the choice persists until that browser disconnects. " +
      "Selecting does NOT claim the browser — the soft claim happens on your first action. " +
      "Pass force:true to take over a browser another agent is already driving.",
    inputSchema: zodToJsonSchema(SelectArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = SelectArgs.parse(params);
    const info = args.force ? await context.forceClaim(args) : context.setActive(args);
    const took = args.force ? "Took over" : "Active browser:";
    return {
      content: [
        {
          type: "text",
          text: `${took} ${info.browser}${info.label ? ` "${info.label}"` : ""} [id=${info.id.slice(0, 8)}]`,
        },
      ],
    };
  },
};

export const forceClaim: Tool = {
  schema: {
    name: "browser_force_claim",
    description:
      "Forcibly take over a browser that another agent is currently driving, and make it " +
      "active for your tools. The previous agent is notified the next time it acts. Use this " +
      "when browser_select_client / an action reported the browser is being driven by someone " +
      "else and you need it anyway. Select by id, browser, or label.",
    inputSchema: zodToJsonSchema(SelectArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = SelectArgs.parse(params);
    const info = await context.forceClaim(args);
    return {
      content: [
        {
          type: "text",
          text: `Took over ${info.browser}${info.label ? ` "${info.label}"` : ""} [id=${info.id.slice(0, 8)}].`,
        },
      ],
    };
  },
};

export const releaseClient: Tool = {
  schema: {
    name: "browser_release_client",
    description:
      "Release your claim on the browser you are currently driving so another agent can take " +
      "it. Optional — claims also expire when you go idle and free automatically when your IDE " +
      "disconnects. Call this when you are done with a browser others may want.",
    inputSchema: zodToJsonSchema(z.object({}).strict()),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  skipConsoleDelta: true,
  handle: async (context) => {
    const released = await context.release();
    return {
      content: [
        {
          type: "text",
          text: released
            ? `Released ${released.browser}${released.label ? ` "${released.label}"` : ""} [id=${released.id.slice(0, 8)}].`
            : "No active claim to release.",
        },
      ],
    };
  },
};
