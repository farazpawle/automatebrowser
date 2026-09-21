import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { Tool } from "./tool";

/**
 * Token-efficient page-reading tools — cheaper alternatives to a full
 * `browser_snapshot` for read-only or targeted work. All run debugger-free via
 * `chrome.scripting` in the extension.
 */

export const ReadPageArgs = z.object({
  format: z
    .enum(["text", "markdown"])
    .optional()
    .describe(
      "Output format. `text` (default) = clean plain text; `markdown` = headings/links/lists.",
    ),
  maxLength: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Truncate the content to at most this many characters."),
});

export const readPage: Tool = {
  schema: {
    name: "browser_read_page",
    description:
      "Read the page's main content as clean text or Markdown (strips nav/scripts/styles). " +
      "Use this instead of browser_snapshot when you only need to READ a page — it is far " +
      "more token-efficient. Does NOT return element refs; use browser_snapshot/browser_find to interact.",
    inputSchema: zodToJsonSchema(ReadPageArgs),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = ReadPageArgs.parse(params ?? {});
    const r = (await context.sendSocketMessage("browser_read_page", args)) as {
      url: string;
      title: string;
      content: string;
      truncated: boolean;
    };
    const header = `# ${r.title}\n${r.url}\n\n`;
    const note = r.truncated ? "\n\n…(truncated)" : "";
    return { content: [{ type: "text", text: header + r.content + note }] };
  },
};

export const GetHtmlArgs = z.object({
  ref: z
    .string()
    .optional()
    .describe("Element ref from a snapshot/find. Omit to get the whole document's HTML."),
  maxLength: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Truncate the HTML to at most this many characters (default 50000)."),
});

export const getHtml: Tool = {
  schema: {
    name: "browser_get_html",
    description:
      "Get the raw outerHTML of the page (or of a specific element by `ref`). Useful for " +
      "scraping structure/attributes a snapshot omits. Large pages are truncated.",
    inputSchema: zodToJsonSchema(GetHtmlArgs),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = GetHtmlArgs.parse(params ?? {});
    const r = (await context.sendSocketMessage("browser_get_html", args)) as {
      html: string;
      truncated: boolean;
    };
    const note = r.truncated ? "\n\n…(truncated)" : "";
    return { content: [{ type: "text", text: r.html + note }] };
  },
};

export const FindArgs = z
  .object({
    text: z
      .string()
      .optional()
      .describe("Case-insensitive substring to match in element text/name."),
    role: z.string().optional().describe("ARIA role / tag to match (e.g. button, link, textbox)."),
    selector: z.string().optional().describe("CSS selector to restrict candidates."),
    max: z.number().int().positive().optional().describe("Max matches to return (default 20)."),
  })
  .refine(
    (v) => !!(v.text || v.role || v.selector),
    "Provide at least one of: text, role, selector",
  );

export const find: Tool = {
  schema: {
    name: "browser_find",
    description:
      "Find elements by text, role, and/or CSS selector and return fresh refs WITHOUT a full " +
      "snapshot. Use when you already know what you want to click/type — cheaper than browser_snapshot. " +
      "The returned [ref=eN] values are usable by browser_click/type/etc. until the next snapshot/find.",
    inputSchema: zodToJsonSchema(FindArgs),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = FindArgs.parse(params ?? {});
    const matches = (await context.sendSocketMessage("browser_find", args)) as Array<{
      ref: string;
      role: string;
      name: string;
      tag: string;
    }>;
    const text =
      matches.length === 0
        ? "(no matching elements found)"
        : matches
            .map((m) => `- ${m.role}${m.name ? ` "${m.name}"` : ""} [ref=${m.ref}]`)
            .join("\n");
    return { content: [{ type: "text", text }] };
  },
};
