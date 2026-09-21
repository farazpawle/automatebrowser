/**
 * Server-side connection smoke test — no real browser required.
 *
 * Relay architecture: `dist/index.js` no longer hosts a WebSocket. It connects
 * out to the singleton relay (`dist/relay.js`, which it spawns) as a CONTROLLER.
 * Browsers connect to the RELAY. So this harness:
 *   - spawns one `dist/index.js` (controller A); it spawns the relay
 *   - connects two fake browser WS clients (Chrome + Edge) to the RELAY
 *   - speaks MCP JSON-RPC over stdio to the controller(s)
 *   - spawns a SECOND `dist/index.js` (controller B) to prove the mesh
 *
 * Isolation: a high, dedicated port range (AUTOMATE_BROWSER_WS_PORT_RANGE) and a
 * token (AUTOMATE_BROWSER_TOKEN) keep this test off the user's live relay on 9009.
 *
 * Asserts:
 *   - relay comes up; both fake browsers validate `hello` (role:"relay") + identify
 *   - browser_list_clients shows both browsers — from BOTH controllers (shared roster)
 *   - a tool refuses with a disambiguation error while 2 are connected
 *   - browser_select_client routes a call to the chosen browser only
 *   - per-controller selection: A's choice does NOT change B's (B still ambiguous)
 *   - selection in A and B are independent (route to different browsers)
 *   - active selection falls back when the chosen browser disconnects
 *   - lean click (no auto snapshot), browser_select_tab, browser_eval route through
 *   - tab-scoped control: two controllers drive two different tabs of ONE browser
 *     at once (each navigate carries its own __bmcpTabId); a same-tab drive is
 *     refused; a whole-browser lease blocks another agent's per-tab drive
 *   - smart-auto targeting: with NO explicit select, each agent claims the
 *     browser's FOCUSED tab, so two agents coexist on two tabs and an agent keeps
 *     its own tab instead of following focus onto a tab another agent drives
 *   - roster push: the browser-bound `agents` frame carries the connected-agent
 *     roster (not just live claims), so the popup lists idle agents too; a
 *     disconnect drops the agent from the roster
 *   - console-delta footer: a mutating tool reports NEW console errors, a
 *     read-only one never does, the env opt-out silences it, and a dropped
 *     console probe cannot fail the underlying action
 *   - CLI: `dist/cli.js` joins the same relay mesh as a connected IDE (each sees
 *     the other as a peer), dispatches an alias to the browser, and exits 1 on
 *     an unknown command
 *   - version mismatch: browser_status warns when the relay reports a different
 *     build than the controller, and stays quiet when they agree
 *   - per-call timeout: `timeout: 500` gives up far short of the 8s default
 *   - send queue: two concurrent calls from one controller leave in issue order,
 *     the second only after the first has been answered
 *   - tool profiles: full is unchanged and equals an unset env, core/slim are
 *     strict subsets, the always-on diagnostics survive every profile, a bogus
 *     env value falls back to full, and tools/list matches what the profile resolves
 *   - path sandbox: traversal and absolute out-of-root file paths are refused
 *     BEFORE the tool runs, the refusal names the allowed roots, tmpdir stays
 *     writable, and AUTOMATE_BROWSER_ALLOW_UNRESTRICTED_PATHS=1 bypasses it
 *
 * Run:  node scripts/connection-smoke.cjs   (after `npm run build`)
 * Exit: 0 = all assertions passed, 1 = failure.
 */
const { spawn } = require("child_process");
const { createHmac } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require(path.resolve(__dirname, "..", "node_modules/ws"));

const ROOT = path.resolve(__dirname, "..");
const TOKEN = "smoke-token";
const RANGE_START = 9109;
const RANGE_END = 9113;
const baseEnv = {
  ...process.env,
  AUTOMATE_BROWSER_WS_PORT_RANGE: `${RANGE_START}-${RANGE_END}`,
  AUTOMATE_BROWSER_TOKEN: TOKEN,
  // Test relays should self-exit quickly once the harness leaves (not 5 min).
  AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signAuthChallenge = (challenge) => ({
  scheme: "hmac-sha256",
  challenge,
  response: createHmac("sha256", TOKEN).update(challenge).digest("base64url"),
});

// ── one MCP controller process (dist/index.js) speaking JSON-RPC over stdio ──
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
    clientInfo: { name: "smoke", version: "0" },
  });
  c.notify("notifications/initialized", {});
  return init;
}

const callText = (res) => (res && res.result ? res.result.content[0].text : "");
const isErr = (res) => !!(res && res.result && res.result.isError === true);
const ok = (res) => !!(res && res.result && !res.result.isError);

// ── probe the range for the relay (role:"relay") ──────────────────────────────
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
async function waitForRelayPort(start = RANGE_START, end = RANGE_END, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let p = start; p <= end; p++) {
      if (await probeRelay(p)) return p;
    }
    await sleep(120);
  }
  return null;
}

function expectRejectedOrigin(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Origin: "https://evil.example" },
    });
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve(false);
    }, 800);
    ws.on("open", () => resolve(false));
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(t);
      resolve(res.statusCode === 403);
    });
    ws.on("error", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

function expectMalformedClose(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve(false);
    }, 1200);
    ws.on("message", () => ws.send("not-json"));
    ws.on("close", (code) => {
      clearTimeout(t);
      resolve(code === 1003);
    });
    ws.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

function expectBadAuthRejected(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve(false);
    }, 1200);
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== "hello") return;
      ws.send(
        JSON.stringify({
          id: "bad-auth",
          type: "identify",
          payload: {
            browser: "chrome",
            auth: {
              scheme: "hmac-sha256",
              challenge: msg.payload.auth.challenge,
              response: "bad",
            },
          },
        }),
      );
    });
    ws.on("close", (code) => {
      clearTimeout(t);
      resolve(code === 1008);
    });
    ws.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

/**
 * Isolated idle-lease expiry test on its own port range with a short TTL: a
 * second agent is blocked while the first holds a live lease, then drives once
 * the lease lapses (no release needed). Proves the lazy-expiry path.
 */
async function runLeaseExpiry() {
  const RS = 9114;
  const RE = 9116;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_LEASE_TTL_MS: "800",
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
  };
  const c1 = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "Lease1" });
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("lease: relay came up (isolated range)", false);
    c1.kill();
    return;
  }
  await initController(c1);
  const c2 = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "Lease2" });
  await initController(c2);
  const solo = await makeClient(port, { browser: "chrome", label: "Solo" });
  await sleep(300);

  // Both agents deliberately adopt the SAME tab. Since an agent that selects
  // nothing now opens a tab of its own, a shared explicit target is the only way
  // two agents contend — which is precisely what the lease arbitrates.
  await c1.rpc("tools/call", { name: "browser_select_tab", arguments: { tabId: 100 } });
  await c2.rpc("tools/call", { name: "browser_select_tab", arguments: { tabId: 100 } });

  // c1 drives that tab → claims it.
  const d1 = await c1.rpc("tools/call", navArgs("https://example.com"));
  assert("lease: holder drives the sole browser", ok(d1));
  // c2 drives the same browser while the lease is live → blocked + named.
  const blocked = await c2.rpc("tools/call", navArgs("https://example.com"));
  assert(
    "lease: 2nd agent blocked while lease live",
    isErr(blocked) && /Lease1/.test(callText(blocked)),
  );
  // Wait past the TTL; the lease lapses and c2 can take over.
  await sleep(1100);
  const after = await c2.rpc("tools/call", navArgs("https://example.com"));
  assert("lease: 2nd agent drives after idle expiry", ok(after));

  try {
    solo.ws.close();
  } catch {}
  c1.kill();
  c2.kill();
}

/**
 * Tab-scoped control on its own isolated relay: TWO controllers each drive a
 * DIFFERENT tab of the SAME single browser, concurrently — the core of the
 * feature. Then a same-tab drive is correctly refused and names the holder.
 */
async function runTabScoped() {
  const RS = 9117;
  const RE = 9119;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
  };
  const a = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "TabA" });
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("tab: relay came up (isolated range)", false);
    a.kill();
    return;
  }
  assert("tab: relay came up (isolated range)", true);
  await initController(a);
  const b = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "TabB" });
  await initController(b);
  const solo = await makeClient(port, { browser: "chrome", label: "Solo" });
  await sleep(300);

  // Each controller selects a different tab of the sole browser (no claim yet).
  await a.rpc("tools/call", { name: "browser_select_tab", arguments: { tabId: 100 } });
  await b.rpc("tools/call", { name: "browser_select_tab", arguments: { tabId: 200 } });

  // Concurrent drives to two tabs of ONE browser both succeed (per-browser claims
  // would have blocked the second; per-tab claims do not).
  solo.msgs.length = 0;
  const [da, db] = await Promise.all([
    a.rpc("tools/call", navArgs("https://a.example")),
    b.rpc("tools/call", navArgs("https://b.example")),
  ]);
  assert("tab: two IDEs drive two tabs of one browser concurrently", ok(da) && ok(db));
  const tabIds = solo.msgs
    .filter((m) => m.type === "browser_navigate")
    .map((m) => m.payload && m.payload.__bmcpTabId)
    .sort((x, y) => x - y);
  assert(
    "tab: each navigate carried its own __bmcpTabId (100 & 200)",
    tabIds.length === 2 && tabIds[0] === 100 && tabIds[1] === 200,
  );

  // Same tab: B targets A's tab (100) → blocked and told who holds it.
  await b.rpc("tools/call", { name: "browser_select_tab", arguments: { tabId: 100 } });
  const clash = await b.rpc("tools/call", navArgs("https://c.example"));
  assert(
    "tab: same-tab drive blocked + names the holder",
    isErr(clash) && /TabA/.test(callText(clash)),
  );

  try {
    solo.ws.close();
  } catch {}
  a.kill();
  b.kill();
}

/**
 * Whole-browser vs per-tab precedence: a whole-browser lease blocks another
 * controller's per-tab drive, and releasing it lets that tab drive through.
 *
 * The lease is taken with `browser_force_claim`, which is now the ONLY way to get
 * one. Driving without selecting a tab used to take a whole-browser lease; it now
 * opens the agent a background tab of its own instead (plan 02, Task 1), so that
 * route no longer exists — but the relay's precedence rule still does, and this
 * is the guard on it.
 */
async function runWholePrecedence() {
  const RS = 9120;
  const RE = 9122;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
  };
  const a = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "WholeA" });
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("whole: relay came up (isolated range)", false);
    a.kill();
    return;
  }
  assert("whole: relay came up (isolated range)", true);
  await initController(a);
  const b = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "WholeB" });
  await initController(b);
  const solo = await makeClient(port, { browser: "chrome", label: "Solo" });
  await sleep(300);

  // A takes a whole-browser lease (no tabId ⇒ WHOLE_TAB).
  const da = await a.rpc("tools/call", {
    name: "browser_force_claim",
    arguments: { browser: "chrome" },
  });
  assert("whole: A takes a whole-browser lease", ok(da));
  // B selects a tab and drives → blocked by A's whole-browser lease.
  await b.rpc("tools/call", { name: "browser_select_tab", arguments: { tabId: 200 } });
  const bBlocked = await b.rpc("tools/call", navArgs("https://x.example"));
  assert(
    "whole: tab drive blocked by another agent's whole-browser lease",
    isErr(bBlocked) && /WholeA/.test(callText(bBlocked)),
  );
  // A releases → B's tab drive goes through.
  await a.rpc("tools/call", { name: "browser_release_client", arguments: {} });
  const bAfter = await b.rpc("tools/call", navArgs("https://x2.example"));
  assert("whole: tab drive works after the whole-browser lease is released", ok(bAfter));

  try {
    solo.ws.close();
  } catch {}
  a.kill();
  b.kill();
}

/**
 * Tab OWNERSHIP (plan 02, Task 1) — the data-loss guard.
 *
 * An agent that has selected no tab must never drive the tab the USER is looking
 * at. It opens a background tab of its own and drives that. Earlier builds adopted
 * the browser's focused tab, so "test this URL" could navigate away a tab holding
 * unsaved work; these assertions exist so that can never come back.
 *
 * Also proves the consequences: two agents that select nothing get two different
 * tabs and coexist, and an agent stays on its own tab when the user's focus moves.
 */
async function runAutoTab() {
  const RS = 9123;
  const RE = 9125;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
  };
  const a = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "AutoA" });
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("auto: relay came up (isolated range)", false);
    a.kill();
    return;
  }
  assert("auto: relay came up (isolated range)", true);
  await initController(a);
  const b = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "AutoB" });
  await initController(b);
  // The browser reports tab 100 as its focused tab.
  const solo = await makeClient(port, { browser: "chrome", label: "Solo", tabId: 100 });
  await sleep(300);

  // A drives with NO explicit selection. It must open its own tab first and drive
  // THAT — never tab 100, which is the one the user is looking at.
  solo.msgs.length = 0;
  solo.provisioned.length = 0;
  const da = await a.rpc("tools/call", navArgs("https://a.example"));
  assert("auto: agent drives without selecting a tab", ok(da));
  assert(
    "auto: it opened a tab of its own instead of adopting the focused one",
    solo.provisioned.length === 1 &&
      solo.msgs.some((m) => m.type === "browser_new_tab" && m.payload?.active === false),
  );
  const aTab = solo.provisioned[0];
  const aNav = solo.msgs.find((m) => m.type === "browser_navigate");
  assert(
    // THE regression guard: the user's focused tab is 100, and nothing may touch it.
    "auto: the navigate rode the agent's OWN tab, not the user's focused tab 100",
    aNav && aNav.payload && aNav.payload.__bmcpTabId === aTab && aTab !== 100,
  );

  // The user focuses tab 200 (the browser re-identifies); the roster updates.
  solo.ws.send(
    JSON.stringify({ type: "identify", payload: { browser: "chrome", label: "Solo", tabId: 200 } }),
  );
  await sleep(300);

  // B drives with NO explicit selection → gets a SECOND tab of its own, and is not
  // blocked by A (whose claim covers only A's tab).
  const db = await b.rpc("tools/call", navArgs("https://b.example"));
  const bTab = solo.provisioned[1];
  assert("auto: two agents coexist, each on a tab it opened", ok(da) && ok(db));
  const ids = solo.msgs
    .filter((m) => m.type === "browser_navigate")
    .map((m) => m.payload && m.payload.__bmcpTabId)
    .sort((x, y) => x - y);
  assert(
    "auto: each navigate carried its own provisioned tab id, neither 100 nor 200",
    ids.length === 2 &&
      bTab != null &&
      bTab !== aTab &&
      ids.join() === [aTab, bTab].sort((x, y) => x - y).join() &&
      !ids.includes(100) &&
      !ids.includes(200),
  );

  // Focus has moved to 200. A drives again → it must STICK to its own tab and not
  // follow the user's focus (and must not open a second tab either).
  await sleep(300);
  solo.msgs.length = 0;
  const da2 = await a.rpc("tools/call", navArgs("https://a2.example"));
  const aMsg = solo.msgs.find((m) => m.type === "browser_navigate");
  assert(
    "auto: agent keeps its own tab when the user's focus moves",
    ok(da2) &&
      aMsg &&
      aMsg.payload &&
      aMsg.payload.__bmcpTabId === aTab &&
      solo.provisioned.length === 2, // idempotent: no second tab for A
  );

  try {
    solo.ws.close();
  } catch {}
  a.kill();
  b.kill();
}

/**
 * Tab LIFECYCLE (plan 02, Tasks 2, 4 and 5): who opens a tab, whether it steals
 * focus, and who closes it again.
 *
 * The rule being guarded: a tab the agent OPENED is its own to clean up, and a tab
 * it ADOPTED from the user is not. Getting this backwards closes a tab the user
 * had open — the same data loss the ownership work exists to prevent, arriving by
 * a different route. Protocol level only: the harness drives a fake browser, so
 * real `chrome.windows` parking is V8's job, not this file's.
 */
