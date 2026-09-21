/**
 * Live two-IDE demo: TWO independent MCP controllers (each `dist/index.js`, i.e.
 * what a second IDE spawns) drive TWO different tabs of ONE browser at the same
 * time. Uses a *stateful* fake browser that tracks per-tab URLs, so the output
 * shows each controller's navigation landing on its own tab, plus the same-tab
 * conflict being refused. Isolated port range + token so it never touches the
 * user's real relay on 9009.
 *
 * Run:  node scripts/two-ide-tab-demo.cjs   (after `npm run build`)
 */
const { spawn } = require("child_process");
const { createHmac } = require("crypto");
const path = require("path");
const WebSocket = require(path.resolve(__dirname, "..", "node_modules/ws"));

const ROOT = path.resolve(__dirname, "..");
const TOKEN = "demo-token";
const RS = 9130;
const RE = 9133;
const env = {
  ...process.env,
  AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
  AUTOMATE_BROWSER_TOKEN: TOKEN,
  AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (challenge) => ({
  scheme: "hmac-sha256",
  challenge,
  response: createHmac("sha256", TOKEN).update(challenge).digest("base64url"),
});

// ── one MCP controller process (= one IDE) speaking JSON-RPC over stdio ──
function makeController(name) {
  const child = spawn("node", ["dist/index.js"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, AUTOMATE_BROWSER_CLIENT_NAME: name },
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
  const call = (toolName, args) => rpc("tools/call", { name: toolName, arguments: args });
  return {
    rpc,
    call,
    kill: () => {
      try {
        child.kill();
      } catch {}
    },
  };
}

async function init(c) {
  await c.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "demo", version: "0" },
  });
  child_notify(c);
}
function child_notify(c) {
  // notifications/initialized (fire-and-forget)
  c.rpc("notifications/initialized", {});
}
const text = (res) => (res && res.result && res.result.content ? res.result.content[0].text : "");
const isErr = (res) => !!(res && res.result && res.result.isError === true);

// ── a STATEFUL fake browser: real per-tab URLs, keyed by __bmcpTabId ──
function makeBrowser(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const tabs = new Map([
      [100, { index: 0, tabId: 100, url: "about:blank#100", title: "Tab 100", active: true }],
      [200, { index: 1, tabId: 200, url: "about:blank#200", title: "Tab 200", active: false }],
    ]);
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "hello") {
        const auth = msg.payload?.auth?.challenge ? sign(msg.payload.auth.challenge) : undefined;
        ws.send(
          JSON.stringify({
            id: "idf",
            type: "identify",
            payload: { browser: "chrome", label: "Demo", tabId: 100, auth },
          }),
        );
        return;
      }
      if (msg.type === "messageResponse") return;
      if (!msg.id || !msg.type) return;
      const p = msg.payload || {};
      const tabId = p.__bmcpTabId;
      let result = { ok: true };
      if (msg.type === "browser_list_tabs") {
        result = [...tabs.values()];
      } else if (msg.type === "browser_navigate") {
        const t = tabs.get(tabId);
        if (t) t.url = p.url;
        result = { ok: true, navigated: true, urlAfter: p.url };
      } else if (msg.type === "browser_snapshot") {
        const t = tabs.get(tabId);
        result = `Current page of tab ${tabId}: ${t ? t.url : "(unknown tab)"}`;
      }
      ws.send(JSON.stringify({ type: "messageResponse", payload: { requestId: msg.id, result } }));
    });
    ws.on("open", () => setTimeout(() => resolve({ ws, tabs }), 200));
  });
}

function probeRelay(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    let done = false,
      ws;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try {
        ws && ws.close();
      } catch {}
      resolve(r);
    };
    const t = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      return finish(false);
    }
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m?.type === "hello" && m.payload?.role === "relay") finish(true);
    });
    ws.on("error", () => finish(false));
  });
}
async function waitForRelay() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    for (let p = RS; p <= RE; p++) if (await probeRelay(p)) return p;
    await sleep(120);
  }
  return null;
}

(async () => {
  const A = makeController("IDE-Alice"); // spawns the relay
  const port = await waitForRelay();
  console.log(port ? `▶ relay up on 127.0.0.1:${port}\n` : "✗ relay did not start");
  if (!port) {
    A.kill();
    process.exit(1);
  }
  await init(A);
  const B = makeController("IDE-Bob");
  await init(B);
  const browser = await makeBrowser(port);
  await sleep(400);

  console.log("Two IDEs, one browser, two tabs:\n");
  await A.call("browser_select_tab", { tabId: 100 });
  await B.call("browser_select_tab", { tabId: 200 });
  console.log("  IDE-Alice selected tab 100   IDE-Bob selected tab 200\n");

  // Both navigate AT THE SAME TIME — different tabs of the SAME browser.
  console.log("▶ both navigate concurrently …");
  const [ra, rb] = await Promise.all([
    A.call("browser_navigate", { url: "https://alice.example/home", includeSnapshot: false }),
    B.call("browser_navigate", { url: "https://bob.example/dashboard", includeSnapshot: false }),
  ]);
  console.log(`   Alice → ${isErr(ra) ? "ERROR: " + text(ra) : "ok"}`);
  console.log(`   Bob   → ${isErr(rb) ? "ERROR: " + text(rb) : "ok"}\n`);

  // Each reads back its own tab.
  const sa = text(await A.call("browser_snapshot", {}));
  const sb = text(await B.call("browser_snapshot", {}));
  console.log("▶ each IDE reads back its own tab:");
  console.log(`   Alice sees: ${sa}`);
  console.log(`   Bob sees:   ${sb}\n`);

  console.log("▶ final browser state:");
  for (const t of browser.tabs.values()) console.log(`   tab ${t.tabId}: ${t.url}`);
  console.log("");

  // Conflict: Bob tries to grab Alice's tab (100).
  await B.call("browser_select_tab", { tabId: 100 });
  const clash = await B.call("browser_navigate", {
    url: "https://bob.example/steal",
    includeSnapshot: false,
  });
  console.log("▶ Bob now targets tab 100 (Alice's) and drives:");
  console.log(
    `   ${isErr(clash) ? "correctly refused → " + text(clash).replace(/\s+/g, " ") : "UNEXPECTED: allowed"}\n`,
  );

  const pass =
    !isErr(ra) &&
    !isErr(rb) &&
    /alice\.example/.test(sa) &&
    /bob\.example/.test(sb) &&
    browser.tabs.get(100).url.includes("alice.example") &&
    browser.tabs.get(200).url.includes("bob.example") &&
    isErr(clash);
  console.log(
    pass
      ? "✅ PASS — two IDEs drove two tabs independently; same-tab drive refused."
      : "❌ FAIL — see output above.",
  );

  try {
    browser.ws.close();
  } catch {}
  A.kill();
  B.kill();
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error("DEMO_ERROR", e);
  process.exit(1);
});
