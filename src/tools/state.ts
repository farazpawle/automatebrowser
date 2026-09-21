import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { Tool } from "./tool";

/**
 * Browser-state tools: cookies (chrome.cookies) and web storage
 * (localStorage/sessionStorage). Powerful — they expose the session/auth surface
 * of the driven tab's origin. Scoped to the driven tab's URL.
 */

export const GetCookiesArgs = z.object({
  name: z.string().optional().describe("Only return the cookie with this name."),
  revealValues: z
    .boolean()
    .optional()
    .describe("Return raw cookie values. Defaults to false to avoid exposing session secrets."),
});
const GetCookiesOutput = z.object({
  cookies: z.array(z.record(z.unknown())),
  redacted: z.boolean(),
});

export const getCookies: Tool = {
  schema: {
    name: "browser_get_cookies",
    description:
      "List cookies for the URL of the tab you are driving (optionally filter by `name`). Values are redacted " +
      "unless revealValues:true is passed. Only works on http(s) pages.",
    inputSchema: zodToJsonSchema(GetCookiesArgs),
    outputSchema: zodToJsonSchema(GetCookiesOutput),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = GetCookiesArgs.parse(params ?? {});
    const cookies = (await context.sendSocketMessage("browser_get_cookies", args)) as Array<
      Record<string, unknown>
    >;
    const reveal = args.revealValues === true;
    const safeCookies: Array<Record<string, unknown>> = cookies.map((c) => ({
      ...c,
      value: reveal ? c.value : "<redacted>",
      valueRedacted: !reveal,
    }));
    const text =
      safeCookies.length === 0
        ? "(no cookies)"
        : safeCookies
            .map(
              (c) =>
                `${String(c.name ?? "")}=${String(c.value ?? "")}  [${String(c.domain ?? "")}${String(c.path ?? "")}]${c.secure ? " secure" : ""}${c.httpOnly ? " httpOnly" : ""}${c.session ? " session" : ""}`,
            )
            .join("\n");
    return {
      content: [{ type: "text", text }],
      structuredContent: { cookies: safeCookies, redacted: !reveal },
    };
  },
};

export const SetCookieArgs = z.object({
  name: z.string().describe("Cookie name."),
  value: z.string().describe("Cookie value."),
  path: z.string().optional().describe("Cookie path (default '/')."),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  expirationDate: z
    .number()
    .optional()
    .describe("Unix time (seconds) when the cookie expires. Omit for a session cookie."),
  sameSite: z.enum(["no_restriction", "lax", "strict"]).optional(),
});

export const setCookie: Tool = {
  schema: {
    name: "browser_set_cookie",
    description:
      "Set (create/overwrite) a cookie on the URL of the tab you are driving. Useful for seeding auth/session state. " +
      "Only works on http(s) pages.",
    inputSchema: zodToJsonSchema(SetCookieArgs),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = SetCookieArgs.parse(params ?? {});
    const c = (await context.sendSocketMessage("browser_set_cookie", args)) as Record<
      string,
      unknown
    >;
    return { content: [{ type: "text", text: `Set cookie ${c.name} on ${c.domain}${c.path}` }] };
  },
};

export const StorageArgs = z.object({
  area: z
    .enum(["local", "session"])
    .optional()
    .describe("localStorage (default) or sessionStorage."),
  action: z.enum(["get", "set", "remove", "clear"]).describe("Operation to perform."),
  key: z
    .string()
    .optional()
    .describe("Key (required for set/remove; optional for get → all keys)."),
  value: z.string().optional().describe("Value (for set)."),
  revealValues: z
    .boolean()
    .optional()
    .describe("For action=get, return raw stored values. Defaults to false."),
});
const StorageOutput = z.object({
  result: z.unknown(),
  redacted: z.boolean(),
});

export const storage: Tool = {
  schema: {
    name: "browser_storage",
    description:
      "Read or write the page's localStorage/sessionStorage. action=get redacts values unless revealValues:true is passed.",
    inputSchema: zodToJsonSchema(StorageArgs),
    outputSchema: zodToJsonSchema(StorageOutput),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = StorageArgs.parse(params ?? {});
    const result = await context.sendSocketMessage("browser_storage", args);
    const shouldRedact = args.action === "get" && args.revealValues !== true;
    const safeResult = shouldRedact ? redactStorage(result) : result;
    const text = typeof safeResult === "string" ? safeResult : JSON.stringify(safeResult, null, 2);
    return {
      content: [{ type: "text", text }],
      structuredContent: { result: safeResult, redacted: shouldRedact },
    };
  },
};

function redactStorage(value: unknown): unknown {
  if (typeof value === "string") return "<redacted>";
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(() => "<redacted>");
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>).map((key) => [key, "<redacted>"]),
  );
}