async function runTabLifecycle() {
  const RS = 9126;
  const RE = 9128;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
  };
  const a = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "LifeA" });
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("life: relay came up (isolated range)", false);
    a.kill();
    return;
  }
  assert("life: relay came up (isolated range)", true);
  await initController(a);
  const solo = await makeClient(port, { browser: "chrome", label: "Solo", tabId: 100 }, (msg) =>
    msg.type === "browser_list_tabs"
      ? [{ index: 0, tabId: 4242, url: "https://app.example/dash", title: "Dash", active: true }]
      : undefined,
  );
  await sleep(300);

  // ── 5.2 browser_new_tab with no `active` argument opens in the BACKGROUND ──
  solo.msgs.length = 0;
  const opened = await a.rpc("tools/call", { name: "browser_new_tab", arguments: {} });
  const newTabMsg = solo.msgs.find((m) => m.type === "browser_new_tab");
  assert(
    "life: browser_new_tab with no `active` opens in the background",
    ok(opened) && newTabMsg && newTabMsg.payload && newTabMsg.payload.active === false,
  );
  // ...and asking for focus explicitly still reaches the browser as the opt-in.
  solo.msgs.length = 0;
  await a.rpc("tools/call", { name: "browser_new_tab", arguments: { active: true } });
  const focused = solo.msgs.find((m) => m.type === "browser_new_tab");
  assert(
    "life: `active: true` still reaches the browser as the focus opt-in",
    focused && focused.payload && focused.payload.active === true,
  );

  // ── 5.5 a tab the agent OPENED is unparked and closed on release ──
  const createdIds = solo.provisioned.slice(); // both tabs opened above are "ours"
  solo.msgs.length = 0;
  await a.rpc("tools/call", { name: "browser_release_client", arguments: {} });
  const closed = solo.msgs
    .filter((m) => m.type === "browser_close_tab")
    .map((m) => m.payload?.tabId);
  assert(
    "life: a tab the agent OPENED is closed on release",
    createdIds.length === 2 && createdIds.every((id) => closed.includes(id)),
  );
  assert(
    // Cleanup must be exactly as wide as what the agent opened — a close aimed at
    // any other tab is a tab of the user's going away.
    "life: release closes ONLY the agent's own tabs, nothing else",
    closed.length === createdIds.length,
  );

  // ── 5.3 + 5.6 a tab ADOPTED from the user is neither focused nor closed ──
  const sel = await a.rpc("tools/call", {
    name: "browser_select_tab",
    arguments: { url: "app.example" },
  });
  assert(
    "life: browser_select_tab adopts a tab by url substring",
    ok(sel) && /4242/.test(callText(sel)),
  );
  solo.msgs.length = 0;
  await a.rpc("tools/call", navArgs("https://app.example/next"));
  const drove = solo.msgs.find((m) => m.type === "browser_navigate");
  assert(
    "life: adopting by url issues NO activate/focus call and drives that tab",
    drove &&
      drove.payload &&
      drove.payload.__bmcpTabId === 4242 &&
      !solo.msgs.some((m) => m.type === "browser_switch_tab") &&
      !solo.msgs.some((m) => m.type === "browser_new_tab"),
  );
  solo.msgs.length = 0;
  await a.rpc("tools/call", { name: "browser_release_client", arguments: {} });
  assert(
    // THE guard on the cleanup: tidying up must never reach the user's own tab.
    "life: a tab ADOPTED from the user is NOT closed on release",
    !solo.msgs.some((m) => m.type === "browser_close_tab" && m.payload?.tabId === 4242),
  );

  // ── D8 a RECONNECT must not orphan the tabs the agent opened ──
  // The regression this guards: a relay id belongs to a socket, so reloading the
  // extension (or an evicted MV3 worker reviving) brings the same browser back
  // under a new one. Ownership used to be keyed by that id and pruned the moment
  // it vanished, so release closed nothing and the agent's tabs were left in the
  // user's browser. Found by hand in Edge on 2026-09-02, after the two asserts
  // above had already passed twice in the same session — which is precisely why
  // this one exists: a reload is a disconnect and THEN a reconnect, and nothing
  // in the straight-line path ever crosses that gap.
  try {
    solo.ws.close();
  } catch {}
  await sleep(300);
  const INST = "inst-d8-reload";
  const before = await makeClient(port, {
    browser: "chrome",
    label: "Reload",
    tabId: 100,
    instanceId: INST,
  });
  await sleep(300);
  await a.rpc("tools/call", { name: "browser_new_tab", arguments: {} });
  const ours = before.provisioned.slice();
  // The extension reloads: same profile, same real tabs, new socket, NEW relay id.
  try {
    before.ws.close();
  } catch {}
  await sleep(300);
  const after = await makeClient(port, {
    browser: "chrome",
    label: "Reload",
    tabId: 100,
    instanceId: INST,
  });
  await sleep(400);
  after.msgs.length = 0;
  await a.rpc("tools/call", { name: "browser_release_client", arguments: {} });
  const sweptUp = after.msgs
    .filter((m) => m.type === "browser_close_tab")
    .map((m) => m.payload?.tabId);
  assert(
    "life: a reconnect (extension reload) does NOT orphan the agent's tabs",
    ours.length === 1 && sweptUp.includes(ours[0]),
  );

  // ── B01 release while the OWNING browser is gone and another is connected ──
  // The reproduction: cleanup used to send `browser_close_tab` without naming a
  // browser, so the send path resolved whichever was active by then. Real tab ids
  // are small and per-browser, so Chrome's tab 101 and Edge's tab 101 both exist
  // — and releasing Chrome after it dropped off closed the tab in EDGE. That is
  // one of the user's own tabs vanishing, which is the failure the whole
  // ownership model exists to prevent. The tab must instead stay owed: deferred,
  // not redirected and not forgotten.
  // The previous block's browser is also a Chrome, and `browser_select_client`
  // refuses to guess between two of the same family — so retire it first.
  try {
    after.ws.close();
  } catch {}
  await sleep(300);

  const OWNER_INST = "inst-b01-owner";
  // Quits the moment it is asked to close its first tab, so the browser really is
  // gone part-way through the sweep — deterministically, on the message rather
  // than on a timer.
  let quitOnFirstClose = false;
  const owner = await makeClient(
    port,
    {
      browser: "chrome",
      label: "Owner",
      tabId: 101,
      instanceId: OWNER_INST,
    },
    (msg) => {
      if (msg.type === "browser_close_tab" && quitOnFirstClose) {
        quitOnFirstClose = false;
        setTimeout(() => {
          try {
            owner.ws.close();
          } catch {}
        }, 10);
        return NO_REPLY;
      }
      return undefined;
    },
  );
  const bystander = await makeClient(port, {
    browser: "edge",
    label: "Bystander",
    tabId: 101,
    instanceId: "inst-b01-bystander",
  });
  await sleep(300);
  await a.rpc("tools/call", { name: "browser_select_client", arguments: { browser: "chrome" } });
  await a.rpc("tools/call", { name: "browser_new_tab", arguments: {} });
  // Every tab this browser handed out is one the agent opened, so every one is
  // owed a close. The count is deliberately not pinned: the diagnostic footer on
  // a claiming call provisions one too, and that is incidental to what is being
  // tested here.
  const owed = owner.provisioned.slice();
  assert("b01: the owning browser opened tab(s) for the agent", owed.length >= 1);

  // Release while the owner QUITS mid-sweep. Edge is then the only browser left,
  // so any path that re-resolves "the active browser" for the remaining closes
  // sends them there — and Edge's tab of that number is one of the user's.
  quitOnFirstClose = true;
  bystander.msgs.length = 0;
  const startedAt = Date.now();
  const releasedGone = await a.rpc("tools/call", {
    name: "browser_release_client",
    arguments: {},
  });
  const releaseMs = Date.now() - startedAt;
  assert(
    "b01: release with the owning browser gone still answers (no stall, no throw)",
    releasedGone !== undefined && releaseMs < 15000,
  );
  assert(
    // THE assertion. A close arriving here is a tab of the user's closing.
    "b01: no close is aimed at the OTHER browser that happens to share the tab number",
    !bystander.msgs.some((m) => m.type === "browser_close_tab"),
  );
  await sleep(300);

  // The owner comes back on a new relay id. The tab it still owes must now close.
  const ownerBack = await makeClient(port, {
    browser: "chrome",
    label: "Owner",
    tabId: 101,
    instanceId: OWNER_INST,
  });
  await sleep(400);
  ownerBack.msgs.length = 0;
  bystander.msgs.length = 0;
  await a.rpc("tools/call", { name: "browser_select_client", arguments: { browser: "chrome" } });
  await a.rpc("tools/call", { name: "browser_release_client", arguments: {} });
  const deferred = ownerBack.msgs
    .filter((m) => m.type === "browser_close_tab")
    .map((m) => m.payload?.tabId);
  assert(
    "b01: the deferred cleanup lands on the owning browser once it is back",
    owed.every((id) => deferred.includes(id)),
  );
  assert(
    "b01: and still never on the other browser",
    !bystander.msgs.some((m) => m.type === "browser_close_tab"),
  );

  for (const c of [owner, bystander, ownerBack]) {
    try {
      c.ws.close();
    } catch {}
  }
  a.kill();
}

/**
 * Roster push to the browser popup: the relay sends each browser an `agents`
 * frame carrying not just live claims but the full CONNECTED-agent roster, so the
 * extension popup can list EVERY connected agent (even idle ones) instead of only
 * whoever holds a live lease. Proves: both connected agents appear with NO claim
 * held; a driving agent's tab claim shows while the roster still lists both; a
 * disconnect drops the agent from the browser's roster (relay re-broadcasts on
 * controller connect AND disconnect, not only when a claim is freed).
 */
/**
 * Path sandbox (src/utils/paths.ts, enforced in src/server.ts before tool.handle).
 * Validation happens server-side, so a rejected call never reaches the browser —
 * the fake browser here only proves the ACCEPTED cases got through.
 */
// ── perf trace: reload / autoStop wiring (C21) ────────────────────────────────
// The harness drives a FAKE browser, so the double-start guard and the real
// reload/load-complete behaviour cannot be exercised here — they live in the
// extension and are covered by the manual checks. What IS testable is the
// server half: that the flags reach the browser, and that an autoStopped reply
// is written to disk and reported as a finished trace rather than as "started".
async function runPerfTrace() {
  const RS = 9132;
  const RE = 9134;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    AUTOMATE_BROWSER_CLIENT_NAME: "TraceA",
  };
  const c = makeController(env);
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("perf: relay came up (isolated range)", false);
    c.kill();
    return;
  }
  assert("perf: relay came up (isolated range)", true);
  await initController(c);

  // Answer a start-with-autoStop the way the extension would: the finished trace.
  const browser = await makeClient(port, { browser: "chrome", label: "TraceBrowser" }, (msg) =>
    msg.type === "browser_perf_trace" && msg.payload?.autoStop
      ? {
          events: [{ ts: 1000 }, { ts: 3000 }],
          durationMs: 2,
          eventCount: 2,
          autoStopped: true,
          loadComplete: true,
        }
      : undefined,
  );
  await sleep(300);

  const out = path.join(os.tmpdir(), `ab-smoke-trace-${Date.now()}.json`);
  const res = await c.rpc("tools/call", {
    name: "browser_perf_trace",
    arguments: { action: "start", reload: true, autoStop: true, filePath: out },
  });

  const sent = browser.msgs.find((m) => m.type === "browser_perf_trace");
  assert(
    "perf: reload + autoStop reach the browser on start",
    !!sent && sent.payload?.reload === true && sent.payload?.autoStop === true,
  );
  assert(
    "perf: an autoStopped start reports a finished trace, not a started one",
    ok(res) && /Trace stopped at load-complete/.test(callText(res)),
  );
  assert(
    "perf: the autoStopped trace is written to the requested file",
    fs.existsSync(out) && Array.isArray(JSON.parse(fs.readFileSync(out, "utf8")).traceEvents),
  );

  try {
    fs.rmSync(out, { force: true });
  } catch {}
  try {
    browser.ws.close();
  } catch {}
  c.kill();
}

/**
 * Console-delta footer (C3a): a mutating tool that leaves NEW console errors gets
 * one extra line; a read-only tool never does; nothing new means no line; the
 * env opt-out silences it; and a console probe that never answers must not turn
 * a successful click into an error.
 */
async function runDeltaFooter() {
  const RS = 9135;
  const RE = 9137;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    // Keep the dropped-probe assertion quick (default is 2s).
    AUTOMATE_BROWSER_DELTA_FOOTER_MS: "700",
  };
  const c = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "DeltaA" });
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("delta: relay came up (isolated range)", false);
    c.kill();
    return;
  }
  assert("delta: relay came up (isolated range)", true);
  await initController(c);

  // The page's console ring buffer, as the extension would report it. Timestamps
  // are real `Date.now()` values so they sit after the controller's seed mark.
  let logs = [];
  let dropProbe = false;
  let issuesReply = null;
  const consoleReply = (msg) => {
    if (msg.type === "browser_issues") return issuesReply ?? undefined;
    if (msg.type !== "browser_get_console_logs") return undefined;
    return dropProbe ? NO_REPLY : logs;
  };
  const browser = await makeClient(
    port,
    { browser: "chrome", label: "DeltaBrowser" },
    consoleReply,
  );
  await sleep(300);

  const click = () =>
    c.rpc("tools/call", { name: "browser_click", arguments: { element: "the button", ref: "e1" } });
  const footerText = (res) => (res?.result?.content ?? []).map((p) => p.text || "").join(" | ");

  logs = [{ level: "error", ts: Date.now(), text: "boom" }];

  // Read-only first: it must not consume the delta, so the click below still sees it.
  const ro = await c.rpc("tools/call", { name: "browser_get_console_logs", arguments: {} });
  assert(
    "delta: read-only tool gets no footer",
    ok(ro) && !/new console error/.test(footerText(ro)),
  );

  const first = await click();
  assert(
    "delta: a mutating tool reports the new console error",
    ok(first) && /⚠ 1 new console error since this action/.test(footerText(first)),
  );

  const second = await click();
  assert(
    "delta: no footer when nothing new errored",
    ok(second) && !/new console error/.test(footerText(second)),
  );

  logs = [...logs, { level: "warn", ts: Date.now(), text: "just a warning" }];
  const warned = await click();
  assert(
    "delta: a new warning is not counted as an error",
    ok(warned) && !/new console error/.test(footerText(warned)),
  );

  logs = [...logs, { level: "error", ts: Date.now(), text: "boom 2" }];
  const third = await click();
  assert(
    "delta: only errors newer than the mark are counted",
    ok(third) && /⚠ 1 new console error since this action/.test(footerText(third)),
  );

  // A console probe that never answers must degrade to "no footer", not an error.
  dropProbe = true;
  logs = [...logs, { level: "error", ts: Date.now(), text: "boom 3" }];
  const dropped = await click();
  dropProbe = false;
  assert(
    "delta: a console-probe failure does not fail the tool",
    ok(dropped) &&
      /Clicked/.test(footerText(dropped)) &&
      !/new console error/.test(footerText(dropped)),
  );

  // ── C5: a thrown error carries its stack, rendered in its own section ──────
  // Last in the group so it cannot perturb the delta assertions above (reading
  // the console is read-only, so it neither adds a footer nor advances the mark).
  logs = [
    { level: "log", ts: Date.now(), text: "ordinary line" },
    {
      level: "error",
      ts: Date.now(),
      text: "boom (https://x.test/app.js:4:11)",
      kind: "uncaught",
      source: "https://x.test/app.js:4:11",
      stack: "Error: boom\n    at go (https://x.test/app.js:4:11)",
    },
  ];
  const stacked = callText(
    await c.rpc("tools/call", { name: "browser_get_console_logs", arguments: {} }),
  );
  assert(
    "console: a thrown error is reported with its stack in its own section",
    /--- Thrown errors with stacks \(1\) ---/.test(stacked) &&
      /at go \(https:\/\/x\.test\/app\.js:4:11\)/.test(stacked),
  );
  // The stack belongs in the section, NOT inlined into the chronological dump —
  // a multi-frame stack on a JSON line is what makes a console log unreadable.
  assert(
    "console: the chronological lines keep the stack out and stay intact",
    /"text":"ordinary line"/.test(stacked.split("--- Thrown errors")[0]) &&
      !/"stack"/.test(stacked.split("--- Thrown errors")[0]),
  );

  // ── C4: browser_issues reports what leaves no console error ───────────────
  // Read-only, so like the console read above it cannot perturb the delta state.
  issuesReply = {
    issues: [
      {
        source: "page",
        kind: "csp-violation",
        ts: Date.now(),
        text: 'CSP blocked (inline) — violated "script-src-elem"',
      },
      {
        source: "network",
        kind: "http-403",
        ts: Date.now(),
        text: "GET https://x.test/api returned 403",
        url: "https://x.test/api",
      },
    ],
    dropped: 0,
    capturedNetwork: true,
  };
  const iss = await c.rpc("tools/call", { name: "browser_issues", arguments: {} });
  assert(
    "issues: page and network issues are reported together",
    ok(iss) &&
      /\[csp-violation\] CSP blocked \(inline\)/.test(callText(iss)) &&
      /\[http-403\] GET https:\/\/x\.test\/api returned 403/.test(callText(iss)),
  );
  // A clean page and a browser that never captured are very different states, and
  // reporting them identically would send an agent looking for a bug that is not there.
  issuesReply = { issues: [], dropped: 0, capturedNetwork: false };
  const noCap = await c.rpc("tools/call", { name: "browser_issues", arguments: {} });
  assert(
    "issues: an uncaptured network log is called out, not silently read as clean",
    ok(noCap) &&
      /no issues detected/.test(callText(noCap)) &&
      /network capture is unavailable/i.test(callText(noCap)),
  );
  // Read-only, so it must never carry the mutating-call footer.
  assert("issues: read-only, so no delta footer", !/new console error/.test(footerText(iss)));

  // ── the footer's issues half: a blocked/failed request is NOT a console error,
  // so it gets its own line pointing at the tool that can actually show it ─────
  issuesReply = {
    issues: [
      {
        source: "network",
        kind: "http-500",
        ts: Date.now(),
        text: "GET https://x.test/a returned 500",
        url: "https://x.test/a",
      },
    ],
    dropped: 0,
    capturedNetwork: true,
  };
  const withIssue = await click();
  assert(
    "delta: a mutating tool reports a new browser issue on its own line",
    ok(withIssue) &&
      /⚠ 1 new browser issue since this action/.test(footerText(withIssue)) &&
      /call browser_issues for details/.test(footerText(withIssue)),
  );
  const noNewIssue = await click();
  assert(
    "delta: no issue footer when nothing new appeared",
    ok(noNewIssue) && !/new browser issue/.test(footerText(noNewIssue)),
  );
  issuesReply = null;

  // ── C10/C9/C11a/C6: the new options reach the browser as sent ─────────────
  browser.msgs.length = 0;
  const reloaded = await c.rpc("tools/call", {
    name: "browser_navigate",
    arguments: { reload: true, ignoreCache: true, includeSnapshot: false },
  });
  const navMsg = browser.msgs.find((m) => m.type === "browser_navigate");
  assert(
    "stage4: reload + ignoreCache reach the browser and report a reload, not a navigation",
    ok(reloaded) &&
      callText(reloaded).includes("Reloaded (cache bypassed)") &&
      navMsg?.payload?.reload === true &&
      navMsg?.payload?.ignoreCache === true,
  );

  // A reload has nothing to point at, and a url plus reload is two intentions in
  // one call — both are refused before anything reaches the browser.
  browser.msgs.length = 0;
  const both = await c.rpc("tools/call", {
    name: "browser_navigate",
    arguments: { url: "https://x.test/", reload: true },
  });
  const neither = await c.rpc("tools/call", { name: "browser_navigate", arguments: {} });
  assert(
    "stage4: url+reload and neither-of-them are both refused, without reaching the browser",
    isErr(both) && isErr(neither) && !browser.msgs.some((m) => m.type === "browser_navigate"),
  );

  browser.msgs.length = 0;
  const initNav = await c.rpc("tools/call", {
    name: "browser_navigate",
    arguments: {
      url: "https://x.test/",
      initScript: "window.__x = 1",
      handleBeforeUnload: "accept",
      includeSnapshot: false,
    },
  });
  const initMsg = browser.msgs.find((m) => m.type === "browser_navigate");
  assert(
    "stage4: initScript and handleBeforeUnload are forwarded verbatim",
    ok(initNav) &&
      initMsg?.payload?.initScript === "window.__x = 1" &&
      initMsg?.payload?.handleBeforeUnload === "accept",
  );

  browser.msgs.length = 0;
  const verbose = await c.rpc("tools/call", {
    name: "browser_snapshot",
    arguments: { verbose: true },
  });
  const snapMsg = browser.msgs.find((m) => m.type === "browser_snapshot_full");
  assert(
    "stage4: snapshot verbose is forwarded to the browser",
    ok(verbose) && snapMsg?.payload?.verbose === true,
  );

  // browser_release_client must not silently re-claim via the footer probe.
  browser.received.length = 0;
  const rel = await c.rpc("tools/call", { name: "browser_release_client", arguments: {} });
  assert(
    "delta: release_client does not probe (would re-take the claim)",
    ok(rel) && !browser.received.includes("browser_get_console_logs"),
  );

  try {
    browser.ws.close();
  } catch {}
  c.kill();

  // ── env opt-out, on its own controller ──────────────────────────────────────
  const off = makeController({
    ...env,
    AUTOMATE_BROWSER_CLIENT_NAME: "DeltaOff",
    AUTOMATE_BROWSER_DELTA_FOOTER: "off",
  });
  await initController(off);
  let offLogs = [];
  const offBrowser = await makeClient(
    port,
    { browser: "chrome", label: "DeltaOffBrowser" },
    (msg) => (msg.type === "browser_get_console_logs" ? offLogs : undefined),
  );
  await sleep(300);
  offLogs = [{ level: "error", ts: Date.now(), text: "boom" }];
  offBrowser.received.length = 0;
  const suppressed = await off.rpc("tools/call", {
    name: "browser_click",
    arguments: { element: "the button", ref: "e1" },
  });
  assert(
    "delta: AUTOMATE_BROWSER_DELTA_FOOTER=off suppresses the footer (and the probe)",
    ok(suppressed) &&
      !/new console error/.test(footerText(suppressed)) &&
      !offBrowser.received.includes("browser_get_console_logs"),
  );

  try {
    offBrowser.ws.close();
  } catch {}
  off.kill();
}

