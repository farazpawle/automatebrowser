#!/usr/bin/env node
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Option, program } from "commander";

import { appConfig } from "@repo/config/app.config";

import type { Resource } from "@/resources/resource";
import { createServerWithTools } from "@/server";
import { activeSelection, selectTools } from "@/tools/registry";
import { wireSchema } from "@/tools/tool";
import { debugLog } from "@/utils/log";
import { checkForUpdate } from "@/utils/update-check";

import packageJSON from "../package.json";

const FORCE_EXIT_MS = 5_000;
/** Cadence of the parent-liveness watchdog that self-terminates orphaned servers. */
const PARENT_WATCH_MS = 5_000;

/**
 * Does `pid` still exist? Signal 0 is a POSIX/Windows existence probe — it never
 * delivers a signal. ESRCH ⇒ the process is gone; EPERM ⇒ it exists but we may
 * not signal it (still alive).
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function installShutdownHandlers(server: Server) {
  let closing = false;
  const shutdown = async (reason: string) => {
    if (closing) return;
    closing = true;
    debugLog(`[shutdown] ${reason}`);
    const forceTimer = setTimeout(() => {
      debugLog("[shutdown] force exit after timeout");
      process.exit(0);
    }, FORCE_EXIT_MS);
    forceTimer.unref?.();
    try {
      await server.close();
    } catch (err) {
      debugLog("[shutdown] error during close:", err);
    } finally {
      clearTimeout(forceTimer);
      process.exit(0);
    }
  };

  // Exit when the IDE closes the stdio pipe. `close` alone is unreliable on
  // Windows, so also watch `end` (EOF) and `error` (pipe reset).
  process.stdin.on("close", () => void shutdown("stdin closed"));
  process.stdin.on("end", () => void shutdown("stdin ended"));
  process.stdin.on("error", () => void shutdown("stdin error"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Orphan self-termination. An IDE that vanishes WITHOUT closing stdin (window
  // closed, MCP reconnect, crash, process-tree reparenting) would otherwise leave
  // this process alive forever — the open relay socket keeps the event loop up and
  // the crash guards swallow errors — so it lingers as a phantom "idle" agent in
  // the relay roster. The server therefore watches its parent (the IDE) and exits
  // the moment it's gone. The timer is unref'd so it never keeps us alive itself.
  // ponytail: relies on the parent pid; a same-window PID reuse within the 5s poll
  // could delay exit — the stdin handlers above cover that common path anyway.
  const parentPid = process.ppid;
  if (parentPid > 1) {
    const watch = setInterval(() => {
      if (!processAlive(parentPid)) {
        clearInterval(watch);
        void shutdown(`parent process ${parentPid} gone (orphaned)`);
      }
    }, PARENT_WATCH_MS);
    watch.unref?.();
  }
}

/**
 * Keep the process alive on unexpected async errors. The relay link and tool
 * handlers must never crash the stdio transport (the IDE would show "Transport
 * closed"); they degrade and the link reconnects. We log and carry on rather
 * than letting Node's default handler exit the process.
 */
function installCrashGuards() {
  process.on("uncaughtException", (err) => {
    debugLog("[uncaughtException]", String(err));
  });
  process.on("unhandledRejection", (reason) => {
    debugLog("[unhandledRejection]", String(reason));
  });
}

const resources: Resource[] = [];

async function createServer(): Promise<Server> {
  return createServerWithTools({
    name: appConfig.name,
    version: packageJSON.version,
    tools: activeSelection().tools,
    resources,
  });
}

program
  .version("Version " + packageJSON.version)
  .name(packageJSON.name)
  // Hidden tooling hook: dumps the schemas this server would advertise and
  // exits, without constructing a Context or touching the relay. Feeds
  // scripts/count-tokens.mjs and scripts/generate-docs.mjs. A profile name
  // selects that profile explicitly; the bare flag reports what the current
  // environment would serve.
  .addOption(
    new Option("--print-tools [profile]", "print tool schemas as JSON and exit").hideHelp(),
  )
  .action(async (options: { printTools?: string | boolean }) => {
    if (options.printTools) {
      const selection =
        typeof options.printTools === "string"
          ? selectTools(options.printTools)
          : activeSelection();
      // `wireSchema`, not `tool.schema`: the token gate must measure the bytes
      // the wire actually carries, or it reports a cost nobody pays.
      process.stdout.write(
        JSON.stringify(selection.tools.map((tool) => wireSchema(tool.schema))) + "\n",
      );
      return;
    }

    installCrashGuards();

    // Fire-and-forget, deliberately un-awaited: a slow or unreachable registry
    // must never delay the transport coming up. See utils/update-check.ts.
    void checkForUpdate(packageJSON.version);

    try {
      const server = await createServer();
      installShutdownHandlers(server);

      const transport = new StdioServerTransport();
      await server.connect(transport);
    } catch (err) {
      // Never let a startup hiccup take down the transport silently — log it and
      // stay alive so the IDE keeps the session (the relay link retries on its own).
      debugLog("[startup] failed to start server:", String(err));
    }
  });
program.parse(process.argv);
