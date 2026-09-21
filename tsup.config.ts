import path from "node:path";

import { defineConfig } from "tsup";

/**
 * The four monorepo packages (`@repo/*`, `@r2r/*`) ship only as empty stubs in
 * this extracted repo, so esbuild can't resolve their subpaths. We alias each
 * imported subpath to its vendored local module under `src/vendor/` (the same
 * mapping `tsconfig.json` `paths` provides for `tsc`). `@/*` continues to
 * resolve via tsconfig `paths`, which esbuild reads natively.
 */
const r = (p: string) => path.resolve(process.cwd(), p);

export default defineConfig({
  // Three entries: the stdio MCP server (dist/index.js), the singleton relay
  // (dist/relay.js) the server spawns, and the `automate-browser` terminal
  // client (dist/cli.js). Named keys → flat dist/<key>.js outputs.
  entry: {
    index: "src/index.ts",
    relay: "src/relay/index.ts",
    cli: "src/cli.ts",
  },
  // Wipe the older hand-stubbed dist/ so only the real bundle remains.
  clean: true,
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      "@repo/config/app.config": r("src/vendor/config.ts"),
      "@repo/config/mcp.config": r("src/vendor/config.ts"),
      "@repo/messaging/types": r("src/vendor/messaging/types.ts"),
      "@repo/types/messages/ws": r("src/vendor/types/messages-ws.ts"),
      "@repo/types/mcp/tool": r("src/vendor/types/mcp-tool.ts"),
      "@r2r/messaging/ws/sender": r("src/vendor/messaging/ws-sender.ts"),
    };
  },
});