/**
 * The `automate-browser` CLI (C2): it is a controller like any MCP server, so it
 * must join the SAME relay mesh an IDE is on — visible to the IDE's peers, and
 * seeing the IDE in its own status — dispatch an alias to the browser, and exit
 * 1 on an unknown command instead of hanging or exiting 0.
 */
async function runCli() {
  const RS = 9138;
  const RE = 9140;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    AUTOMATE_BROWSER_CLIENT_NAME: "SmokeIDE",
  };
  // The CLI must pick its OWN default name, so never inherit the IDE's.
  const cliEnv = { ...env };
  delete cliEnv.AUTOMATE_BROWSER_CLIENT_NAME;

  /** Run one `dist/cli.js` invocation to completion. */
  const runCliCmd = (args) =>
    new Promise((resolve) => {
      const child = spawn("node", ["dist/cli.js", ...args], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: cliEnv,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  const c = makeController(env);
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("cli: relay came up (isolated range)", false);
    c.kill();
    return;
  }
  assert("cli: relay came up (isolated range)", true);
  await initController(c);

  const browser = await makeClient(port, { browser: "chrome", label: "CliBrowser" });
  await sleep(300);

  const status = await runCliCmd(["status", "--json"]);
  let parsed;
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    parsed = undefined;
  }
  assert(
    "cli: status exits 0 and --json emits a parseable result",
    status.code === 0 && !!parsed && !!parsed.structuredContent,
  );
  assert(
    "cli: the CLI sees the connected IDE as a peer",
    !!parsed && (parsed.structuredContent.controllers || []).some((p) => p.name === "SmokeIDE"),
  );
  // Reverse direction: the relay pushed the CLI to the browser's agent roster,
  // which is what an IDE's peer list is built from — so the IDE sees it too.
  assert(
    "cli: registers as a peer under its default name (cli)",
    browser.agentsFrames.some((f) => (f.controllers || []).some((p) => p.name === "cli")),
  );

  browser.received.length = 0;
  const ev = await runCliCmd(["eval", "document.title"]);
  assert(
    "cli: an alias dispatches to the browser and exits 0",
    ev.code === 0 && browser.received.includes("browser_eval"),
  );

  const bad = await runCliCmd(["definitely-not-a-tool"]);
  assert(
    "cli: an unknown command exits 1 and names the alternatives",
    bad.code === 1 && /Unknown command/.test(bad.stderr) && /browser_status/.test(bad.stderr),
  );

  try {
    browser.ws.close();
  } catch {}
  c.kill();
}

/**
 * Relay/controller version mismatch (C25b): the relay is a singleton, so an IDE
 * on a different build can win the port race and own it. `browser_status` must
 * say so — and must stay quiet when the versions agree, or the warning is noise.
 */
async function runVersionMismatch() {
  /** Start `dist/relay.js` directly, so its reported version is ours to choose. */
  const startRelay = (rs, re, relayVersion) => {
    const env = {
      ...process.env,
      AUTOMATE_BROWSER_WS_PORT_RANGE: `${rs}-${re}`,
      AUTOMATE_BROWSER_TOKEN: TOKEN,
      AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    };
    if (relayVersion) env.AUTOMATE_BROWSER_RELAY_VERSION = relayVersion;
    return spawn("node", ["dist/relay.js"], { cwd: ROOT, stdio: "ignore", env });
  };

  /**
   * Ask a controller on this range for its status text. The relay link starts in
   * the BACKGROUND (so a slow relay can never block `initialize`), so poll until
   * status reports a connected relay rather than racing it with a fixed sleep.
   */
  const statusOn = async (rs, re) => {
    const c = makeController({
      ...process.env,
      AUTOMATE_BROWSER_WS_PORT_RANGE: `${rs}-${re}`,
      AUTOMATE_BROWSER_TOKEN: TOKEN,
      AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
      AUTOMATE_BROWSER_CLIENT_NAME: "VersionProbe",
    });
    await initController(c);
    let text = "";
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      text = callText(await c.rpc("tools/call", { name: "browser_status", arguments: {} }));
      if (/relay ws:\/\//.test(text)) break;
      await sleep(200);
    }
    c.kill();
    return text;
  };

  // ── mismatched: a relay that reports a version this build never had ──
  const oldRelay = startRelay(9141, 9143, "0.0.1-smoke");
  const port = await waitForRelayPort(9141, 9143);
  if (port == null) {
    assert("version: mismatched relay came up (isolated range)", false);
    try {
      oldRelay.kill();
    } catch {}
    return;
  }
  assert("version: mismatched relay came up (isolated range)", true);
  const mismatched = await statusOn(9141, 9143);
  assert(
    "version: browser_status warns when the relay is a different build",
    /Version mismatch/.test(mismatched) && /0\.0\.1-smoke/.test(mismatched),
  );
  try {
    oldRelay.kill();
  } catch {}

  // ── matching: same build on both ends means NO warning (not always-on) ──
  const sameRelay = startRelay(9144, 9146, null);
  const port2 = await waitForRelayPort(9144, 9146);
  if (port2 == null) {
    assert("version: matching relay came up (isolated range)", false);
    try {
      sameRelay.kill();
    } catch {}
    return;
  }
  assert("version: matching relay came up (isolated range)", true);
  const matching = await statusOn(9144, 9146);
  assert(
    "version: no warning when relay and controller agree",
    !/Version mismatch/.test(matching) && /relay ws:\/\//.test(matching),
  );
  try {
    sameRelay.kill();
  } catch {}
}

/**
 * Per-call `timeout` (C17) and the per-controller send queue (C18). Both are
 * about WHEN a call gives up and in what order calls leave, so they share one
 * relay and one deliberately slow fake browser. The delta footer is off here so
 * its probe does not add sends to the queue under test.
 */
async function runPerCall() {
  const RS = 9147;
  const RE = 9149;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    AUTOMATE_BROWSER_CLIENT_NAME: "PerCall",
    AUTOMATE_BROWSER_DELTA_FOOTER: "off",
  };
  const c = makeController(env);
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("percall: relay came up (isolated range)", false);
    c.kill();
    return;
  }
  assert("percall: relay came up (isolated range)", true);
  await initController(c);

  // A browser that never answers a hover, and answers the FIRST click only after
  // 400 ms — long enough that an unqueued second click would overtake it.
  const seen = [];
  let clicks = 0;
  // No initial value: every read of this is preceded by the reset at the start
  // of the concurrency case below, so an initialiser here would be dead.
  let firstAnswered;
  const browser = await makeClient(port, { browser: "chrome", label: "SlowBrowser" }, (msg) => {
    if (msg.type === "browser_hover") return NO_REPLY;
    if (msg.type !== "browser_click") return undefined;
    seen.push({ ref: msg.payload?.ref, at: Date.now() });
    if (++clicks === 1) {
      return sleep(400).then(() => {
        firstAnswered = Date.now();
        return { ok: true };
      });
    }
    return { ok: true };
  });
  await sleep(300);

  // ── C17: a small timeout gives up long before the 8s default would ──
  const startedAt = Date.now();
  const timed = await c.rpc("tools/call", {
    name: "browser_hover",
    arguments: { element: "a dead element", ref: "e1", timeout: 500 },
  });
  const elapsed = Date.now() - startedAt;
  assert(
    `percall: timeout:500 gives up in ${elapsed}ms, not the 8s default`,
    isErr(timed) && elapsed < 4000,
  );

  // C11b: browser_hover is blockedByDialog, and an open modal pauses the renderer
  // so the injected script never runs. A bare "Socket message timeout" leaves the
  // agent with no next step; the cause and the fix are named instead.
  assert(
    "percall: a dialog-blocked tool's timeout names the dialog as the likely cause",
    isErr(timed) &&
      callText(timed).includes("open alert/confirm/prompt") &&
      callText(timed).includes('"Leave site?" dialog') &&
      callText(timed).includes("browser_handle_dialog"),
  );

  // ── C18: two concurrent calls leave in order, the second only after the first ──
  seen.length = 0;
  clicks = 0;
  firstAnswered = 0;
  await Promise.all([
    c.rpc("tools/call", { name: "browser_click", arguments: { element: "first", ref: "e1" } }),
    c.rpc("tools/call", { name: "browser_click", arguments: { element: "second", ref: "e2" } }),
  ]);
  assert(
    "percall: two concurrent calls reach the browser in issue order",
    seen.length === 2 && seen[0].ref === "e1" && seen[1].ref === "e2",
  );
  assert(
    "percall: the second call waits for the first to finish, not just for its turn",
    seen.length === 2 && firstAnswered > 0 && seen[1].at >= firstAnswered,
  );

  // ── C18 deadlock guard: ONE handler that sends twice must not wedge the queue.
  // `browser_navigate` bundles a snapshot by default, so its handler issues a
  // second send while the client still awaits the first call. Raced against a
  // deadline so a deadlock reports as a FAIL instead of hanging the suite.
  browser.received.length = 0;
  const bundled = await Promise.race([
    c.rpc("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } }),
    sleep(8000).then(() => null),
  ]);
  assert(
    "percall: a handler that sends twice (navigate + bundled snapshot) does not deadlock",
    bundled !== null &&
      browser.received.includes("browser_navigate") &&
      browser.received.includes("browser_snapshot"),
  );

  try {
    browser.ws.close();
  } catch {}
  c.kill();
}

/**
 * Tool profiles (C1). These need no relay and no browser: `--print-tools` resolves
 * the selection and exits without constructing a Context. One `tools/list` call is
 * cross-checked against it, because "what the registry resolves" and "what an IDE
 * is actually served" are two different code paths that must not drift.
 */
const EXPECTED_FULL_TOOLS = 46; // bump DELIBERATELY when a tool is added — that is the point
const ALWAYS_ON = ["browser_status", "browser_list_clients", "browser_select_client"];

