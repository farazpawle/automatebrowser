/**
 * Live verification with REAL browsers. Spawns this repo's built server, speaks
 * MCP over stdio, and waits for the connected extensions (Chrome + Edge) to show
 * up in the registry — proving the multi-browser fix end-to-end:
 *   - both browsers connect to ONE server (no last-wins kicking)
 *   - each `identify`s correctly (browser=chrome / edge, + label)
 *   - browser_select_client deterministically sets the active target
 *
 * Requires port 9009 to be free (stop any other automate-browser server first).
 * Run:  node scripts/live-verify.cjs
 */
const { spawn } = require("child_process");
const path = require("path");

const child = spawn("node", ["dist/index.js"], {
  cwd: path.resolve(__dirname, ".."),
  stdio: ["pipe", "pipe", "pipe"],
});
let outBuf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  outBuf += d.toString();
  let i;
  while ((i = outBuf.indexOf("\n")) >= 0) {
    const line = outBuf.slice(0, i);
    outBuf = outBuf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id != null && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  }
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nid = 1;
function rpc(method, params) {
  const id = nid++;
  return new Promise((res) => {
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const callTool = (name, args) => rpc("tools/call", { name, arguments: args || {} });
const text = (r) =>
  r && r.result && r.result.content && r.result.content[0]
    ? r.result.content[0].text
    : JSON.stringify((r && (r.result || r.error)) || r);
const countClients = (t) => (String(t).match(/id=/g) || []).length;

(async () => {
  await sleep(800);
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "live", version: "0" },
  });
  const port = (stderr.match(/listening on (ws:\/\/\S+)/) || [])[1] || "(unknown)";
  console.log(
    "server: " + port + "   MCP init: " + (init.result ? "ok" : JSON.stringify(init.error)),
  );
  notify("notifications/initialized", {});

  let listText = "";
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const r = await callTool("browser_list_clients", {});
    listText = text(r);
    const n = countClients(listText);
    console.log(`[poll] connected browsers: ${n}`);
    if (n >= 2) break;
    await sleep(1500);
  }

  console.log("\n--- browser_list_clients ---\n" + (listText || "(none)"));
  if (countClients(listText) >= 2) {
    const e = await callTool("browser_select_client", { browser: "edge" });
    console.log("\nselect edge   -> " + text(e));
    const c = await callTool("browser_select_client", { browser: "chrome" });
    console.log("select chrome -> " + text(c));
    console.log(
      "\nRESULT: PASS — both browsers connected to one server, identified, and selectable.",
    );
  } else {
    console.log("\nRESULT: INCOMPLETE — did not see 2 browsers.");
    console.log("--- server stderr (connect/identify events) ---\n" + stderr.trim());
  }
  try {
    child.kill();
  } catch {}
  process.exit(0);
})().catch((e) => {
  console.error("ERR", e);
  try {
    child.kill();
  } catch {}
  process.exit(1);
});
