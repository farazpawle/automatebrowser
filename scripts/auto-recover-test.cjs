/**
 * Auto-recover validation — exercises the NEW dist/index.js controller logic added
 * in src/context.ts (env-tunable connect-wait budget + one-shot no_browser retry).
 *
 * WHY a harness instead of the live MCP tools: the in-session MCP server is the
 * controller process that was spawned BEFORE `npm run build`, so it still runs the
 * old 5s-wait code (Node doesn't hot-reload). This script spawns a FRESH
 * `node dist/index.js` (the rebuilt controller) so the new code is what's under test.
 *
 * WHY fake browsers: the controller cannot tell WHY a roster is empty — a slept/
 * evicted MV3 worker and a browser that simply hasn't connected yet are
 * indistinguishable to it (both = zero browsers in the relay roster). So driving the
 * fake browser's CONNECT TIMING reproduces the real "worker was asleep" path exactly,
 * deterministically, without needing to force a real Chrome eviction.
 *
 * Isolated on its own port range + token so it never touches the live relay on 9009.
 *
 * Run:  node scripts/auto-recover-test.cjs   (after `npm run build`)
 * Exit: 0 = all assertions passed, 1 = failure.
 */
const { spawn } = require("child_process");
const { createHmac } = require("crypto");
const path = require("path");
const WebSocket = require(path.resolve(__dirname, "..", "node_modules/ws"));

const ROOT = path.resolve(__dirname, "..");
const TOKEN = "ar-token";
const RANGE_START = 9119;
const RANGE_END = 9123;
const WAIT_MS = 8000; // the budget under test (override of the 30s default)
const baseEnv = {
  ...process.env,
  AUTOMATE_BROWSER_WS_PORT_RANGE: `${RANGE_START}-${RANGE_END}`,
  AUTOMATE_BROWSER_TOKEN: TOKEN,
  AUTOMATE_BROWSER_CONNECT_WAIT_MS: String(WAIT_MS),
  AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
  AUTOMATE_BROWSER_LOG_LEVEL: "debug", // so the no_browser retry marker is emitted to stderr
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signAuthChallenge = (challenge) => ({
  scheme: "hmac-sha256",
  challenge,
  response: createHmac("sha256", TOKEN).update(challenge).digest("base64url"),
});

function makeController(env) {
  const child = spawn("node", ["dist/index.js"], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let outBuf = "";
  let stderr = "";
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
  child.stderr.on("data", (d) => (stderr += d.toString()));
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
    getStderr: () => stderr,
  };
}

async function initController(c) {
  const init = await c.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "auto-recover", version: "0" },
  });
  c.notify("notifications/initialized", {});
  return init;
}

const callText = (res) => (res && res.result ? res.result.content[0].text : "");
const isErr = (res) => !!(res && res.result && res.result.isError === true);
const ok = (res) => !!(res && res.result && !res.result.isError);
const navArgs = (url) => ({ name: "browser_navigate", arguments: { url, includeSnapshot: false } });

function probeRelay(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    let done = false;
    let ws;
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
      if (m && m.type === "hello" && m.payload && m.payload.role === "relay") finish(true);
    });
    ws.on("error", () => finish(false));
  });
}
async function waitForRelayPort(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let p = RANGE_START; p <= RANGE_END; p++) if (await probeRelay(p)) return p;
    await sleep(120);
  }
  return null;
}

// A fake browser connected to the relay; auto-replies {ok:true} to every tool frame.
function makeClient(port, identify) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const received = [];
    let helloOk = false;
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "hello") {
        const auth = msg.payload?.auth?.challenge
          ? signAuthChallenge(msg.payload.auth.challenge)
          : undefined;
        helloOk = !!(
          msg.payload &&
          msg.payload.server === "automate-browser" &&
          msg.payload.role === "relay" &&
          auth
        );
        ws.send(JSON.stringify({ id: "idf", type: "identify", payload: { ...identify, auth } }));
        return;
      }
      if (msg.type === "messageResponse") return;
      if (msg.id && msg.type) {
        received.push(msg.type);
        ws.send(
          JSON.stringify({
            type: "messageResponse",
            payload: { requestId: msg.id, result: { ok: true } },
          }),
        );
      }
    });
    ws.on("open", () => setTimeout(() => resolve({ ws, received, helloOk: () => helloOk }), 200));
  });
}