async function runProfiles() {
  const RS = 9150;
  const RE = 9152;

  /** Names `dist/index.js` would advertise, for a profile arg and/or an env value. */
  const toolNames = (arg, toolsEnv) =>
    new Promise((resolve) => {
      const env = {
        ...process.env,
        AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
        AUTOMATE_BROWSER_TOKEN: TOKEN,
      };
      delete env.AUTOMATE_BROWSER_TOOLS;
      if (toolsEnv !== undefined) env.AUTOMATE_BROWSER_TOOLS = toolsEnv;
      const child = spawn("node", ["dist/index.js", "--print-tools", ...(arg ? [arg] : [])], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("close", () => {
        try {
          resolve(JSON.parse(out).map((t) => t.name));
        } catch {
          resolve(null);
        }
      });
    });

  const full = await toolNames("full");
  const core = await toolNames("core");
  const slim = await toolNames("slim");
  const unset = await toolNames(null, undefined);
  const bogus = await toolNames(null, "not-a-real-profile");

  assert(
    `profiles: full serves ${EXPECTED_FULL_TOOLS} tools, unchanged by the registry`,
    !!full && full.length === EXPECTED_FULL_TOOLS,
  );
  assert(
    "profiles: an unset env serves exactly the full set",
    !!unset && !!full && unset.join(",") === full.join(","),
  );

  const isStrictSubset = (sub, sup) =>
    !!sub && !!sup && sub.length < sup.length && sub.every((n) => sup.includes(n));
  assert("profiles: core is a strict subset of full", isStrictSubset(core, full));
  assert("profiles: slim is a strict subset of full", isStrictSubset(slim, full));

  assert(
    "profiles: the always-on diagnostics survive every profile",
    [full, core, slim].every((list) => !!list && ALWAYS_ON.every((n) => list.includes(n))),
  );

  assert(
    "profiles: an unrecognised AUTOMATE_BROWSER_TOOLS falls back to full, never to empty",
    !!bogus && !!full && bogus.join(",") === full.join(","),
  );

  // Cross-check: the registry's answer and what tools/list actually serves are two
  // different paths (index.ts builds the server's array). They must not drift.
  const c = makeController({
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    AUTOMATE_BROWSER_TOOLS: "core",
    AUTOMATE_BROWSER_CLIENT_NAME: "ProfileProbe",
  });
  await initController(c);
  const listed = await c.rpc("tools/list", {});
  const served = ((listed && listed.result && listed.result.tools) || []).map((t) => t.name);
  assert(
    "profiles: tools/list serves exactly what the profile resolves (no drift)",
    !!core && served.join(",") === core.join(","),
  );

  // browser_status reports which profile is served, and it reaches the registry
  // through a CALL-TIME import — the registry has to import this tool in order
  // to serve it, so a static import back would be a load-time cycle. Nothing
  // asserted this line before, which is exactly why it needed asserting: a
  // regression in that import resolves to a missing line, not to an error.
  const st = await c.rpc("tools/call", { name: "browser_status", arguments: {} });
  const stText = ((st && st.result && st.result.content) || []).map((p) => p.text || "").join("\n");
  assert(
    "profiles: browser_status names the served profile and the env var that changes it",
    ok(st) &&
      new RegExp(`tools: ${core.length} of ${EXPECTED_FULL_TOOLS} — "core" profile`).test(stText) &&
      /AUTOMATE_BROWSER_TOOLS/.test(stText),
  );

  // D6 fallout: the DEFAULT audit path must not sit in a directory the OS sweeps.
  // This controller sets no AUTOMATE_BROWSER_AUDIT_FILE, so the path `browser_status`
  // prints here IS the shipped default. It lived in `os.tmpdir()` until 2026-09-02,
  // where nothing on the test machine survived 24 hours — silently voiding both the
  // README promise that "what did it touch?" is answerable AFTER something looks
  // wrong, and the rotation that keeps a predecessor. The relay traffic log moved for
  // the same reason: it is the only durable evidence of a browser dropping off, and
  // the one occurrence anyone wanted to read had already been deleted.
  const auditLine = (stText.match(/^audit: .*$/m) || [""])[0];
  const defaultAuditPath = auditLine
    .replace(/^audit: /, "")
    .replace(/ \(set .*$/, "")
    .trim();
  assert(
    "profiles: browser_status names the default audit file",
    /^audit: [^ ]/.test(auditLine) && defaultAuditPath.length > 0,
  );
  assert(
    "logs: the default audit trail is NOT written to the swept temp dir",
    defaultAuditPath.length > 0 &&
      !defaultAuditPath.toLowerCase().startsWith(os.tmpdir().toLowerCase()),
  );
  c.kill();
}

/**
 * Stage 8 — trace analysis (A6), the audit log (B10), the field-data key guard
 * (C8) and the relay's non-loopback refusal (C13).
 *
 * NO BROWSER is connected on purpose: every one of these paths must work — or
 * refuse — without one, and a `browser_perf_trace {action:"analyze"}` that
 * needed a browser would be a parser that could not parse a saved file.
 */
async function runStage8() {
  const auditFile = path.join(os.tmpdir(), `bmcp-smoke-audit-${process.pid}.log`);
  try {
    fs.rmSync(auditFile, { force: true });
  } catch {}

  const RS = 9198;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RS + 2}`,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    AUTOMATE_BROWSER_CLIENT_NAME: "Stage8",
    AUTOMATE_BROWSER_AUDIT_FILE: auditFile,
    // No browser will ever connect here, so a tool that needs one must fail
    // fast rather than sitting out the 30s default.
    AUTOMATE_BROWSER_CONNECT_WAIT_MS: "300",
  };
  delete env.AUTOMATE_BROWSER_CRUX_KEY;
  delete env.AUTOMATE_BROWSER_TOKEN;

  const c = makeController(env);
  await initController(c);

  // ── A6: the analyzer runs over a synthetic trace, through the real tool ────
  // Microsecond timestamps, as Chrome emits them: navigationStart at 1 000 000,
  // FCP 500 ms later, two LCP candidates (the LAST one wins), three layout
  // shifts of which ONE is user-initiated and must be excluded, three
  // EventTimings of which only two are real interactions, and two tasks.
  const us = (ms) => 1000000 + ms * 1000;
  const trace = {
    traceEvents: [
      { name: "navigationStart", ts: us(0), ph: "R" },
      { name: "firstContentfulPaint", ts: us(500) },
      { name: "largestContentfulPaint::Candidate", ts: us(900), args: { data: { type: "image" } } },
      { name: "largestContentfulPaint::Candidate", ts: us(2600), args: { data: { type: "text" } } },
      { name: "LayoutShift", ts: us(1000), args: { data: { score: 0.05 } } },
      { name: "LayoutShift", ts: us(1100), args: { data: { score: 0.04 } } },
      { name: "LayoutShift", ts: us(1200), args: { data: { score: 9, had_recent_input: true } } },
      {
        name: "EventTiming",
        ts: us(1500),
        args: { data: { interactionId: 1, type: "pointerdown", duration: 40 } },
      },
      {
        name: "EventTiming",
        ts: us(1600),
        args: { data: { interactionId: 2, type: "click", duration: 620 } },
      },
      {
        name: "EventTiming",
        ts: us(1700),
        args: { data: { interactionId: 0, type: "mousemove", duration: 5000 } },
      },
      { name: "RunTask", ts: us(1800), dur: 120000, pid: 7, tid: 9 },
      { name: "RunTask", ts: us(1900), dur: 3000, pid: 7, tid: 9 },
      // A real Chrome emits ONE task under BOTH names, a microsecond and a few
      // tens of microseconds apart (measured 2026-08-30). Counting both listed
      // every long task twice, so a page read as twice as janky as it is.
      { name: "ThreadControllerImpl::RunTask", ts: us(1800) + 1, dur: 119972, pid: 7, tid: 9 },
      { name: "ThreadControllerImpl::RunTask", ts: us(1900) + 1, dur: 2985, pid: 7, tid: 9 },
    ],
  };
  const tracePath = path.join(os.tmpdir(), `bmcp-smoke-trace-${process.pid}.json`);
  fs.writeFileSync(tracePath, JSON.stringify(trace));

  const an = await c.rpc("tools/call", {
    name: "browser_perf_trace",
    arguments: { action: "analyze", filePath: tracePath },
  });
  const anText = callText(an);
  assert(
    "stage8: analyze reads a saved trace with NO browser connected",
    ok(an) && /Core Web Vitals/.test(anText),
  );
  assert(
    "stage8: LCP is the LAST candidate, in page time, rated against Google's thresholds",
    /LCP\s+2600ms — needs improvement/.test(anText),
  );
  assert("stage8: FCP is rated good", /FCP\s+500ms — good/.test(anText));
  assert(
    "stage8: INP is the worst REAL interaction, not the biggest EventTiming",
    /INP\s+620ms — poor/.test(anText),
  );
  assert(
    "stage8: CLS excludes the user-initiated shift (0.090, not 9.090)",
    /CLS\s+0\.090 — good/.test(anText),
  );
  assert(
    "stage8: the long task is listed and the short one is not",
    /120ms/.test(anText) && !/\b3ms\b/.test(anText),
  );
  assert(
    "stage8: one task emitted under BOTH of Chrome's task names is listed ONCE",
    (anText.match(/120ms/g) || []).length === 1,
    anText,
  );

  // A trace with no navigation must SAY these are not page-load numbers.
  const noNavPath = path.join(os.tmpdir(), `bmcp-smoke-trace2-${process.pid}.json`);
  fs.writeFileSync(
    noNavPath,
    JSON.stringify([
      { name: "largestContentfulPaint::Candidate", ts: us(100), args: { data: {} } },
    ]),
  );
  const an2 = await c.rpc("tools/call", {
    name: "browser_perf_trace",
    arguments: { action: "analyze", filePath: noNavPath },
  });
  assert(
    "stage8: no navigation in the trace is stated, not silently mismeasured",
    ok(an2) && /no navigation in this trace/.test(callText(an2)),
  );
  assert(
    "stage8: metrics the trace never carried are named as missing, not reported as zero",
    /not in this trace: FCP, CLS, INP/.test(callText(an2)),
  );

  const anBad = await c.rpc("tools/call", {
    name: "browser_perf_trace",
    arguments: { action: "analyze" },
  });
  assert(
    "stage8: analyze without filePath is refused, naming it",
    isErr(anBad) && /filePath/.test(callText(anBad)),
  );

  // ── A6 regressions from the first real-browser run (2026-08-27) ──────────
  // Both shipped broken, and neither was reachable from here until now.

  // A {reload:true} trace carries TWO navigationStarts — the outgoing page's
  // tail and the new load. Anchoring to the EARLIER one measures from a
  // navigation the trace was not recording: this fixture read LCP 4500ms/poor.
  const twoNavPath = path.join(os.tmpdir(), `bmcp-smoke-trace3-${process.pid}.json`);
  fs.writeFileSync(
    twoNavPath,
    JSON.stringify({
      traceEvents: [
        { name: "navigationStart", ts: us(0) },
        {
          name: "largestContentfulPaint::Candidate",
          ts: us(200),
          args: { data: { type: "text" } },
        },
        { name: "navigationStart", ts: us(4000) },
        { name: "firstContentfulPaint", ts: us(4300) },
        {
          name: "largestContentfulPaint::Candidate",
          ts: us(4500),
          args: { data: { type: "image" } },
        },
      ],
    }),
  );
  const an3 = await c.rpc("tools/call", {
    name: "browser_perf_trace",
    arguments: { action: "analyze", filePath: twoNavPath },
  });
  const an3Text = callText(an3);
  assert(
    "stage8: two navigationStarts anchor on the LAST, not the first",
    ok(an3) && /LCP\s+500ms — good/.test(an3Text) && /FCP\s+300ms — good/.test(an3Text),
  );

  // A page that never painted (hidden window) yields long tasks and NO vitals.
  // Those tasks used to be discarded along with them — throwing away the one
  // measurement such a trace can still legitimately make.
  const tasksPath = path.join(os.tmpdir(), `bmcp-smoke-trace4-${process.pid}.json`);
  fs.writeFileSync(
    tasksPath,
    JSON.stringify({
      traceEvents: [
        { name: "navigationStart", ts: us(0) },
        { name: "RunTask", ts: us(100), dur: 180000 },
        { name: "RunTask", ts: us(400), dur: 90000 },
        { name: "RunTask", ts: us(600), dur: 3000 },
      ],
    }),
  );
  const an4 = await c.rpc("tools/call", {
    name: "browser_perf_trace",
    arguments: { action: "analyze", filePath: tasksPath },
  });
  const an4Text = callText(an4);
  assert(
    "stage8: long tasks survive a trace with NO vitals, and it says why there are none",
    ok(an4) &&
      /180ms @100ms/.test(an4Text) &&
      /NOT VISIBLE/.test(an4Text) &&
      !/\b3ms\b/.test(an4Text),
  );

  // ── C8: inert without a key, and it says which one ────────────────────────
  const fd = await c.rpc("tools/call", {
    name: "browser_perf_field_data",
    arguments: { url: "https://example.com/" },
  });
  assert(
    "stage8: field data with no API key refuses by naming the env var",
    isErr(fd) && /AUTOMATE_BROWSER_CRUX_KEY/.test(callText(fd)),
  );

  // ── B10: the audit trail ──────────────────────────────────────────────────
  // A page-acting tool with a SECRET argument and no browser: it fails, and the
  // failure is exactly the entry the audit log exists to keep.
  await c.rpc("tools/call", {
    name: "browser_type",
    arguments: { element: "the password box", ref: "e1", text: "hunter2-never-logged" },
  });

  const st = await c.rpc("tools/call", { name: "browser_status", arguments: {} });
  const stText = callText(st);

  const auditRaw = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8") : "";
  const auditLines = auditRaw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    });
  assert("stage8: every tool call appends an audit line", auditLines.length >= 4);
  assert(
    "stage8: a refused call is audited as a FAILURE, not omitted",
    auditLines.some((l) => l.tool === "browser_type" && l.ok === false),
  );
  assert(
    "stage8: a secret argument NEVER reaches the audit file",
    !/hunter2-never-logged/.test(auditRaw) &&
      auditLines.some(
        (l) => l.tool === "browser_type" && /redacted 20 chars/.test(String(l.args && l.args.text)),
      ),
  );
  assert(
    "stage8: a non-secret argument is kept, so a line can be identified",
    auditLines.some((l) => l.tool === "browser_perf_trace" && typeof l.args.filePath === "string"),
  );
  assert(
    "stage8: browser_status names the audit file and shows a tail",
    ok(st) && stText.includes(auditFile) && /Recent actions/.test(stText),
  );
  assert("stage8: the tail carries no secret either", !/hunter2-never-logged/.test(stText));

  c.kill();
  try {
    fs.rmSync(tracePath, { force: true });
    fs.rmSync(noNavPath, { force: true });
    fs.rmSync(twoNavPath, { force: true });
    fs.rmSync(tasksPath, { force: true });
    fs.rmSync(auditFile, { force: true });
  } catch {}

  // ── C13: a relay asked to leave loopback with no token must NOT listen ────
  const refused = await new Promise((resolve) => {
    const noTokenEnv = {
      ...process.env,
      AUTOMATE_BROWSER_WS_PORT_RANGE: "9201-9201",
      AUTOMATE_BROWSER_RELAY_HOST: "0.0.0.0",
    };
    delete noTokenEnv.AUTOMATE_BROWSER_TOKEN;
    const child = spawn("node", ["dist/relay.js"], { cwd: ROOT, stdio: "ignore", env: noTokenEnv });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve(null);
    }, 5000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert("stage8: an off-loopback relay with no token refuses to start", refused === 1);

  const stillStarts = await new Promise((resolve) => {
    const child = spawn("node", ["dist/relay.js"], {
      cwd: ROOT,
      stdio: "ignore",
      env: {
        ...process.env,
        AUTOMATE_BROWSER_WS_PORT_RANGE: "9202-9202",
        AUTOMATE_BROWSER_RELAY_HOST: "127.0.0.1",
        AUTOMATE_BROWSER_RELAY_IDLE_MS: "1500",
      },
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve("alive");
    }, 1500);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve("exited");
    });
  });
  assert("stage8: a loopback relay still starts normally", stillStarts === "alive");
}

/**
 * Stable-signature refs (B12). Hermetic: no relay, no browser, no Context.
 *
 * `chrome.scripting.executeScript` serialises an injected function BY SOURCE, so
 * driver.ts's snapshot walk and content-ops.ts's find walk physically cannot share
 * the ref derivation — there are two verbatim copies and DRIFT is the failure mode
 * the duplication creates. So the first assertion compares the two copies byte for
 * byte, and the rest execute the REAL extracted source (not a reimplementation of
 * it) against stub elements.
 */
async function runRefDerivation() {
  // Normalise line endings: these files are checked out CRLF on Windows and the
  // markers below are written LF.
  const readSrc = (rel) =>
    fs.readFileSync(path.join(ROOT, rel), "utf8").split(String.fromCharCode(13)).join("");

  /** Pull a source span out of an extension file by its start/end markers. */
  const span = (src, from, to) => {
    const a = src.indexOf(from);
    if (a < 0) return null;
    const b = src.indexOf(to, a);
    return b < 0 ? null : src.slice(a, b + to.length);
  };
  const SIG_START = "const sigOf = (el: Element): string => {";
  const HASH_END = '.padStart(4, "0");\n  };';

  const driverBlock = span(
    readSrc("Chrome-extension/lib/automation/driver.ts"),
    SIG_START,
    HASH_END,
  );
  const findBlock = span(
    readSrc("Chrome-extension/lib/automation/content-ops.ts"),
    SIG_START,
    HASH_END,
  );

  // The ref RESOLVER is a third forced copy (refOpPage, findFn's refFor, and the
  // MAIN-world evaluator), for the same reason: `executeScript` serialises by
  // source. Same guard — compare them byte for byte rather than trusting anyone
  // to keep three copies in step by hand.
  const RESOLVER_START =
    "  const find = (ref: string, root: Document | ShadowRoot): HTMLElement | null => {";
  const RESOLVER_END = "    return null;\n  };";
  const driverSrc = readSrc("Chrome-extension/lib/automation/driver.ts");
  const firstResolver = span(driverSrc, RESOLVER_START, RESOLVER_END);
  const after = driverSrc.indexOf(RESOLVER_START, driverSrc.indexOf(RESOLVER_START) + 1);
  const secondResolver =
    after < 0 ? null : span(driverSrc.slice(after), RESOLVER_START, RESOLVER_END);
  assert(
    "refs: driver.ts carries the resolver twice (interaction + evaluator), byte-identical",
    !!firstResolver && !!secondResolver && firstResolver === secondResolver,
  );

  assert("refs: the derivation was found in both injected walks", !!driverBlock && !!findBlock);
  assert(
    "refs: driver.ts and content-ops.ts carry an IDENTICAL derivation (no drift)",
    !!driverBlock && driverBlock === findBlock,
  );

  // Strip the TS annotations so the real source can be executed as-is.
  const js = (t) =>
    (t || "")
      .replace(/\(el as HTMLAnchorElement\)/g, "(el)")
      .replace(/\(el: Element\)/g, "(el)")
      .replace(/\(s: string\)/g, "(s)")
      .replace(/\(n: string\)/g, "(n)")
      .replace(/\): string =>/g, ") =>")
      .replace(/<string, number>/g, "");

  const refForBlock = span(
    readSrc("Chrome-extension/lib/automation/driver.ts"),
    "const seen = new Map<string, number>();",
    'return "e" + h + (n ? "." + n : "");\n  };',
  );
  assert("refs: refFor was found in driver.ts", !!refForBlock);

  // A stub good enough for the derivation: it reads tagName, attributes and direct
  // text nodes, and nothing else.
  const make = (tag, attrs, text) => ({
    tagName: tag.toUpperCase(),
    getAttribute: (n) => (attrs && n in attrs ? attrs[n] : null),
    childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
  });

  const build = (els) => {
    const fn = new Function(
      "Node",
      "els",
      `${js(driverBlock)}\n${js(refForBlock)}\nreturn els.map(refFor);`,
    );
    return fn({ TEXT_NODE: 3 }, els);
  };

  const save = make("button", { type: "submit" }, "Save");
  const cancel = make("button", { type: "button" }, "Cancel");
  const save2 = make("button", { type: "submit" }, "Save");

  const first = build([save, cancel]);
  const second = build([save, cancel]);
  assert(
    "refs: the same element derives the same ref on a later walk",
    first.length === 2 && first[0] === second[0] && first[1] === second[1],
  );
  assert("refs: different elements derive different refs", first[0] !== first[1]);
  assert("refs: a ref is `e` + 4 base36 chars", /^e[a-z0-9]{4}$/.test(first[0]));

  const twins = build([save, save2]);
  assert(
    "refs: two elements with the same signature are ordered, not collided",
    twins[0] !== twins[1] && twins[1] === twins[0] + ".1",
  );

  // ── frame-scoped refs (B5) ────────────────────────────────────────────────
  // Pure worker-side logic, so it can be executed directly from its own source.
  const frameBlock = span(
    driverSrc,
    "const FRAME_REF = /^f(\\d+):(.+)$/;",
    "return { frameId, bare: parsed.map((p) => p.bare) };\n}",
  );
  assert("frames: the ref parser was found in driver.ts", !!frameBlock);
  const frameFns = frameBlock
    ? new Function(
        `${js(frameBlock)
          .replace(/\]!/g, "]") // TS non-null assertion, e.g. m[2]!
          .replace(/export function/g, "function")
          .replace(/: \{ frameId: number; bare: string \}/g, "")
          .replace(/: \{ frameId: number; bare: string\[\] \}/g, "")
          .replace(/\(ref: string\)/g, "(ref)")
          .replace(/\(refs: string\[\]\)/g, "(refs)")}\nreturn { parseRef, frameOf };`,
      )()
    : null;

  assert(
    "frames: a bare ref means the top frame, exactly as before B5",
    !!frameFns &&
      frameFns.parseRef("e7k2f").frameId === 0 &&
      frameFns.parseRef("e7k2f").bare === "e7k2f",
  );
  assert(
    "frames: an `fN:` ref routes to that frame and hands the plain ref to the page",
    !!frameFns &&
      frameFns.parseRef("f3:e7k2f").frameId === 3 &&
      frameFns.parseRef("f3:e7k2f").bare === "e7k2f",
  );
  // These two used to assert the OPPOSITE, and were wrong to (B07). A colon that
  // is not a frame prefix was "left alone" — which meant handed to the TOP frame
  // as a literal ref, so a mistyped frame number silently acted on a different
  // document. And a mixed-frame drag "targeted the named frame", which resolved
  // the OTHER ref inside that frame too, where a same-named element stood in for
  // the one the caller meant. Both are now refusals, and these are the gate that
  // says so.
  const refuses = (fn) => {
    try {
      fn();
      return false;
    } catch (e) {
      return /^BAD_ARGS: /.test(String(e && e.message));
    }
  };
  assert(
    "frames: a ref with a colon that is not a frame prefix is REFUSED, not retargeted",
    !!frameFns && refuses(() => frameFns.parseRef("weird:ref")),
  );
  assert(
    "frames: a malformed prefix is refused in every shape",
    !!frameFns &&
      ["f3:", "fx:e1a2", "f:e1a2", "frame3:e1a2"].every((r) => refuses(() => frameFns.parseRef(r))),
  );
  assert(
    "frames: a drag whose refs mix frames is REFUSED before injection",
    !!frameFns && refuses(() => frameFns.frameOf(["e1", "f4:e2"])),
  );
  assert(
    "frames: refs that agree on one frame still resolve, with the prefix off",
    !!frameFns &&
      frameFns.frameOf(["f4:e1", "f4:e2"]).frameId === 4 &&
      frameFns.frameOf(["f4:e1", "f4:e2"]).bare.join(",") === "e1,e2",
  );

  // THE property the whole item exists for: with the old `e1, e2, e3…` counter,
  // inserting one element renumbered every ref after it, so anything the agent had
  // cached silently pointed somewhere else.
  const inserted = build([save, make("a", { href: "/new" }, "New"), cancel]);
  assert(
    "refs: inserting an element does NOT renumber the refs around it",
    inserted[0] === first[0] && inserted[2] === first[1],
  );
}

/**
 * Stale-ref recovery + actionability (B2/B3), server side.
 *
 * The gate and the recovery RETRY live in the extension, in an injected page
 * function — a fake browser can only prove that the option left the server
 * correctly and that the reply was rendered correctly. The behaviour in Chrome is
 * checked in a real browser, outside this fake-browser suite.
 */
async function runActionability() {
  const RS = 9156;
  const RE = 9158;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    AUTOMATE_BROWSER_DELTA_FOOTER: "off", // keep the footer out of these assertions
  };
  const c = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "ActA" });
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("actionability: relay came up (isolated range)", false);
    c.kill();
    return;
  }
  assert("actionability: relay came up (isolated range)", true);
  await initController(c);

  let clickReply = { ok: true };
  // I04 needs the SAME lost-reply failure on a read as on a click, to show the
  // tool decides the answer. Driven from one browser, not two — a second client
  // on this relay would make every later call in this block ambiguous.
  let readReply;
  const browser = await makeClient(port, { browser: "chrome", label: "ActBrowser" }, (msg) =>
    msg.type === "browser_click"
      ? clickReply
      : msg.type === "browser_read_page"
        ? readReply
        : undefined,
  );
  await sleep(300);

  const click = () =>
    c.rpc("tools/call", {
      name: "browser_click",
      arguments: { element: "the button", ref: "e7k2f" },
    });
  const text = (res) => (res?.result?.content ?? []).map((p) => p.text || "").join(" | ");
  const lastClickPayload = () =>
    [...browser.msgs].reverse().find((m) => m.type === "browser_click")?.payload;

  // ── the gate is ON by default, so nothing is sent to disable it ────────────
  const plain = await click();
  assert(
    "actionability: on by default — no opt-out flag is sent to the browser",
    ok(plain) && lastClickPayload() && lastClickPayload().actionability === undefined,
  );

  // ── a recovered ref is REPORTED, not swallowed ────────────────────────────
  clickReply = { ok: true, recovered: true };
  const recovered = await click();
  assert(
    "actionability: a re-resolved stale ref is reported in the result",
    ok(recovered) &&
      /that ref had gone stale/.test(text(recovered)) &&
      /fresh browser_snapshot/.test(text(recovered)),
  );

  clickReply = { ok: true };
  const normal = await click();
  assert(
    "actionability: a normal click says nothing about re-resolution",
    ok(normal) && /Clicked/.test(text(normal)) && !/gone stale/.test(text(normal)),
  );

  // ── a browser-side refusal reaches the agent intact, with the failed check ─
  clickReply = {
    __error:
      'Element "e7k2f" is not actionable: failed the "hit-testable" check after 1000ms. ' +
      'It is covered by <div#cookie-banner> "We use cookies".',
  };
  const refused = await click();
  const refusedText = JSON.stringify(refused ?? {});
  assert(
    "actionability: a refusal names the failed check and what was covering the element",
    /hit-testable/.test(refusedText) && /cookie-banner/.test(refusedText),
  );

  clickReply = {
    __error:
      'STALE_REF: element ref "e7k2f" no longer exists on this page, and re-resolving it failed. ' +
      "Take a fresh browser_snapshot and use the new ref.",
  };
  const stale = await click();
  const staleText = JSON.stringify(stale ?? {});
  assert(
    "actionability: STALE_REF reaches the agent with its recovery action",
    /STALE_REF/.test(staleText) && /browser_snapshot/.test(staleText),
  );

  // ── B6: the taxonomy, on the same fixture ─────────────────────────────────
  // The extension prefixes its own failures with a code; the server adopts it
  // rather than re-recognising the prose. These assert that adoption, which is
  // the whole point of the code travelling on the wire.
  const staleStructured = stale?.result?.structuredContent;
  assert(
    "errors: a coded failure carries structuredContent {code, retryable}",
    !!staleStructured &&
      staleStructured.code === "STALE_REF" &&
      staleStructured.retryable === false,
  );
  assert("errors: the code is adopted, not doubled", !/STALE_REF: STALE_REF/.test(staleText));
  assert(
    "errors: a code with a known recovery names the tool to call",
    !!staleStructured && staleStructured.recover === "browser_snapshot",
  );

  // I04 — the same message, two different answers, decided by the tool.
  //
  // The request had already gone out when the link dropped, so for a CLICK
  // "usually transient — retry in a moment" was advice to click twice. It is now
  // reported as uncertain and NOT retryable. A read is untouched: repeating it
  // costs nothing, so it keeps the retry and the old wording.
  const lostReply = {
    __error:
      "Lost the connection to the AutomateBrowser relay (it may be restarting). " +
      "This is usually transient — retry in a moment.",
  };
  clickReply = lostReply;
  const transient = await click();
  assert(
    "errors: a click whose reply was lost is NOT advertised as safe to repeat",
    transient?.result?.structuredContent?.retryable === false,
  );
  assert(
    "errors: and says the action may already have taken effect",
    /MAY have taken effect/.test(text(transient)) && /browser_snapshot/.test(text(transient)),
  );

  readReply = lostReply;
  const readLost = await c.rpc("tools/call", {
    name: "browser_read_page",
    arguments: { format: "text" },
  });
  assert(
    "errors: a READ whose reply was lost keeps its retryable flag",
    readLost?.result?.structuredContent?.retryable === true &&
      !/MAY have taken effect/.test(text(readLost)),
  );
  readReply = undefined;

  clickReply = { __error: "Something nobody has classified yet." };
  const unmapped = await click();
  assert(
    "errors: an unmapped failure is passed through unchanged, not given an invented code",
    !unmapped?.result?.structuredContent &&
      /Something nobody has classified yet/.test(JSON.stringify(unmapped ?? {})),
  );

  // ── C19: browser_eval's function form ─────────────────────────────────────
  const evalCall = (a) => c.rpc("tools/call", { name: "browser_eval", arguments: a });
  const lastEval = () =>
    [...browser.msgs].reverse().find((m) => m.type === "browser_eval")?.payload;

  const fnRes = await evalCall({ function: "(el) => el.innerText", args: ["e7k2f"] });
  const fnPayload = lastEval();
  assert(
    "eval: the function form reaches the browser with its element refs",
    ok(fnRes) &&
      !!fnPayload &&
      fnPayload.function === "(el) => el.innerText" &&
      Array.isArray(fnPayload.args) &&
      fnPayload.args[0] === "e7k2f",
  );

  const exprRes = await evalCall({ expression: "document.title" });
  assert(
    "eval: the expression form is unchanged and carries no function/args",
    ok(exprRes) &&
      lastEval()?.expression === "document.title" &&
      lastEval()?.function === undefined,
  );

  // Argument validation is server-side, so these must never reach the browser.
  const beforeBoth = browser.msgs.filter((m) => m.type === "browser_eval").length;
  const both = await evalCall({ expression: "1", function: "() => 1" });
  assert(
    "eval: supplying both forms is refused, naming which to use",
    /not both/.test(JSON.stringify(both ?? {})) &&
      browser.msgs.filter((m) => m.type === "browser_eval").length === beforeBoth,
  );

  const orphanArgs = await evalCall({ expression: "1", args: ["e7k2f"] });
  assert(
    "eval: args without the function form is refused",
    /only applies to the `function` form/.test(JSON.stringify(orphanArgs ?? {})),
  );

  try {
    browser.ws.close();
  } catch {
    /* ignore */
  }
  c.kill();

  // ── the env opt-out actually reaches the browser ───────────────────────────
  // A separate controller: the flag is read from the server's environment, so it
  // cannot be toggled on a running one.
  const c2 = makeController({
    ...env,
    AUTOMATE_BROWSER_CLIENT_NAME: "ActB",
    AUTOMATE_BROWSER_ACTIONABILITY: "off",
  });
  await initController(c2);
  const browser2 = await makeClient(port, { browser: "chrome", label: "ActBrowser2" }, () => ({
    ok: true,
  }));
  await sleep(300);
  const offRes = await c2.rpc("tools/call", {
    name: "browser_click",
    arguments: { element: "the button", ref: "e7k2f" },
  });
  const offPayload = [...browser2.msgs].reverse().find((m) => m.type === "browser_click")?.payload;
  assert(
    "actionability: AUTOMATE_BROWSER_ACTIONABILITY=off reaches the browser as a payload flag",
    ok(offRes) && !!offPayload && offPayload.actionability === false,
  );
  try {
    browser2.ws.close();
  } catch {
    /* ignore */
  }
  c2.kill();
}

/**
 * Transient-failure retry (B4). The gate is `idempotentHint`, so the assertion
 * that matters is the PAIR: the same failure must be recovered for a read and
 * must still fail for a side effect.
 */
async function runTransientRetry() {
  const RS = 9159;
  const RE = 9161;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    AUTOMATE_BROWSER_DELTA_FOOTER: "off",
  };
  const c = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "RetryA" });
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("retry: relay came up (isolated range)", false);
    c.kill();
    return;
  }
  assert("retry: relay came up (isolated range)", true);
  await initController(c);

  // Fail the FIRST call of each type with a transient error, then behave.
  const failedOnce = new Set();
  const TRANSIENT =
    "Lost the connection to the AutomateBrowser relay (it may be restarting). " +
    "This is usually transient — retry in a moment.";
  const browser = await makeClient(port, { browser: "chrome", label: "RetryBrowser" }, (msg) => {
    if (!failedOnce.has(msg.type)) {
      failedOnce.add(msg.type);
      return { __error: TRANSIENT };
    }
    if (msg.type === "browser_read_page") {
      return { url: "https://example.com/", title: "Example", content: "hello", truncated: false };
    }
    return { ok: true };
  });
  await sleep(300);

  const text = (res) => (res?.result?.content ?? []).map((p) => p.text || "").join(" | ");

  // browser_read_page declares idempotentHint: true.
  const read = await c.rpc("tools/call", { name: "browser_read_page", arguments: {} });
  assert(
    "retry: an idempotent tool recovers from one transient failure",
    ok(read) && /hello/.test(text(read)),
  );
  assert(
    "retry: the recovery is reported, not silent",
    ok(read) && /automatic retry/.test(text(read)),
  );

  // browser_click declares idempotentHint: false — the same failure must stand.
  const clicked = await c.rpc("tools/call", {
    name: "browser_click",
    arguments: { element: "the button", ref: "e7k2f" },
  });
  const clickedText = JSON.stringify(clicked ?? {});
  assert(
    "retry: a NON-idempotent tool is not retried on the same failure",
    /Lost the connection/.test(clickedText) && !/automatic retry/.test(clickedText),
  );

  // A second read must not carry the note — the retry is per call, not sticky.
  const read2 = await c.rpc("tools/call", { name: "browser_read_page", arguments: {} });
  assert(
    "retry: a clean call says nothing about retrying",
    ok(read2) && /hello/.test(text(read2)) && !/automatic retry/.test(text(read2)),
  );

  try {
    browser.ws.close();
  } catch {
    /* ignore */
  }
  c.kill();
}

async function runPathSandbox() {
  const RS = 9129;
  const RE = 9131;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
  };
  let c = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "PathA" });
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("paths: relay came up (isolated range)", false);
    c.kill();
    return;
  }
  assert("paths: relay came up (isolated range)", true);
  await initController(c);
  const browser = await makeClient(port, { browser: "chrome", label: "PathBrowser" });
  await sleep(300);

  const upload = (p) =>
    c.rpc("tools/call", { name: "browser_upload_file", arguments: { ref: "e1", filePaths: [p] } });
  const rejected = (res) => isErr(res) && /Path not allowed/.test(callText(res));

  // No roots are negotiated by this harness, so the allow-list is cwd + tmpdir.
  const traversal = await upload("../../../etc/passwd");
  assert("paths: traversal (../../../etc/passwd) rejected", rejected(traversal));

  // The repo's PARENT is outside cwd and outside tmpdir on every platform.
  const outside = path.resolve(ROOT, "..", "automatebrowser-not-allowed.txt");
  const absolute = await upload(outside);
  assert("paths: absolute out-of-root rejected", rejected(absolute));

  // The refusal must name the roots so an agent can self-correct (subtask 5.9).
  const msg = callText(absolute).toLowerCase();
  const names = (p) => msg.includes(fs.realpathSync.native(p).toLowerCase());
  assert("paths: rejection names the allowed roots", names(ROOT) && names(os.tmpdir()));

  // tmpdir is always allowed, so the default perf-trace path keeps working.
  browser.received.length = 0;
  const inTmp = await upload(path.join(os.tmpdir(), "ab-smoke-upload.txt"));
  assert(
    "paths: tmpdir path accepted (reaches the browser)",
    ok(inTmp) && browser.received.includes("browser_upload_file"),
  );

  // C6: browser_snapshot gained a write path, so it must be gated by the same
  // choke point. A write path that skips it is exactly the hole Stage 1 closed.
  browser.received.length = 0;
  const snapOut = await c.rpc("tools/call", {
    name: "browser_snapshot",
    arguments: { filePath: outside },
  });
  assert(
    "paths: snapshot filePath outside the roots is refused before the tool runs",
    rejected(snapOut) && !browser.received.includes("browser_snapshot_full"),
  );

  // ── write-mode preflight (C15b): a bad save location must fail BEFORE the
  // tool runs, not after a minute of tracing is thrown away. perf_trace is the
  // only `write` param today; it is validated on any call that carries it.
  const trace = (filePath) =>
    c.rpc("tools/call", {
      name: "browser_perf_trace",
      arguments: { action: "start", filePath },
    });

  // A regular file where a directory must be — mkdir cannot succeed.
  const blocker = path.join(os.tmpdir(), `ab-smoke-blocker-${Date.now()}.txt`);
  fs.writeFileSync(blocker, "not a directory");
  browser.received.length = 0;
  const badParent = await trace(path.join(blocker, "trace.json"));
  assert(
    "paths: write with an unusable parent directory is refused before the tool runs",
    isErr(badParent) && !browser.received.includes("browser_perf_trace"),
  );
  assert(
    "paths: write refusal names the offending path",
    /Cannot write to/.test(callText(badParent)) &&
      callText(badParent).includes(path.dirname(path.join(blocker, "trace.json"))),
  );

  // A missing parent inside an allowed root is created, not refused.
  const freshDir = path.join(os.tmpdir(), `ab-smoke-trace-${Date.now()}`, "nested");
  browser.received.length = 0;
  const madeDir = await trace(path.join(freshDir, "trace.json"));
  assert(
    "paths: write creates a missing parent directory inside an allowed root",
    ok(madeDir) && fs.existsSync(freshDir) && browser.received.includes("browser_perf_trace"),
  );

  try {
    fs.rmSync(blocker, { force: true });
  } catch {}
  try {
    fs.rmSync(path.dirname(freshDir), { recursive: true, force: true });
  } catch {}

  // Escape hatch, on a fresh controller (the first one's claim is freed when it
  // exits, so this one can drive the same browser).
  c.kill();
  await sleep(400);
  c = makeController({
    ...env,
    AUTOMATE_BROWSER_CLIENT_NAME: "PathB",
    AUTOMATE_BROWSER_ALLOW_UNRESTRICTED_PATHS: "1",
  });
  await initController(c);
  browser.received.length = 0;
  const bypassed = await upload(outside);
  assert(
    "paths: ALLOW_UNRESTRICTED_PATHS=1 permits an out-of-root path",
    ok(bypassed) && browser.received.includes("browser_upload_file"),
  );

  try {
    browser.ws.close();
  } catch {}
  c.kill();
}

/**
 * Roster hardening: same-instance eviction (P0-C), the stale-controller reaper
 * (P0-D) and duplicate-name disambiguation (P0-E).
 *
 * Every peer here is a RAW socket rather than a `dist/index.js` child, because
 * all three behaviours are about what a controller sends and when. A raw socket
 * can hello with a chosen instanceId/pid/name, and — the case that matters for
 * the reaper — can fall silent while its TCP connection stays perfectly healthy,
 * which is exactly the wedged peer the WS-level ping/pong cannot catch. A real
 * controller pings every 15 s, so a stale window short enough for a fast test
 * would reap the honest peer too and prove nothing.
 *
 * The roster is read off the fake browser's `agents` pushes — the surface the
 * extension popup renders, i.e. what a user actually sees.
 */
/**
 * C3b — `include`: the fresh state arrives WITH the action that caused it.
 *
 * Attached at the one choke point, so these assertions are really about
 * `callTool`: that each section is its own labelled block, that a failing
 * section is a footnote rather than a failure of the action, that the console
 * block and the C3a footer read the SAME delta mark, and that an empty
 * `include` changes nothing at all.
 */
async function runInclude() {
  const RS = 9192;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RS + 2}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    AUTOMATE_BROWSER_CLIENT_NAME: "IncA",
  };
  const c = makeController(env);
  const port = await waitForRelayPort(RS, RS + 2);
  if (port == null) {
    assert("include: relay came up (isolated range)", false);
    c.kill();
    return;
  }
  assert("include: relay came up (isolated range)", true);
  await initController(c);

  let now = Date.now();
  const browser = await makeClient(port, { browser: "chrome", label: "IncBrowser" }, (msg) => {
    if (msg.type === "browser_get_console_logs") {
      return [
        { ts: now + 1, level: "error", text: "boom from the page" },
        { ts: now + 2, level: "log", text: "just a log" },
      ];
    }
    if (msg.type === "browser_network_requests") {
      return {
        captured: true,
        requests: [
          { method: "GET", url: "https://example.com/api", type: "fetch", status: 500, start: now },
        ],
      };
    }
    if (msg.type === "browser_snapshot_full" || msg.type === "browser_snapshot") {
      return {
        url: "https://example.com/",
        title: "Example",
        snapshot: "- button 'Save' [ref=e1]",
      };
    }
    if (msg.type === "getUrl") return "https://example.com/";
    if (msg.type === "getTitle") return "Example";
    return { ok: true };
  });
  await sleep(300);

  const click = (args) =>
    c.rpc("tools/call", {
      name: "browser_click",
      arguments: { element: "the button", ref: "e7k2f", ...args },
    });
  const text = (res) => (res?.result?.content ?? []).map((p) => p.text || "").join("\n");

  // No include: byte-for-byte today's behaviour. This is the control for the
  // whole item — a param nobody asked for must cost nobody anything.
  browser.received.length = 0;
  const plain = await click({});
  assert(
    "include: with no include, no section is attached and no snapshot is fetched",
    ok(plain) &&
      !/--- snapshot ---/.test(text(plain)) &&
      !/--- console/.test(text(plain)) &&
      !/--- network/.test(text(plain)) &&
      !browser.received.includes("browser_snapshot_full"),
  );

  now = Date.now() + 10_000; // fresh entries, past the delta mark
  const withConsole = await click({ include: "console" });
  assert(
    "include: the console block arrives in the SAME reply, labelled",
    ok(withConsole) &&
      /--- console \(2 new\) ---/.test(text(withConsole)) &&
      /boom from the page/.test(text(withConsole)),
  );
  // The footer and the block must read one mark: two would let them disagree
  // about what "new" means, and the agent would be told twice or not at all.
  assert(
    "include: the C3a footer still counts the same batch, not a second probe",
    /1 new console error/.test(text(withConsole)),
  );

  now = Date.now() + 20_000;
  const both = await click({ include: "snapshot, network" });
  assert(
    "include: several sections, each in its own labelled block",
    ok(both) && /--- snapshot ---/.test(text(both)) && /--- network \(1\) ---/.test(text(both)),
  );
  assert(
    "include: the network block shows status, method and url",
    /500 GET https:\/\/example\.com\/api/.test(text(both)),
  );

  browser.received.length = 0;
  const bad = await click({ include: "snapshot, consoel" });
  assert(
    "include: a misspelt section is refused, listing the real ones",
    isErr(bad) && /consoel/.test(text(bad)) && /network/.test(text(bad)),
  );
  // B04: the error text was never the problem. The CLICK was — it happened, and
  // then the call reported an error, so an agent that retried clicked twice.
  assert(
    "include: a misspelt section sends no click at all",
    !browser.received.includes("browser_click"),
  );
  assert(
    "include: a misspelt section costs no optional probes either",
    !browser.received.includes("browser_snapshot_full") &&
      !browser.received.includes("browser_get_console_logs") &&
      !browser.received.includes("browser_network_requests"),
  );

  try {
    browser.ws.close();
  } catch {}
  c.kill();
}

/**
 * A4 + A5 — emulation. One tool, two halves: geolocation and headers need no
 * debugger, the rest refuses with ADVANCED_MODE_REQUIRED until one is attached.
 *
 * The fake browser proves each option leaves the server in the shape the
 * extension expects, that `clear` is validated, and that the report renders.
 * Whether Chrome actually faked the position is a [User] check.
 */
async function runEmulate() {
  const RS = 9189;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RS + 2}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    AUTOMATE_BROWSER_DELTA_FOOTER: "off",
    AUTOMATE_BROWSER_CLIENT_NAME: "EmuA",
  };
  const c = makeController(env);
  const port = await waitForRelayPort(RS, RS + 2);
  if (port == null) {
    assert("emulate: relay came up (isolated range)", false);
    c.kill();
    return;
  }
  assert("emulate: relay came up (isolated range)", true);
  await initController(c);

  // Model the extension: the CDP-only options refuse when nothing is attached.
  const CDP_ONLY = ["colorScheme", "viewport", "userAgent", "network", "cpuThrottling"];
  const browser = await makeClient(port, { browser: "chrome", label: "EmuBrowser" }, (msg) => {
    if (msg.type !== "browser_emulate") return undefined;
    const p = msg.payload ?? {};
    const cdpAsked = CDP_ONLY.find((k) => p[k] !== undefined);
    if (cdpAsked) {
      return {
        __error: `ADVANCED_MODE_REQUIRED: ${cdpAsked} needs the debugger. Call browser_advanced_mode {enable:true} first.`,
      };
    }
    const active = {};
    if (p.geolocation) active.geolocation = p.geolocation;
    if (p.headers) active.headers = p.headers;
    return { active, applied: Object.keys(active) };
  });
  await sleep(300);

  const emu = (args) => c.rpc("tools/call", { name: "browser_emulate", arguments: args });
  const text = (res) => (res?.result?.content ?? []).map((p) => p.text || "").join(" | ");

  const geo = await emu({ geolocation: [51.5, -0.12] });
  const sent = browser.msgs.filter((m) => m.type === "browser_emulate").pop();
  assert(
    "emulate: a location reaches the browser as [lat, lon] and is reported in force",
    ok(geo) &&
      Array.isArray(sent.payload.geolocation) &&
      sent.payload.geolocation[0] === 51.5 &&
      /geolocation/.test(text(geo)),
  );

  const hdr = await emu({ headers: { "X-Test": "1" } });
  const hdrSent = browser.msgs.filter((m) => m.type === "browser_emulate").pop();
  assert(
    "emulate: extra headers reach the browser (no debugger involved)",
    ok(hdr) && hdrSent.payload.headers["X-Test"] === "1",
  );

  const dark = await emu({ colorScheme: "dark" });
  assert(
    "emulate: a CDP-only option is refused with ADVANCED_MODE_REQUIRED",
    isErr(dark) &&
      text(dark).startsWith("ADVANCED_MODE_REQUIRED:") &&
      /browser_advanced_mode/.test(text(dark)),
  );

  const vp = await emu({ viewport: [412, 915], mobile: true });
  const vpSent = browser.msgs.filter((m) => m.type === "browser_emulate").pop();
  assert(
    "emulate: the viewport leaves as [w, h] with its mobile flag",
    isErr(vp) && vpSent.payload.viewport[0] === 412 && vpSent.payload.mobile === true,
  );

  browser.received.length = 0;
  const bad = await emu({ clear: ["colourScheme"] });
  assert(
    "emulate: a misspelt clear name is refused, listing the real ones",
    isErr(bad) &&
      /colourScheme/.test(text(bad)) &&
      /cpuThrottling/.test(text(bad)) &&
      !browser.received.includes("browser_emulate"),
  );

  const clear = await emu({ clear: ["geolocation"] });
  const clearSent = browser.msgs.filter((m) => m.type === "browser_emulate").pop();
  assert(
    "emulate: a valid clear reaches the browser",
    ok(clear) && clearSent.payload.clear[0] === "geolocation",
  );

  const none = await emu({});
  assert(
    "emulate: no arguments reports what is in force rather than changing anything",
    ok(none) && /nothing emulated|In force/.test(text(none)),
  );

  try {
    browser.ws.close();
  } catch {}
  c.kill();
}

/**
 * D21 — accepting invalid TLS certificates — was DELETED on 2026-09-16.
 *
 * It could only ever fail: `chrome.debugger` hides the CDP `Security` domain from
 * extensions on every build measured. What is asserted here now is the REMOVAL,
 * and the removal has a shape worth pinning. Dropping the argument from the schema
 * is not enough on its own — the args object is not strict, so an unknown key is
 * silently discarded, and an agent working from six-month-old guidance would get
 * "advanced mode ON" back and conclude certificate checking was off. So the server
 * refuses it BY NAME, before any round-trip, and says what does work instead.
 */
async function runInsecureCerts() {
  const RS = 9195;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RS + 2}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    AUTOMATE_BROWSER_DELTA_FOOTER: "off",
    AUTOMATE_BROWSER_CLIENT_NAME: "CertA",
  };
  const c = makeController(env);
  const port = await waitForRelayPort(RS, RS + 2);
  if (port == null) {
    assert("certs: relay came up (isolated range)", false);
    c.kill();
    return;
  }
  assert("certs: relay came up (isolated range)", true);
  await initController(c);

  // Model the extension: a browser that answers the toggle, and records every
  // message it was sent so a refusal can be shown to cost no round-trip.
  const browser = await makeClient(port, { browser: "chrome", label: "CertBrowser" }, (msg) => {
    if (msg.type !== "browser_advanced_mode") return undefined;
    const p = msg.payload ?? {};
    return { enabled: p.enable !== false, attachedTabs: [7], tabId: 7 };
  });
  await sleep(300);

  const adv = (args) => c.rpc("tools/call", { name: "browser_advanced_mode", arguments: args });
  const text = (res) => (res?.result?.content ?? []).map((p) => p.text || "").join(" | ");
  const sentCount = () => browser.msgs.filter((m) => m.type === "browser_advanced_mode").length;
  const lastSent = () => browser.msgs.filter((m) => m.type === "browser_advanced_mode").pop();

  // ── the ordinary calls are untouched by the removal ──
  const on = await adv({ enable: true });
  assert("certs: a plain attach still works", /Advanced mode ON for tab 7/.test(text(on)));
  assert(
    "certs: and it carries no certificate wording at all any more",
    !/certificate/i.test(text(on)),
  );
  assert(
    "certs: nothing about certificates reaches the browser",
    lastSent()?.payload?.acceptInsecureCerts === undefined,
  );

  const status = await adv({});
  assert("certs: a status query still answers", /Advanced mode/.test(text(status)));

  // ── the removed argument is REFUSED by name, not silently dropped ──
  const before = sentCount();
  const gone = await adv({ enable: true, acceptInsecureCerts: true });
  assert(
    "certs: the removed acceptInsecureCerts is refused, naming BAD_ARGS",
    gone?.result?.isError === true && /BAD_ARGS/.test(text(gone)),
  );
  assert(
    "certs: the refusal says it never worked and why",
    /never worked/.test(text(gone)) && /Security domain/i.test(text(gone)),
  );
  assert(
    "certs: the refusal names the two routes that DO work",
    /--ignore-certificate-errors/.test(text(gone)) && /click through/i.test(text(gone)),
  );
  assert("certs: that refusal costs no round-trip to the browser", before === sentCount());

  // `false` is refused too. It reads as "put certificate checking back", which is
  // reassuring and false — there was never anything turned on to put back.
  const off = await adv({ acceptInsecureCerts: false });
  assert(
    "certs: even acceptInsecureCerts:false is refused rather than accepted as a no-op",
    off?.result?.isError === true && /BAD_ARGS/.test(text(off)),
  );

  try {
    browser.ws.close();
  } catch {}
  c.kill();
}

/**
 * A3 — element / webp / filePath screenshots.
 *
 * A fake browser cannot prove Chrome cropped the right pixels; it CAN prove the
 * ref and format left the server, that a filePath capture writes real bytes and
 * returns no image, and that the write goes through the Stage 1 sandbox. The
 * pixels are checked in a real browser, outside this suite.
 */
async function runShots() {
  const RS = 9186;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RS + 2}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    AUTOMATE_BROWSER_DELTA_FOOTER: "off",
    AUTOMATE_BROWSER_CLIENT_NAME: "ShotA",
  };
  const c = makeController(env);
  const port = await waitForRelayPort(RS, RS + 2);
  if (port == null) {
    assert("shots: relay came up (isolated range)", false);
    c.kill();
    return;
  }
  assert("shots: relay came up (isolated range)", true);
  await initController(c);

  // A 1x1 PNG, so the harness writes real image bytes rather than a placeholder.
  const PNG_1PX =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  // `fullPage` is the stand-in trigger for a debugger-rendered capture. A real
  // Chrome decides that from whether the tab is the foreground one of a drawn
  // window, which no payload field carries — but the thing under test is the
  // SERVER's handling of a reply that says viaDebugger, so any deterministic
  // trigger does. Everything else answers on the cheap path, as Chrome would.
  const browser = await makeClient(port, { browser: "chrome", label: "ShotBrowser" }, (msg) =>
    msg.type === "browser_screenshot"
      ? {
          data: PNG_1PX,
          mimeType: msg.payload?.format === "webp" ? "image/webp" : "image/png",
          ...(msg.payload?.ref ? { cropped: true } : {}),
          ...(msg.payload?.fullPage
            ? { viaDebugger: true, reason: "it is not the foreground tab of its window" }
            : {}),
        }
      : undefined,
  );
  await sleep(300);

  const shot = (args) => c.rpc("tools/call", { name: "browser_screenshot", arguments: args });
  const text = (res) => (res?.result?.content ?? []).map((p) => p.text || "").join(" | ");
  const parts = (res) => res?.result?.content ?? [];

  // Bare call: unchanged — an image, no text.
  const bare = await shot({});
  assert(
    "shots: a bare capture still returns the image, not a path",
    ok(bare) && parts(bare)[0].type === "image" && parts(bare)[0].mimeType === "image/png",
  );
  // The cheap path must stay byte-identical: no banner note bolted onto a
  // capture that never showed a banner.
  assert(
    "shots: a cheap-path capture carries NO debugger note",
    ok(bare) && parts(bare).length === 1,
  );

  // A debugger-rendered capture explains the banner the user just saw. Until
  // 2026-09-04 the extension reported viaDebugger + reason and the server threw
  // both away, so README and the shipped skill both promised a line that was
  // never emitted.
  const viaCdp = await shot({ fullPage: true });
  assert(
    "shots: a debugger-rendered capture says so, and names the reason",
    ok(viaCdp) &&
      parts(viaCdp).some((p) => p.type === "image") &&
      /being debugged/.test(text(viaCdp)) &&
      /not the foreground tab/.test(text(viaCdp)),
  );

  const viaCdpFile = await shot({
    fullPage: true,
    filePath: path.join(os.tmpdir(), `ab-smoke-shot-cdp-${Date.now()}.png`),
  });
  assert(
    "shots: the reason reaches structuredContent too, not just the prose",
    ok(viaCdpFile) &&
      viaCdpFile.result.structuredContent?.viaDebugger === true &&
      /not the foreground tab/.test(String(viaCdpFile.result.structuredContent?.reason ?? "")),
  );

  const byRef = await shot({ ref: "e7k2f" });
  const sent = browser.msgs.filter((m) => m.type === "browser_screenshot").pop();
  assert("shots: the element ref reaches the browser", ok(byRef) && sent.payload.ref === "e7k2f");

  const webp = await shot({ format: "webp", quality: 70 });
  const webpSent = browser.msgs.filter((m) => m.type === "browser_screenshot").pop();
  assert(
    "shots: webp is accepted and reaches the browser with its quality",
    ok(webp) &&
      webpSent.payload.format === "webp" &&
      webpSent.payload.quality === 70 &&
      parts(webp)[0].mimeType === "image/webp",
  );

  const out = path.join(os.tmpdir(), `ab-smoke-shot-${Date.now()}.png`);
  const toFile = await shot({ filePath: out });
  assert(
    "shots: filePath writes the real image bytes",
    ok(toFile) &&
      fs.existsSync(out) &&
      fs.readFileSync(out).slice(0, 8).toString("hex") === "89504e470d0a1a0a",
  );
  assert(
    "shots: with a filePath the reply carries the PATH and NO image",
    ok(toFile) && parts(toFile).every((p) => p.type !== "image") && text(toFile).includes(out),
  );

  // The write path must go through the Stage 1 choke point like every other one.
  browser.received.length = 0;
  const outside = path.resolve(ROOT, "..", "automatebrowser-not-allowed.png");
  const refused = await shot({ filePath: outside });
  assert(
    "shots: a filePath outside the roots is refused BEFORE the capture runs",
    isErr(refused) &&
      /Path not allowed/.test(text(refused)) &&
      !browser.received.includes("browser_screenshot"),
  );

  try {
    fs.rmSync(out, { force: true });
  } catch {}
  try {
    browser.ws.close();
  } catch {}
  c.kill();
}

/**
 * A2 — coordinate click. `browser_click` takes a POINT as an alternative
 * address, so a canvas/map/PDF that no snapshot ref can reach is driveable.
 *
 * The fake browser can prove the coordinate LEFT the server intact and that the
 * hit report was rendered; whether Chrome's elementFromPoint found the right
 * thing is checked in a real browser, outside this suite.
 */
async function runClickAt() {
  const RS = 9183;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RS + 2}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    AUTOMATE_BROWSER_DELTA_FOOTER: "off",
    AUTOMATE_BROWSER_CLIENT_NAME: "PointA",
  };
  const c = makeController(env);
  const port = await waitForRelayPort(RS, RS + 2);
  if (port == null) {
    assert("clickat: relay came up (isolated range)", false);
    c.kill();
    return;
  }
  assert("clickat: relay came up (isolated range)", true);
  await initController(c);
  const browser = await makeClient(port, { browser: "chrome", label: "PointBrowser" }, (msg) =>
    msg.type === "browser_click" ? { ok: true, hit: "<canvas#board>" } : undefined,
  );
  await sleep(300);

  const call = (args) => c.rpc("tools/call", { name: "browser_click", arguments: args });
  const text = (res) => (res?.result?.content ?? []).map((p) => p.text || "").join(" | ");

  const at = await call({ x: 120, y: 340 });
  const sent = browser.msgs.filter((m) => m.type === "browser_click").pop();
  assert(
    "clickat: the coordinate reaches the browser intact",
    ok(at) && !!sent && sent.payload.x === 120 && sent.payload.y === 340,
  );
  assert(
    "clickat: the result names the point AND what was under it",
    /\(120, 340\)/.test(text(at)) && /canvas#board/.test(text(at)),
  );

  const dbl = await call({ x: 10, y: 10, dblClick: true });
  const dblSent = browser.msgs.filter((m) => m.type === "browser_click").pop();
  assert(
    "clickat: dblClick leaves the server as a payload flag and is reported",
    ok(dbl) && dblSent.payload.dblClick === true && /Double-clicked/.test(text(dbl)),
  );

  // The ref form is unchanged — that is the half that must not regress.
  browser.received.length = 0;
  const byRef = await call({ element: "the button", ref: "e7k2f" });
  const refSent = browser.msgs.filter((m) => m.type === "browser_click").pop();
  assert(
    "clickat: the ref form still works and sends no coordinates",
    ok(byRef) &&
      /Clicked "the button"/.test(text(byRef)) &&
      refSent.payload.ref === "e7k2f" &&
      refSent.payload.x === undefined,
  );

  browser.received.length = 0;
  const neither = await call({ element: "something" });
  assert(
    "clickat: neither address is refused, naming both ways to address it",
    isErr(neither) &&
      /ref/.test(text(neither)) &&
      /x/.test(text(neither)) &&
      !browser.received.includes("browser_click"),
  );

  browser.received.length = 0;
  const both = await call({ element: "the button", ref: "e7k2f", x: 5, y: 5 });
  assert(
    "clickat: giving both addresses is refused before the tool runs",
    isErr(both) && !browser.received.includes("browser_click"),
  );

  try {
    browser.ws.close();
  } catch {}
  c.kill();
}

/**
 * Stage 6 coverage the feature runners could not reach on their own: the
 * taxonomy round-trip (8.1), retryable-vs-transient being ONE set (8.2), the
 * lease-loss notice naming the tab and the taker (8.3), and browser_downloads
 * rendering a listing (8.6).
 */
async function runStage6() {
  const errSrc = fs.readFileSync(path.join(ROOT, "src/tools/errors.ts"), "utf8");

  // ── 8.2: read the ONE definition of "transient" out of the source, so a
  // phrase added there without being honoured fails here instead of silently
  // never retrying. A second hardcoded copy would drift, which is the exact
  // fault this assertion exists to prevent.
  const transientBlock = errSrc.slice(
    errSrc.indexOf("export const TRANSIENT_FAILURES"),
    errSrc.indexOf("] as const;", errSrc.indexOf("export const TRANSIENT_FAILURES")),
  );
  const PHRASES = [...transientBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert("stage6: the transient set was read from errors.ts", PHRASES.length >= 5);

  // ── 8.1: every code that HAS a recovery, read from the same source.
  const recoverBlock = errSrc.slice(
    errSrc.indexOf("const RECOVER:"),
    errSrc.indexOf("};", errSrc.indexOf("const RECOVER:")),
  );
  const RECOVER = [...recoverBlock.matchAll(/^\s*([A-Z_]+): "([a-z_]+)"/gm)].map((m) => ({
    code: m[1],
    tool: m[2],
  }));
  assert("stage6: the recovery map was read from errors.ts", RECOVER.length >= 4);

  const RS = 9177;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RS + 2}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    AUTOMATE_BROWSER_DELTA_FOOTER: "off",
    AUTOMATE_BROWSER_CLIENT_NAME: "Stage6A",
  };
  const c = makeController(env);
  const port = await waitForRelayPort(RS, RS + 2);
  if (port == null) {
    assert("stage6: relay came up (isolated range)", false);
    c.kill();
    return;
  }
  assert("stage6: relay came up (isolated range)", true);
  await initController(c);

  // The fake browser fails the next read_page with whatever we arm, then behaves.
  let armed = null;
  const browser = await makeClient(port, { browser: "chrome", label: "Stage6Browser" }, (msg) => {
    if (msg.type === "browser_read_page") {
      if (armed) {
        const e = armed;
        armed = null;
        return { __error: e };
      }
      return { url: "https://example.com/", title: "Example", content: "hello", truncated: false };
    }
    if (msg.type === "browser_downloads") {
      return {
        downloads: [
          {
            id: 7,
            filename: "C:/tmp/report.pdf",
            url: "https://example.com/report.pdf",
            mime: "application/pdf",
            bytes: 2048,
            totalBytes: 2048,
            state: "complete",
            startTime: "2026-08-26T00:00:00Z",
          },
        ],
      };
    }
    return { ok: true };
  });
  await sleep(300);

  const text = (res) => (res?.result?.content ?? []).map((p) => p.text || "").join(" | ");
  const read = () => c.rpc("tools/call", { name: "browser_read_page", arguments: {} });

  // ── 8.1 — every recoverable code round-trips with its hint intact ──────────
  let allCoded = true;
  for (const { code, tool } of RECOVER) {
    armed = `${code}: something went wrong`;
    const res = await read();
    const t = text(res);
    if (!(isErr(res) && t.startsWith(`${code}:`) && t.includes(`Recover: call ${tool}.`))) {
      allCoded = false;
      console.log(`  (stage6) ${code} rendered as: ${t}`);
    }
  }
  assert(
    `stage6: all ${RECOVER.length} recoverable codes round-trip with their Recover line`,
    allCoded,
  );

  // ── 8.2 — retryable and the transient set are provably the same set ────────
  let allRetried = true;
  for (const phrase of PHRASES) {
    armed = `Boom: ${phrase} (please retry)`;
    const res = await read();
    if (!(ok(res) && /automatic retry/.test(text(res)))) {
      allRetried = false;
      console.log(`  (stage6) not retried: "${phrase}"`);
    }
  }
  assert(`stage6: every one of the ${PHRASES.length} transient phrases is retried`, allRetried);
  // The control: a failure that is NOT in that set must stand, or the assertion
  // above would pass for a server that simply retried everything.
  armed = "Boom: a failure nobody classified as transient";
  const stands = await read();
  assert(
    "stage6: a failure outside the transient set is NOT retried (control)",
    isErr(stands) && !/automatic retry/.test(text(stands)),
  );

  // ── 8.6 — browser_downloads reaches the browser and renders a listing ──────
  browser.received.length = 0;
  const dl = await c.rpc("tools/call", { name: "browser_downloads", arguments: {} });
  assert(
    "stage6: browser_downloads reaches the browser and renders the final path",
    ok(dl) &&
      browser.received.includes("browser_downloads") &&
      /complete/.test(text(dl)) &&
      /report\.pdf/.test(text(dl)),
  );
  const dlWait = await c.rpc("tools/call", {
    name: "browser_downloads",
    arguments: { wait: true, timeout: 5 },
  });
  const waitMsg = browser.msgs.filter((m) => m.type === "browser_downloads").pop();
  assert(
    "stage6: the wait option leaves the server as a payload flag",
    ok(dlWait) && waitMsg && waitMsg.payload.wait === true && waitMsg.payload.timeout === 5,
  );

  try {
    browser.ws.close();
  } catch {}
  c.kill();

  // ── 8.3 — the lease-loss notice names the TAB and the taker ────────────────
  const RS2 = 9180;
  const env2 = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS2}-${RS2 + 2}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
  };
  const la = makeController({ ...env2, AUTOMATE_BROWSER_CLIENT_NAME: "LossA" });
  const port2 = await waitForRelayPort(RS2, RS2 + 2);
  if (port2 == null) {
    assert("stage6: relay came up (lease-loss range)", false);
    la.kill();
    return;
  }
  assert("stage6: relay came up (lease-loss range)", true);
  await initController(la);
  const lb = makeController({ ...env2, AUTOMATE_BROWSER_CLIENT_NAME: "LossB" });
  await initController(lb);
  const lbrowser = await makeClient(port2, { browser: "chrome", label: "LossBrowser" }, (msg) =>
    msg.type === "browser_list_tabs"
      ? [{ index: 0, tabId: 4242, url: "https://a.example", title: "A", active: true }]
      : undefined,
  );
  await sleep(300);

  // A takes a lease on ONE specific tab, so the notice has a tab to name.
  await la.rpc("tools/call", { name: "browser_select_tab", arguments: { tabId: 4242 } });
  await la.rpc("tools/call", navArgs("https://a.example"));
  await lb.rpc("tools/call", { name: "browser_force_claim", arguments: { label: "LossBrowser" } });
  await sleep(200);

  // ANY tool, including one that drives nothing.
  const next = await la.rpc("tools/call", { name: "browser_list_tabs", arguments: {} });
  const t = (next?.result?.content ?? []).map((x) => x.text || "").join(" ");
  assert("stage6: the lease-loss notice names the tab that was taken", /tab 4242/.test(t));
  assert("stage6: the lease-loss notice names the taker", /LossB/.test(t));
  assert(
    "stage6: the lease-loss notice carries the LEASE_LOST code (8.3/3.5)",
    /LEASE_LOST/.test(t),
  );
  assert("stage6: it rides on a SUCCESSFUL result — a notice, not an error", ok(next));

  try {
    lbrowser.ws.close();
  } catch {}
  la.kill();
  lb.kill();
}

/**
 * B9 safety policy: origin allow/deny, the sensitive tier and read-only mode.
 *
 * Every assertion here has its negative control in the same run — an allow-list
 * that refuses proves nothing unless the SAME call on an allowed origin
 * succeeds, and "unset changes nothing" is the control for the whole feature.
 */
async function runSafety() {
  /** One isolated relay + controller + fake browser, with a policy env overlay. */
  async function withPolicy(RS, overlay, url) {
    const env = {
      ...process.env,
      AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RS + 2}`,
      AUTOMATE_BROWSER_TOKEN: TOKEN,
      AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
      AUTOMATE_BROWSER_CLIENT_NAME: "SafetyA",
      ...overlay,
    };
    const c = makeController(env);
    const port = await waitForRelayPort(RS, RS + 2);
    if (port == null) return null;
    await initController(c);
    // The fake browser answers the origin probe with whatever page we say it is on.
    const browser = await makeClient(port, { browser: "chrome", label: "SafetyBrowser" }, (msg) =>
      msg.type === "getUrl" ? url : undefined,
    );
    await sleep(300);
    return {
      c,
      browser,
      done: () => {
        try {
          browser.ws.close();
        } catch {}
        c.kill();
      },
    };
  }

  // Valid args on purpose: the gate runs BEFORE schema parsing, so a refusal
  // asserted with junk arguments would pass whether the gate fired or not.
  const click = (c) =>
    c.rpc("tools/call", { name: "browser_click", arguments: { element: "the button", ref: "e1" } });
  const blocked = (res, code) => isErr(res) && callText(res).startsWith(code + ":");

  // ── allow-list, on a page that is NOT in it ────────────────────────────────
  const ALLOW = "http://localhost:*";
  let s = await withPolicy(
    9162,
    { AUTOMATE_BROWSER_ALLOW_ORIGINS: ALLOW },
    "https://bank.example.com/accounts",
  );
  assert("safety: relay came up (allow-list range)", !!s);
  if (s) {
    s.browser.received.length = 0;
    const off = await click(s.c);
    assert(
      "safety: a drive outside the allow-list is refused with ORIGIN_BLOCKED",
      blocked(off, "ORIGIN_BLOCKED"),
    );
    assert(
      "safety: the refusal names the origin and the setting",
      /bank\.example\.com/.test(callText(off)) &&
        callText(off).includes("AUTOMATE_BROWSER_ALLOW_ORIGINS"),
    );
    assert(
      "safety: the refused action never reached the browser",
      !s.browser.received.includes("browser_click"),
    );
    // A navigation is judged on its DESTINATION, not on the page it is leaving.
    const nav = await s.c.rpc("tools/call", {
      name: "browser_navigate",
      arguments: { url: "https://evil.example.com/" },
    });
    assert(
      "safety: a navigation to a non-allowed origin is refused on its destination",
      blocked(nav, "ORIGIN_BLOCKED") && !s.browser.received.includes("browser_navigate"),
    );
    // ── B02: an address attached to the request is not where the call goes ──
    // The click parser discards an extra `url`, so before the fix the gate was
    // the ONLY thing that ever read it — and it read it as authorisation.
    s.browser.received.length = 0;
    const forged = await s.c.rpc("tools/call", {
      name: "browser_click",
      arguments: { element: "the button", ref: "e1", url: "http://localhost:3000/ok" },
    });
    assert(
      "safety: an allowed url attached to a click does not authorise the denied page",
      blocked(forged, "ORIGIN_BLOCKED") && /bank\.example\.com/.test(callText(forged)),
    );
    assert(
      "safety: the forged-url click never reached the browser",
      !s.browser.received.includes("browser_click"),
    );
    assert(
      "safety: the gate asked the browser where it was instead of believing the argument",
      s.browser.received.includes("getUrl"),
    );

    // A `url` that is a FILTER — matched against captured requests — is not a
    // destination either, and must not speak for the origin.
    s.browser.received.length = 0;
    const filter = await s.c.rpc("tools/call", {
      name: "browser_get_network_request",
      arguments: { url: "http://localhost:3000" },
    });
    assert(
      "safety: a url filter cannot masquerade as the page being driven",
      blocked(filter, "ORIGIN_BLOCKED"),
    );
    assert(
      "safety: the refused filter call never reached the browser",
      !s.browser.received.some((m) => m.startsWith("browser_get_network_request")),
    );

    // The ownership/diagnostic tools stay reachable, or the agent is stranded
    // with no way to ask why it is being refused.
    const st = await s.c.rpc("tools/call", { name: "browser_status", arguments: {} });
    assert(
      "safety: browser_status still works and prints the policy",
      ok(st) && /safety: allow=/.test(callText(st)),
    );
    s.done();
  }

  // ── NEGATIVE CONTROL: the identical call on an ALLOWED origin ──────────────
  s = await withPolicy(
    9165,
    { AUTOMATE_BROWSER_ALLOW_ORIGINS: ALLOW },
    "http://localhost:3000/app",
  );
  assert("safety: relay came up (allowed-origin range)", !!s);
  if (s) {
    s.browser.received.length = 0;
    const on = await click(s.c);
    assert(
      "safety: the same drive on an allowed origin succeeds (control)",
      ok(on) && s.browser.received.includes("browser_click"),
    );
    s.done();
  }

  // ── read-only mode: mutating refused, read-only permitted ──────────────────
  s = await withPolicy(9168, { AUTOMATE_BROWSER_READ_ONLY: "1" }, "http://localhost:3000/app");
  assert("safety: relay came up (read-only range)", !!s);
  if (s) {
    s.browser.received.length = 0;
    const mut = await click(s.c);
    assert("safety: read-only mode refuses a mutating tool", blocked(mut, "READ_ONLY"));
    assert(
      "safety: the refused mutating call never reached the browser",
      !s.browser.received.includes("browser_click"),
    );
    const ro = await s.c.rpc("tools/call", { name: "browser_read_page", arguments: {} });
    assert(
      "safety: read-only mode permits a read-only tool (control)",
      ok(ro) && s.browser.received.includes("browser_read_page"),
    );
    s.done();
  }

  // ── B03: read-only holds where the origin probe never runs ────────────────
  // Two shortcuts used to return before the read-only rule was ever consulted:
  // no browser connected yet, and a probe that threw with only a deny-list set.
  // Both are correct reasons to stop asking WHERE the call is, and neither is a
  // reason to stop asking WHETHER a page-changing tool may run.
  {
    const RS = 9174;
    const env = {
      ...process.env,
      AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RS + 2}`,
      AUTOMATE_BROWSER_TOKEN: TOKEN,
      AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
      AUTOMATE_BROWSER_CLIENT_NAME: "SafetyNoBrowser",
      AUTOMATE_BROWSER_READ_ONLY: "1",
      AUTOMATE_BROWSER_DENY_ORIGINS: "https://*.tracker.example",
    };
    const c = makeController(env);
    const port = await waitForRelayPort(RS, RS + 2);
    assert("safety: relay came up (no-browser read-only range)", port != null);
    if (port != null) {
      await initController(c);
      // Deliberately NO browser is connected to this relay.
      const mut = await click(c);
      assert(
        "safety: read-only refuses a mutating tool before any browser has connected",
        blocked(mut, "READ_ONLY"),
      );
      const ro = await c.rpc("tools/call", { name: "browser_read_page", arguments: {} });
      assert(
        "safety: the same setup still fails a read for the ordinary no-connection reason",
        isErr(ro) && !callText(ro).startsWith("READ_ONLY:"),
      );
    }
    c.kill();
  }

  // ── deny-list: refused AND pushed to the network layer ─────────────────────
  s = await withPolicy(
    9171,
    { AUTOMATE_BROWSER_DENY_ORIGINS: "https://*.tracker.example" },
    "https://ads.tracker.example/x",
  );
  assert("safety: relay came up (deny-list range)", !!s);
  if (s) {
    const den = await click(s.c);
    assert("safety: a denied origin is refused", blocked(den, "ORIGIN_BLOCKED"));
    // The network half only installs on an ALLOWED page — a refused call stops
    // before it. So drive one that passes, then look for the rule push.
    s.browser.received.length = 0;
    await s.c.rpc("tools/call", {
      name: "browser_navigate",
      arguments: { url: "https://safe.example/" },
    });
    const push = s.browser.msgs.find((m) => m.type === "browser_net_policy");
    assert(
      "safety: the deny-list reaches the browser as declarativeNetRequest domains",
      !!push && Array.isArray(push.payload.deny) && push.payload.deny.includes("tracker.example"),
    );
    s.done();
  }

  // ── two controllers, one browser, two different deny-lists (B05) ───────────
  //
  // The wire contract the extension's conflict protection stands on: each push
  // carries ITS OWN deny-list and a distinct owner. Without the owner the
  // extension cannot tell "the same agent changed its mind" (replace) from "a
  // second agent arrived" (keep both), and the second push silently deletes the
  // first agent's rules while that agent still believes it is protected.
  {
    const RS = 9204;
    const shared = {
      ...process.env,
      AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RS + 2}`,
      AUTOMATE_BROWSER_TOKEN: TOKEN,
      AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
    };
    const a = makeController({
      ...shared,
      AUTOMATE_BROWSER_CLIENT_NAME: "ConflictA",
      AUTOMATE_BROWSER_DENY_ORIGINS: "https://*.tracker.example",
    });
    const port = await waitForRelayPort(RS, RS + 2);
    assert("safety: relay came up (two-controller range)", port != null);
    if (port != null) {
      const b = makeController({
        ...shared,
        AUTOMATE_BROWSER_CLIENT_NAME: "ConflictB",
        AUTOMATE_BROWSER_DENY_ORIGINS: "https://ads.example",
      });
      await initController(a);
      await initController(b);
      const browser = await makeClient(
        port,
        { browser: "chrome", label: "SharedBrowser" },
        (msg) => (msg.type === "getUrl" ? "https://safe.example/page" : undefined),
      );
      await sleep(300);
      const navigate = (c) =>
        c.rpc("tools/call", {
          name: "browser_navigate",
          arguments: { url: "https://safe.example/" },
        });
      await navigate(a);
      await navigate(b);

      const pushes = browser.msgs.filter((m) => m.type === "browser_net_policy");
      assert(
        "safety: both controllers install their own deny-list on the shared browser",
        pushes.length === 2 &&
          pushes.some((p) => (p.payload.deny || []).includes("tracker.example")) &&
          pushes.some((p) => (p.payload.deny || []).includes("ads.example")),
      );
      assert(
        "safety: each push names a distinct owner, so neither can replace the other",
        pushes.length === 2 &&
          !!pushes[0].payload.owner &&
          !!pushes[1].payload.owner &&
          pushes[0].payload.owner !== pushes[1].payload.owner,
      );
      try {
        browser.ws.close();
      } catch {}
      b.kill();
    }
    a.kill();
  }

  // ── THE CONTROL FOR THE WHOLE FEATURE: nothing set, nothing changes ────────
  s = await withPolicy(9174, {}, "https://bank.example.com/accounts");
  assert("safety: relay came up (unset range)", !!s);
  if (s) {
    s.browser.received.length = 0;
    const free = await click(s.c);
    assert(
      "safety: with no policy set, the same drive is unrestricted",
      ok(free) && s.browser.received.includes("browser_click"),
    );
    assert(
      "safety: with no policy set, no origin probe is sent at all",
      !s.browser.received.includes("getUrl") && !s.browser.received.includes("browser_net_policy"),
    );
    const st = await s.c.rpc("tools/call", { name: "browser_status", arguments: {} });
    assert(
      "safety: browser_status says nothing about safety when unset",
      !/safety:/.test(callText(st)),
    );
    s.done();
  }
}

