/**
 * Safe real-browser interop check: spawn a FRESH `node dist/index.js` (the rebuilt
 * controller) as an extra controller on the LIVE relay (9009) and read the roster.
 * Read-only — it calls browser_list_clients only, so it never claims or drives the
 * user's real browser/tab. Proves the new build interoperates with the running
 * AutomateBrowser extension. Auto-exits.
 */
const { spawn } = require("child_process");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

function makeController(env) {
  const child = spawn("node", ["dist/index.js"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let outBuf = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.on("data", (d) => {
    outBuf += d.toString();
    let i;
    while ((i = outBuf.indexOf("\n")) >= 0) {
      const line = outBuf.slice(0, i);
      outBuf = outBuf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return {
    child,
    rpc,
    notify,
    kill: () => {
      try {
        child.kill();
      } catch {}
    },
  };
}

(async () => {
  const c = makeController({ ...process.env, AUTOMATE_BROWSER_CLIENT_NAME: "NewBuildCheck" });
  await c.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "check", version: "0" },
  });
  c.notify("notifications/initialized", {});
  await new Promise((r) => setTimeout(r, 1500)); // let the relay push the roster
  const list = await c.rpc("tools/call", { name: "browser_list_clients", arguments: {} });
  const status = await c.rpc("tools/call", { name: "browser_status", arguments: {} });
  console.log("=== browser_list_clients (new build → live relay) ===");
  console.log(list.result ? list.result.content[0].text : JSON.stringify(list));
  console.log("\n=== browser_status ===");
  console.log(status.result ? status.result.content[0].text : JSON.stringify(status));
  c.kill();
  process.exit(0);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
