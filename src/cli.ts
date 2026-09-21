#!/usr/bin/env node
/**
 * `automate-browser` — drive the browser from a terminal, through the same relay
 * the IDE agents use. It is a controller like any MCP server: it joins the mesh,
 * shows up in every agent's `browser_status` peer list, runs one tool, prints the
 * result and exits.
 *
 * Two forms, both dispatching through the same registry the MCP server serves:
 *
 *   automate-browser navigate https://example.com     # friendly alias
 *   automate-browser browser_click --args '{"ref":"e12"}'
 *
 * Diagnostics go to stderr (utils/log), so stdout carries the tool result only
 * and `--json` is safe to pipe.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { program } from "commander";

import { Context } from "@/context";
import { callTool } from "@/tools/call";
import { asToolError, renderError } from "@/tools/errors";
import { selectTools } from "@/tools/registry";
import type { Tool, ToolResult } from "@/tools/tool";
import { debugLog } from "@/utils/log";

import packageJSON from "../package.json";

// Name this controller reports to the relay, so an IDE's peer list shows "cli"
// instead of another anonymous `mcp-<pid>`. Must be set before Context is
// constructed — it reads the env var in a field initialiser.
process.env.AUTOMATE_BROWSER_CLIENT_NAME ||= "cli";

// Every CLI run is its own instance. The default instance id is derived from the
// parent process and cwd so an IDE that relaunches its server replaces its old
// roster entry — but two `automate-browser` commands from one shell share both,
// and the second would evict the first mid-flight. A one-shot process has no
// entry worth reclaiming, so it opts out with a fresh id instead.
process.env.AUTOMATE_BROWSER_INSTANCE_ID ||= randomUUID();

/** Short names for the handful of things worth typing by hand. */
const ALIASES: Record<string, { tool: string; positional?: string }> = {
  navigate: { tool: "browser_navigate", positional: "url" },
  "read-page": { tool: "browser_read_page" },
  snapshot: { tool: "browser_snapshot" },
  screenshot: { tool: "browser_screenshot" },
  status: { tool: "browser_status" },
  eval: { tool: "browser_eval", positional: "expression" },
  tabs: { tool: "browser_list_tabs" },
};

/** Extension for a saved image part, so a screenshot opens on double-click. */
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Every tool, regardless of AUTOMATE_BROWSER_TOOLS. The profiles exist to keep an
 * agent's schema payload small; a human at a terminal pays no token cost, so a
 * trimmed profile must not hide `automate-browser read-page`.
 */
const TOOLS = selectTools("full").tools;

/**
 * Write and wait for the pipe to drain. `process.exit()` truncates a stdout write
 * that is still queued, and every result here is printed immediately before exit.
 */
const write = (stream: NodeJS.WriteStream, text: string): Promise<void> =>
  new Promise((resolve) => stream.write(text, () => resolve()));

/** Resolve a command word to a tool: alias first, then a tool name with or without the prefix. */
function resolveTool(command: string): { tool: Tool; positional?: string } {
  const alias = ALIASES[command];
  const name = alias?.tool ?? command;
  const tool =
    TOOLS.find((t) => t.schema.name === name) ??
    TOOLS.find((t) => t.schema.name === `browser_${name}`);
  if (!tool) {
    throw new Error(
      `Unknown command "${command}".\n\n` +
        `Aliases: ${Object.keys(ALIASES).join(", ")}\n\n` +
        `Tools:\n${TOOLS.map((t) => `  ${t.schema.name}`).join("\n")}`,
    );
  }
  return { tool, positional: alias?.positional };
}

/** Merge `--args '{…}'` with an alias's positional value (the positional wins). */
function buildArgs(
  command: string,
  positional: string | undefined,
  value: string | undefined,
  json: string | undefined,
): Record<string, unknown> {
  let args: Record<string, unknown> = {};
  if (json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new Error(`--args is not valid JSON: ${(err as Error).message}`, { cause: err });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`--args must be a JSON object, e.g. --args '{"url":"https://example.com"}'`);
    }
    args = parsed as Record<string, unknown>;
  }
  if (value !== undefined) {
    if (!positional) {
      throw new Error(
        `"${command}" takes no positional argument — pass its options with --args '{…}'.`,
      );
    }
    args[positional] = value;
  }
  return args;
}

async function printResult(result: ToolResult, asJson: boolean): Promise<void> {
  if (asJson) {
    await write(process.stdout, JSON.stringify(result, null, 2) + "\n");
    return;
  }
  for (const part of result.content) {
    if (part.type === "text") {
      await write(process.stdout, part.text + "\n");
      continue;
    }
    // Base64 in a terminal helps nobody: write the image out and say where it
    // landed. tmpdir keeps the working directory clean and is always an allowed
    // sandbox root, so this matches how perf traces default.
    const file = join(
      tmpdir(),
      `automate-browser-${Date.now()}.${IMAGE_EXT[part.mimeType] ?? "bin"}`,
    );
    writeFileSync(file, Buffer.from(part.data, "base64"));
    await write(process.stdout, `${part.mimeType} saved → ${file}\n`);
  }
}

program
  .name("automate-browser")
  .description(
    "Drive your logged-in browser from the terminal, alongside any connected IDE agents.",
  )
  .version(packageJSON.version)
  .argument("<command>", `alias (${Object.keys(ALIASES).join(", ")}) or a tool name`)
  .argument("[value]", "the alias's argument, e.g. the URL for `navigate`")
  .option("--args <json>", "tool arguments as a JSON object")
  .option("--json", "print the whole tool result as JSON, for scripting")
  .addHelpText(
    "after",
    "\nExamples:\n" +
      "  automate-browser status\n" +
      "  automate-browser navigate https://example.com\n" +
      "  automate-browser eval 'document.title'\n" +
      '  automate-browser read-page --args \'{"format":"markdown"}\'\n' +
      "  automate-browser tabs --json\n",
  )
  .action(
    async (command: string, value: string | undefined, opts: { args?: string; json?: boolean }) => {
      let context: Context | undefined;
      try {
        const { tool, positional } = resolveTool(command);
        const args = buildArgs(command, positional, value, opts.args);

        context = new Context({ version: packageJSON.version });
        // Dial the relay, spawning it if none is up. A failure here is NOT fatal:
        // the tool call below produces the actionable "no connection to browser
        // extension" guidance, which beats a raw socket error.
        await context.start().catch((err) => {
          debugLog("[cli] relay link not ready:", String(err));
        });

        const result = await callTool(context, tool, args);
        await printResult(result, opts.json === true);
        await context.close();
        process.exit(result.isError ? 1 : 0);
      } catch (err) {
        // The SAME text the MCP path returns: the error code, the recovery tool
        // and then the prose. The two entry points share `callTool` precisely so
        // a failure means the same thing in both, and printing the bare
        // `.message` here dropped the code and the next step on the floor —
        // every CLI failure read as untyped prose while the IDE got B6's head
        // (I04). An error with no code keeps the bare message: `renderError`
        // falls back to `String(e)`, and a terminal does not want the
        // "Error: " that `toString` puts in front of the `--help` text.
        const typed = asToolError(err);
        await write(
          process.stderr,
          `${typed ? renderError(typed) : err instanceof Error ? err.message : String(err)}\n`,
        );
        await context?.close().catch(() => undefined);
        process.exit(1);
      }
    },
  );

void program.parseAsync(process.argv);