/**
 * B06 — a controller that could not reach the relay on its first try must keep
 * trying, and must come back on its own.
 *
 * The old scheduling lived only in the close handler and armed exactly one timer
 * per drop; a startup failure armed none at all, so `server.ts`'s promise that
 * "the link keeps retrying with backoff" was simply untrue. This reproduces that
 * by squatting the whole port range with a socket that accepts connections and
 * never speaks the protocol: discovery finds nothing, the relay it then spawns
 * cannot bind, and the attempt fails. Releasing the port later is the only event
 * in the scenario - NO tool call is made in between, which is the point.
 */
async function runReconnectRecovery() {
  const net = require("net");
  // Accepts and stays mute, so the probe times out rather than being refused -
  // the shape of a port held by something that is not our relay. The sockets are
  // tracked because `server.close()` waits for every open connection, and a mute
  // server collects several: releasing the port is the event this whole scenario
  // turns on, so it cannot be allowed to block on a probe that never hung up.
  const held = new Set();
  const squatter = net.createServer((s) => {
    held.add(s);
    s.on("close", () => held.delete(s));
    s.on("error", () => {});
  });
  // Port 0 - the OS picks one that is free right now. A fixed number in this
  // file would fail the day an earlier run leaves a relay behind on it, which is
  // a fault in the harness reported as a fault in the code.
  const listening = await new Promise((resolve) => {
    squatter.once("error", () => resolve(false));
    squatter.listen(0, "127.0.0.1", () => resolve(true));
  });
  assert("reconnect: the scenario could hold a port range of its own", listening);
  if (!listening) return;
  const PORT = squatter.address().port;

  const c = makeController({
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${PORT}-${PORT}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "8000",
    AUTOMATE_BROWSER_CLIENT_NAME: "RecoverySeat",
  });
  await initController(c);

  const relayLine = async () =>
    callText(await c.rpc("tools/call", { name: "browser_status", arguments: {} }));

  // Long enough for the first attempt to fail (discovery ~0.4s, then a 4s spawn
  // budget) and for the first backoff retry to start and fail as well.
  await sleep(6500);
  const stranded = await relayLine();
  assert(
    "reconnect: a controller that cannot reach the relay reports no relay",
    !/relay ws:\/\//.test(stranded),
  );

  for (const s of held) {
    try {
      s.destroy();
    } catch {}
  }
  await new Promise((resolve) => squatter.close(resolve));

  // From here nothing calls a tool until the assertion below: recovery has to
  // come from the link's own scheduler or not at all.
  let recovered = false;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (/relay ws:\/\//.test(await relayLine())) {
      recovered = true;
      break;
    }
  }
  assert("reconnect: the link recovers on its own after a failed attempt", recovered);

  c.kill();
  // The relay this scenario spawned is on its own port and idles out; nothing
  // else in the suite uses that range.
}