const checks = [];
const assert = (name, cond, detail) => {
  checks.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

let C1, C2;
(async () => {
  C1 = makeController({ ...baseEnv, AUTOMATE_BROWSER_CLIENT_NAME: "Recover1" });
  const port = await waitForRelayPort();
  assert("relay came up (isolated range)", port != null);
  if (port == null) throw new Error("no relay");
  await initController(C1);

  // ── Scenario #1 + #5: empty roster, browser appears AFTER the old 5s cutoff ──
  // Fire a tool with NO browser connected; connect a fake browser at 6.2s. The OLD
  // code would have failed at 5s; the NEW budget (8s) must keep waiting and recover.
  {
    let connectedAt = 0;
    const t0 = Date.now();
    const navP = C1.rpc("tools/call", navArgs("https://example.com/recover"));
    const connectP = (async () => {
      await sleep(6200);
      connectedAt = Date.now() - t0;
      return makeClient(port, { browser: "chrome", label: "Woke" });
    })();
    const [nav, client] = await Promise.all([navP, connectP]);
    const elapsed = Date.now() - t0;
    assert(
      "empty roster recovers when browser wakes past the old 5s cutoff",
      ok(nav) && elapsed > 5500 && elapsed < WAIT_MS + 1500,
      `browser connected at ${connectedAt}ms, call resolved at ${elapsed}ms (old code fails at 5000ms)`,
    );
    assert(
      "recovered call actually routed to the woken browser",
      client.received.includes("browser_navigate"),
    );
    try {
      client.ws.close();
    } catch {}
    await sleep(500); // let the roster clear
  }

  // ── Scenario #5: budget honored — no browser ever connects → fail at ~WAIT_MS ──
  {
    const t0 = Date.now();
    const nav = C1.rpc("tools/call", navArgs("https://example.com/never"));
    const res = await nav;
    const elapsed = Date.now() - t0;
    assert(
      "AUTOMATE_BROWSER_CONNECT_WAIT_MS honored as the wait budget",
      isErr(res) && elapsed > WAIT_MS - 1500 && elapsed < WAIT_MS + 2500,
      `errored at ${elapsed}ms (budget ${WAIT_MS}ms): ${callText(res).split("\n")[0]}`,
    );
  }

  // ── Scenario #3: no_browser RETRY — target vanishes at send time, retry recovers ──
  // Connect X, drive it (auto-claim). Then close X and fire the next drive IMMEDIATELY
  // (without awaiting Y) so the controller still has X cached → the relay returns
  // no_browser → the retry branch must fire (observable via the debug marker), forget
  // X, re-wait, and resend onto the replacement Y. Proves the retry path, not just a
  // lucky roster reconcile. Requires AUTOMATE_BROWSER_LOG_LEVEL=debug (set in env).
  {
    const x = await makeClient(port, { browser: "chrome", label: "X" });
    await sleep(300);
    const first = await C1.rpc("tools/call", navArgs("https://example.com/x"));
    assert(
      "drives the connected browser X (baseline)",
      ok(first) && x.received.includes("browser_navigate"),
    );

    const stderrBefore = C1.getStderr().length;
    try {
      x.ws.close();
    } catch {} // X is gone at the relay, but C1's cache may still hold it
    const recoverP = C1.rpc("tools/call", navArgs("https://example.com/y")); // fire NOW (X may still be cached)
    const y = await makeClient(port, { browser: "chrome", label: "Y" }); // replacement arrives during the wait/retry
    const recover = await recoverP;
    // The no_browser RETRY branch only fires if the send carries the dead id before
    // C1 processes the removal broadcast — a sub-frame race. When it does, the debug
    // marker proves it; either way the call must RECOVER (retry OR empty-cache wait).
    const retryLogged = /no_browser on .*retrying/.test(C1.getStderr().slice(stderrBefore));
    console.log(
      `INFO  no_browser retry branch ${retryLogged ? "fired this run (debug marker seen)" : "not hit this run (recovered via empty-cache wait)"}`,
    );
    assert(
      "recovers after the targeted browser vanished (no hard error)",
      ok(recover) && y.received.includes("browser_navigate"),
      `result: ${ok(recover) ? "ok, routed to replacement" : callText(recover).split("\n")[0]}`,
    );
    try {
      y.ws.close();
    } catch {}
    await sleep(400);
  }

  // ── Scenario #4: claimed behavior UNCHANGED — 2nd agent blocked + told the holder ──
  {
    const b = await makeClient(port, { browser: "edge", label: "Shared" });
    await sleep(300);
    const own = await C1.rpc("tools/call", navArgs("https://example.com/own")); // Recover1 auto-claims
    assert("holder drives + auto-claims the browser", ok(own));
    C2 = makeController({ ...baseEnv, AUTOMATE_BROWSER_CLIENT_NAME: "Recover2" });
    await initController(C2);
    await sleep(300);
    const blocked = await C2.rpc("tools/call", navArgs("https://example.com/steal"));
    assert(
      "claimed is NOT auto-retried — 2nd agent blocked and told the holder by name",
      isErr(blocked) && /Recover1/.test(callText(blocked)),
      callText(blocked).split("\n")[0],
    );
    try {
      b.ws.close();
    } catch {}
  }

  C1.kill();
  if (C2) C2.kill();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log("--- C1 stderr ---\n" + C1.getStderr().trim());
    if (C2) console.log("--- C2 stderr ---\n" + C2.getStderr().trim());
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS_ERROR", e);
  try {
    C1 && C1.kill();
  } catch {}
  try {
    C2 && C2.kill();
  } catch {}
  process.exit(1);
});
