import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  RootsListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { Context } from "@/context";
import type { Resource } from "@/resources/resource";
import { callTool } from "@/tools/call";
import { errorResult } from "@/tools/errors";
import { wireSchema, type Tool } from "@/tools/tool";
import { debugLog } from "@/utils/log";
import { logRootSources, setRoots } from "@/utils/paths";

type Options = {
  name: string;
  version: string;
  tools: Tool[];
  resources: Resource[];
};

export async function createServerWithTools(options: Options): Promise<Server> {
  const { name, version, tools, resources } = options;

  // This server no longer hosts a browser WebSocket. Browsers connect to the
  // singleton relay; the Context connects out to that relay as a controller, so
  // every IDE's server shares the same set of browsers (no per-process
  // partition). ensureRelay (inside the link) spawns the relay if none is up.
  //
  // Start the link in the BACKGROUND: tool calls await readiness on first use
  // (Context._requireActiveId), so a relay that is slow/failing to spawn must
  // never reject `initialize` — that would close the stdio transport and the
  // IDE would show "Transport closed". The link keeps retrying with backoff.
  const context = new Context({ version });
  void context.start().catch((err) => {
    debugLog("[server] relay link not ready yet (will retry):", String(err));
  });

  const server = new Server(
    { name, version },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // ── Filesystem sandbox: adopt the client's MCP roots as the allow-list ──────
  // Never let this break `initialize`. A client may advertise `roots` and still
  // fail the call; the cwd+tmpdir fallback in utils/paths is already safe, so
  // every failure here is logged and swallowed.
  const refreshRoots = async () => {
    try {
      if (!server.getClientCapabilities()?.roots) {
        debugLog(
          "[roots] client offers no roots; path sandbox uses cwd + tmpdir + AUTOMATE_BROWSER_WORKSPACE",
        );
        // Say what is actually in force, not just what is missing — on a client
        // that sends no roots this line is the only place the user can see
        // whether their AUTOMATE_BROWSER_WORKSPACE folders were understood.
        logRootSources();
        return;
      }
      const { roots } = await server.listRoots();
      setRoots(roots); // logs the merged allow-list itself
    } catch (err) {
      debugLog("[roots] listRoots failed; keeping the current allow-list:", String(err));
      logRootSources();
    }
  };

  try {
    server.oninitialized = () => void refreshRoots();
    server.setNotificationHandler(RootsListChangedNotificationSchema, () => void refreshRoots());
  } catch (err) {
    debugLog("[roots] could not subscribe to roots changes:", String(err));
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: tools.map((tool) => wireSchema(tool.schema)) };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: resources.map((resource) => resource.schema) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((tool) => tool.schema.name === request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Tool "${request.params.name}" not found` }],
        isError: true,
      };
    }

    const startedAt = Date.now();
    try {
      // Path sandboxing and the console-delta footer live in callTool, shared
      // with the CLI. A throw here ⇒ the catch below returns isError.
      const result = await callTool(context, tool, request.params.arguments);
      debugLog(`[tool] name=${request.params.name} ms=${Date.now() - startedAt}`);
      return result;
    } catch (error) {
      debugLog(
        `[tool] name=${request.params.name} ms=${Date.now() - startedAt} error=${String(error)}`,
      );
      // B6: a code, a retryable flag and the tool to call next — as text for an
      // agent that reads prose, and as structuredContent for one that does not.
      // Shaped in `errors.ts` so the rule about which tools can carry the
      // structured half is testable without standing a server up (I04).
      return errorResult(tool, error);
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = resources.find((resource) => resource.schema.uri === request.params.uri);
    if (!resource) {
      return { contents: [] };
    }

    const contents = await resource.read(context, request.params.uri);
    return { contents };
  });

  const originalClose = server.close.bind(server);
  server.close = async () => {
    await Promise.allSettled([originalClose(), context.close()]);
  };

  return server;
}