async function runRosterHardening() {
  const RS = 9153;
  const RE = 9155;
  const STALE_MS = 2000;
  const relay = spawn("node", ["dist/relay.js"], {
    cwd: ROOT,
    stdio: "ignore",
    env: {
      ...process.env,
      AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
      AUTOMATE_BROWSER_TOKEN: TOKEN,
      AUTOMATE_BROWSER_RELAY_IDLE_MS: "10000",
      AUTOMATE_BROWSER_CONTROLLER_STALE_MS: String(STALE_MS),
    },
  });
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("hardening: relay came up (isolated range)", false);
    try {
      relay.kill();
    } catch {}
    return;
  }
  assert("hardening: relay came up (isolated range)", true);

  const open = [];
  /**
   * A bare controller peer. `silent: true` skips the heartbeat, modelling a
   * wedged agent; everything else pings well inside the stale window so only the
   * deliberate zombie is ever a reaping candidate.
   */
  const makeRawController = ({ name, pid, instanceId, silent }) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      let closed = false;
      let ping;
      const self = {
        ws,
        wasClosed: () => closed,
        stop: () => {
          clearInterval(ping);
          try {
            ws.close();
          } catch {}
        },
      };
      open.push(self);
      ws.on("close", () => {
        closed = true;
        clearInterval(ping);
      });
      ws.on("error", () => {});
      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "hello" && msg.payload && msg.payload.role === "relay") {
          const auth = msg.payload.auth?.challenge
            ? signAuthChallenge(msg.payload.auth.challenge)
            : undefined;
          ws.send(
            JSON.stringify({
              id: "hello",
              type: "control.hello",
              payload: { role: "controller", auth, name, pid, instanceId },
            }),
          );
          if (!silent) {
            ping = setInterval(() => {
              try {
                ws.send(JSON.stringify({ type: "control.ping" }));
              } catch {}
            }, 300);
          }
          setTimeout(() => resolve(self), 250);
        }
      });
    });

  const observer = await makeClient(port, { browser: "chrome", label: "Watch", tabId: 1 });
  const roster = () => ((observer.lastAgents() || {}).controllers || []).map((c) => c.name);

  // ── P0-C: the same instance saying hello again REPLACES its old entry ──
  const first = await makeRawController({ name: "IDE", pid: 4242, instanceId: "inst-1" });
  const twin = await makeRawController({ name: "IDE", pid: 4243, instanceId: "inst-1" });
  await sleep(400);
  assert(
    "hardening: a second hello with the same instanceId replaces the first entry",
    roster().length === 1 && first.wasClosed() && !twin.wasClosed(),
  );

  // ── P0-C negative control: a DIFFERENT instance is a genuinely separate agent ──
  const other = await makeRawController({ name: "Other", pid: 5000, instanceId: "inst-2" });
  await sleep(400);
  assert(
    "hardening: a different instanceId is kept alongside, not evicted",
    roster().sort().join(",") === "IDE,Other" && !twin.wasClosed() && !other.wasClosed(),
  );
  other.stop();
  await sleep(300);

  // ── P0-C exemption: an older controller sends no instanceId and is never evicted ──
  const legacyA = await makeRawController({ name: "Legacy", pid: 6001 });
  const legacyB = await makeRawController({ name: "Legacy", pid: 6002 });
  await sleep(400);
  const withLegacy = roster();
  assert(
    "hardening: controllers without an instanceId are exempt from eviction",
    withLegacy.filter((n) => n.startsWith("Legacy")).length === 2 &&
      !legacyA.wasClosed() &&
      !legacyB.wasClosed(),
  );

  // ── P0-E: two agents sharing a name are told apart by pid ──
  assert(
    "hardening: duplicate display names are disambiguated by pid",
    withLegacy.includes("Legacy (pid 6001)") && withLegacy.includes("Legacy (pid 6002)"),
  );

  // ── P0-E negative control: a unique name is left exactly as reported ──
  assert(
    "hardening: a unique name is not suffixed",
    withLegacy.includes("IDE") && !withLegacy.some((n) => n.startsWith("IDE (")),
  );

  legacyA.stop();
  legacyB.stop();
  twin.stop(); // leave the reaper phase with only its own two peers on the roster
  await sleep(300);

  // ── P0-D: a controller that goes silent is reaped; a pinging one survives ──
  const zombie = await makeRawController({
    name: "Wedged",
    pid: 7001,
    instanceId: "inst-z",
    silent: true,
  });
  const healthy = await makeRawController({
    name: "Alive",
    pid: 7002,
    instanceId: "inst-h",
  });
  await sleep(400);
  const bothUp = roster().sort().join(",") === "Alive,Wedged";
  await sleep(STALE_MS + 2000);
  const after = roster();
  assert(
    "hardening: a controller silent past the stale window is reaped",
    bothUp && !after.includes("Wedged") && zombie.wasClosed(),
  );
  assert(
    "hardening: a controller that keeps pinging is never reaped",
    after.includes("Alive") && !healthy.wasClosed(),
  );

  for (const c of open) c.stop();
  try {
    observer.ws.close();
  } catch {}
  try {
    relay.kill();
  } catch {}
}

async function runRoster() {
  const RS = 9126;
  const RE = 9128;
  const env = {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RS}-${RE}`,
    AUTOMATE_BROWSER_TOKEN: TOKEN,
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "3000",
  };
  const a = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "RosterA" });
  const port = await waitForRelayPort(RS, RE);
  if (port == null) {
    assert("roster: relay came up (isolated range)", false);
    a.kill();
    return;
  }
  assert("roster: relay came up (isolated range)", true);
  await initController(a);
  // Browser connects first so it receives the `agents` frames pushed as agents join.
  const solo = await makeClient(port, { browser: "chrome", label: "Solo", tabId: 100 });
  const b = makeController({ ...env, AUTOMATE_BROWSER_CLIENT_NAME: "RosterB" });
  await initController(b);
  // Force BOTH controllers to connect to the relay WITHOUT taking a claim
  // (browser_list_clients is a noClaim discovery call) — i.e. connected but idle.
  await a.rpc("tools/call", { name: "browser_list_clients", arguments: {} });
  await b.rpc("tools/call", { name: "browser_list_clients", arguments: {} });
  await sleep(400);

  // Both connected agents are listed in the roster even though NEITHER holds a
  // claim — the whole point of the fix (idle agents no longer vanish).
  const frame1 = solo.lastAgents() || {};
  const names1 = (frame1.controllers || []).map((c) => c.name).sort();
  assert(
    "roster: both connected agents listed while idle (no claim held)",
    names1.join(",") === "RosterA,RosterB" && (frame1.claims || []).length === 0,
  );

  // A drives the focused tab → its claim appears; the roster still lists both.
  const da = await a.rpc("tools/call", navArgs("https://a.example"));
  await sleep(300);
  const frame2 = solo.lastAgents() || {};
  const claimNames = (frame2.claims || []).map((c) => c.controllerName);
  const names2 = (frame2.controllers || []).map((c) => c.name).sort();
  assert(
    "roster: a driving agent shows its claim while the roster still lists both",
    ok(da) && claimNames.includes("RosterA") && names2.join(",") === "RosterA,RosterB",
  );

  // B disconnects → the relay re-broadcasts; B drops from the browser's roster
  // even though it held no claim (proves the unconditional disconnect refresh).
  b.kill();
  await sleep(600);
  const names3 = ((solo.lastAgents() || {}).controllers || []).map((c) => c.name);
  assert(
    "roster: a disconnected agent drops from the browser roster",
    !names3.includes("RosterB") && names3.includes("RosterA"),
  );

  try {
    solo.ws.close();
  } catch {}
  a.kill();
}

// ── a fake browser connected to the relay ────────────────────────────────────
// `received` keeps the type list (used by older assertions); `msgs` keeps the
// full {type, payload} so tab-routing assertions can inspect `__bmcpTabId`.
/**
 * `respond(msg)` may return a custom result for a given request; anything
 * falsy falls back to the generic `{ ok: true }` every other test relies on.
 */
const NO_REPLY = Symbol("no-reply");

/**
 * Tab ids the fake browser hands out for the provisioning call `ensureOwnTab`
 * makes before every claiming send (plan 02, Task 1). A real browser answers
 * `browser_new_tab` with the new tab's id; without this the fake one would reply
 * the generic `{ ok: true }`, the controller would have no tab to drive, and
 * every mutating tool in this file would fail. Starts high so a provisioned id
 * never collides with the fixed ids the tab-routing tests pick (100/200/4242).
 */
let nextProvisionedTabId = 9000;

function makeClient(port, identify, respond) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const received = [];
    const msgs = [];
    const provisioned = []; // tab ids handed to ensureOwnTab, in order
    const agentsFrames = []; // each relay `agents` push: { claims, controllers }
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
          !Object.prototype.hasOwnProperty.call(msg.payload, "token") &&
          auth
        );
        ws.send(JSON.stringify({ id: "idf", type: "identify", payload: { ...identify, auth } }));
        return;
      }
      if (msg.type === "messageResponse") return;
      // One-way relay roster/claims push — no `id`, no reply (drives the popup).
      if (msg.type === "agents") {
        agentsFrames.push(msg.payload || {});
        return;
      }
      if (msg.id && msg.type) {
        received.push(msg.type);
        msgs.push({ type: msg.type, payload: msg.payload });
        // Answered HERE, ahead of `respond`, because ensureOwnTab's provisioning
        // call is infrastructure rather than the tool under test: a test that
        // models a failing, slow or silent browser must still get a tab to drive,
        // or it would only ever prove that provisioning failed. Assertions about
        // the provisioning call read `msgs`; nothing overrides this reply.
        if (msg.type === "browser_new_tab") {
          const tabId = nextProvisionedTabId++;
          provisioned.push(tabId);
          try {
            ws.send(
              JSON.stringify({
                type: "messageResponse",
                payload: { requestId: msg.id, result: { tabId, index: 0 } },
              }),
            );
          } catch {
            /* socket closed */
          }
          return;
        }
        const custom = respond ? respond(msg) : undefined;
        // Sentinel: model a browser that never answers, so the caller can prove a
        // dropped round-trip degrades gracefully instead of failing the tool.
        if (custom === NO_REPLY) return;
        // A responder may return a PROMISE to model a slow browser (used to prove
        // the per-controller send queue actually waits, not just that order held).
        Promise.resolve(custom).then((result) => {
          if (result === NO_REPLY) return;
          try {
            // `{ __error }` models a browser-side FAILURE (the extension replies
            // with `payload.error`, which relay-link rejects on). Without this the
            // fake browser could only ever succeed, so no error path was testable.
            const payload =
              result && typeof result === "object" && "__error" in result
                ? { requestId: msg.id, error: result.__error }
                : { requestId: msg.id, result: result || { ok: true } };
            ws.send(
              JSON.stringify({
                type: "messageResponse",
                payload,
              }),
            );
          } catch {
            /* socket closed while the fake browser was "thinking" */
          }
        });
      }
    });
    ws.on("open", () =>
      setTimeout(
        () =>
          resolve({
            ws,
            received,
            msgs,
            provisioned,
            agentsFrames,
            lastAgents: () => agentsFrames[agentsFrames.length - 1],
            helloOk: () => helloOk,
          }),
        200,
      ),
    );
  });
}

const checks = [];
const assert = (name, cond) => {
  checks.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
};
const navArgs = (url) => ({ name: "browser_navigate", arguments: { url, includeSnapshot: false } });

let A, B;
(async () => {
  A = makeController({ ...baseEnv, AUTOMATE_BROWSER_CLIENT_NAME: "AgentA" });
  // A spawns the relay; wait for it to come up.
  const relayPort = await waitForRelayPort();
  assert("relay came up in range", relayPort != null);
  assert("relay rejects web page Origin", await expectRejectedOrigin(relayPort));
  assert("relay closes malformed JSON frames", await expectMalformedClose(relayPort));
  assert("relay rejects bad browser auth proof", await expectBadAuthRejected(relayPort));

  assert("MCP initialize ok (A)", !!(await initController(A)).result);

  const chrome = await makeClient(relayPort, { browser: "chrome", label: "Work Chrome" });
  const edge = await makeClient(relayPort, { browser: "edge" });
  assert("both clients validated hello", chrome.helloOk() && edge.helloOk());
  await sleep(300);

  const listA = await A.rpc("tools/call", { name: "browser_list_clients", arguments: {} });
  const tA = callText(listA);
  assert("A list shows chrome + edge", /chrome/.test(tA) && /edge/.test(tA));

  const amb = await A.rpc("tools/call", navArgs("https://example.com"));
  assert("ambiguous call refused while 2 connected", isErr(amb));

  // ── second controller proves the mesh ──
  B = makeController({ ...baseEnv, AUTOMATE_BROWSER_CLIENT_NAME: "AgentB" });
  assert("MCP initialize ok (B)", !!(await initController(B)).result);
  await sleep(300);
  const listB = await B.rpc("tools/call", { name: "browser_list_clients", arguments: {} });
  const tB = callText(listB);
  assert("B sees the SAME roster (chrome + edge)", /chrome/.test(tB) && /edge/.test(tB));

  // ── A selects edge; routes to edge only ──
  await A.rpc("tools/call", { name: "browser_select_client", arguments: { browser: "edge" } });
  chrome.received.length = 0;
  edge.received.length = 0;
  const navA = await A.rpc("tools/call", navArgs("https://example.com"));
  assert("navigate succeeds after A selects", ok(navA));
  assert(
    "A routed to edge only",
    edge.received.includes("browser_navigate") && !chrome.received.includes("browser_navigate"),
  );

  // ── per-controller selection: A's choice must NOT affect B ──
  const ambB = await B.rpc("tools/call", navArgs("https://example.com"));
  assert("B still ambiguous (A's selection did not leak)", isErr(ambB));

  // ── B selects chrome; A and B route independently ──
  await B.rpc("tools/call", { name: "browser_select_client", arguments: { browser: "chrome" } });
  chrome.received.length = 0;
  edge.received.length = 0;
  const navB = await B.rpc("tools/call", navArgs("https://example.com"));
  assert(
    "B routed to chrome only",
    ok(navB) &&
      chrome.received.includes("browser_navigate") &&
      !edge.received.includes("browser_navigate"),
  );
  chrome.received.length = 0;
  edge.received.length = 0;
  const navA2 = await A.rpc("tools/call", navArgs("https://example.com"));
  assert(
    "A still routed to edge (independent of B)",
    ok(navA2) &&
      edge.received.includes("browser_navigate") &&
      !chrome.received.includes("browser_navigate"),
  );

  // ── claim enforcement: B cannot drive A's TAB; it is told WHO holds it ──
  // A owns the tab it opened on edge when it first drove; B must aim at that same
  // tab to contend, since selecting nothing would just give B a tab of its own.
  await B.rpc("tools/call", { name: "browser_select_client", arguments: { browser: "edge" } });
  await B.rpc("tools/call", {
    name: "browser_select_tab",
    arguments: { tabId: edge.provisioned[0] },
  });
  edge.received.length = 0;
  const bBlocked = await B.rpc("tools/call", navArgs("https://example.com"));
  assert(
    "B blocked from edge (claimed) and told the holder by name",
    isErr(bBlocked) &&
      /AgentA/.test(callText(bBlocked)) &&
      !edge.received.includes("browser_navigate"),
  );

  // ── force_claim steals edge from A; A is notified on its next action ──
  const steal = await B.rpc("tools/call", {
    name: "browser_force_claim",
    arguments: { browser: "edge" },
  });
  assert("B force-claims edge", ok(steal) && /took over/i.test(callText(steal)));

  // B7: the loss is PUSHED, so A learns on its very next result — WITHOUT having
  // to burn an action discovering it. Before this, the notice only rode back on
  // the refusal of A's next drive, which is the "finds out mid-task" complaint.
  const aEarly = await A.rpc("tools/call", { name: "browser_status", arguments: {} });
  assert(
    "A is told it lost the tab without having to act first (B7 push)",
    /taken over/i.test(callText(aEarly)) && /AgentB/.test(callText(aEarly)),
  );

  const aBlocked = await A.rpc("tools/call", navArgs("https://example.com")); // A still selected edge
  assert(
    "A now blocked from edge (B stole it), named",
    isErr(aBlocked) && /AgentB/.test(callText(aBlocked)),
  );
  const aStatus1 = await A.rpc("tools/call", { name: "browser_status", arguments: {} });
  assert(
    "the takeover notice is one-shot — not repeated after it was delivered",
    !/taken over/i.test(callText(aStatus1)),
  );

  // ── release returns edge; A can drive it again ──
  await B.rpc("tools/call", { name: "browser_release_client", arguments: {} }); // B's active is edge (from force)
  edge.received.length = 0;
  const aRedrive = await A.rpc("tools/call", navArgs("https://example.com"));
  assert(
    "A drives edge again after B releases it",
    ok(aRedrive) && edge.received.includes("browser_navigate"),
  );

  // ── browser_status reports relay + identity + peers + roster ──
  const stA = callText(await A.rpc("tools/call", { name: "browser_status", arguments: {} }));
  assert("browser_status shows the relay port", new RegExp(`:${relayPort}\\b`).test(stA));
  assert("browser_status shows own name + the peer", /AgentA/.test(stA) && /AgentB/.test(stA));
  assert("browser_status lists both browsers", /chrome/.test(stA) && /edge/.test(stA));

  // ── claims free when a controller disconnects (B held chrome) ──
  B.kill();
  await sleep(600);
  await A.rpc("tools/call", { name: "browser_select_client", arguments: { browser: "chrome" } });
  chrome.received.length = 0;
  const aChrome = await A.rpc("tools/call", navArgs("https://example.com"));
  assert(
    "A drives chrome after B disconnects (its claim was freed)",
    ok(aChrome) && chrome.received.includes("browser_navigate"),
  );

  // ── selected browser disconnects → fall back to the sole remaining (edge) ──
  chrome.ws.close();
  await sleep(500);
  edge.received.length = 0;
  const nav3 = await A.rpc("tools/call", navArgs("https://example.com/2"));
  assert(
    "A falls back to edge after chrome disconnects",
    ok(nav3) && edge.received.includes("browser_navigate"),
  );

  // ── lean snapshots + new tools (single active client now: edge) ──
  edge.received.length = 0;
  const clickLean = await A.rpc("tools/call", {
    name: "browser_click",
    arguments: { element: "the button", ref: "e1" },
  });
  assert(
    "click is lean by default (no auto snapshot)",
    ok(clickLean) &&
      edge.received.includes("browser_click") &&
      !edge.received.includes("browser_snapshot"),
  );

  edge.received.length = 0;
  const sel = await A.rpc("tools/call", { name: "browser_select_tab", arguments: { tabId: 123 } });
  assert(
    "browser_select_tab routes to extension",
    ok(sel) && edge.received.includes("browser_select_tab"),
  );

  edge.received.length = 0;
  const ev = await A.rpc("tools/call", { name: "browser_eval", arguments: { expression: "1+1" } });
  assert("browser_eval routes to extension", ok(ev) && edge.received.includes("browser_eval"));

  try {
    edge.ws.close();
  } catch {}
  A.kill();
  try {
    B && B.kill();
  } catch {}

  // ── idle-lease expiry (isolated relay + short TTL) ──
  await runLeaseExpiry();

  // ── tab-scoped control: two IDEs, two tabs, one browser (isolated relays) ──
  await runTabScoped();
  await runWholePrecedence();
  await runAutoTab();
  await runTabLifecycle();
  await runRoster();
  await runPathSandbox();
  await runPerfTrace();
  await runDeltaFooter();
  await runCli();
  await runVersionMismatch();
  await runPerCall();
  await runProfiles();
  await runRefDerivation();
  await runActionability();
  await runTransientRetry();
  await runRosterHardening();
  await runReconnectRecovery();
  await runSafety();
  await runStage6();
  await runClickAt();
  await runShots();
  await runEmulate();
  await runInsecureCerts();
  await runInclude();
  await runStage8();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log("--- controller A stderr ---\n" + A.getStderr().trim());
    if (B) console.log("--- controller B stderr ---\n" + B.getStderr().trim());
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS_ERROR", e);
  try {
    A && A.kill();
  } catch {}
  try {
    B && B.kill();
  } catch {}
  process.exit(1);
});
