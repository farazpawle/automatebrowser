/**
 * One-off driver: takes over the extension link and runs a search on the
 * connected ChatGPT tab. Spawns this repo's server (port 9009 must be free),
 * waits for the browsers, selects the one on ChatGPT, types a query, submits.
 *
 * Fix vs v1: snapshot fresh immediately before typing so the element ref isn't
 * stale (ChatGPT re-renders and invalidates refs between snapshots).
 */
const { spawn } = require("child_process");
const path = require("path");

const QUERY = process.argv[2] || "What is the capital of France?";

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
const rpc = (method, params) =>
  new Promise((res) => {
    const id = nid++;
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args || {} });
  return r.result
    ? {
        text: (r.result.content || []).map((c) => c.text || "").join("\n"),
        isError: !!r.result.isError,
      }
    : { text: "ERR " + JSON.stringify(r.error), isError: true };
};
const log = (...a) => console.log(...a);
const urlOf = (snap) => (snap.match(/Page URL:\s*(\S+)/) || [])[1] || "";

function findPromptRef(snap) {
  for (const ln of snap.split("\n")) {
    if (/textbox/i.test(ln) && !/search tools/i.test(ln)) {
      const m = ln.match(/\[ref=([^\]]+)\]/);
      if (m) return { ref: m[1], desc: (ln.match(/"([^"]+)"/) || [])[1] || "ChatGPT prompt" };
    }
  }
  return { ref: null, desc: "" };
}

(async () => {
  await sleep(900);
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "drive", version: "0" },
  });
  log(
    "server:",
    (stderr.match(/listening on (ws:\/\/\S+)/) || [])[1],
    "| init:",
    init.result ? "ok" : init.error,
  );
  notify("notifications/initialized", {});

  // 1) wait for browsers
  let list = "";
  for (let t = 0; t < 20; t++) {
    list = (await call("browser_list_clients")).text;
    const n = (list.match(/id=/g) || []).length;
    log(`[wait] browsers connected: ${n}`);
    if (n >= 1) break;
    await sleep(1500);
  }
  const ids = [...list.matchAll(/id=([0-9a-f]{8})/g)].map((m) => m[1]);
  log("clients:\n" + list);
  if (!ids.length) {
    log("RESULT: no browser connected.");
    child.kill();
    process.exit(1);
  }

  // 2) pick the ChatGPT browser
  let chosen = null;
  for (const id of ids) {
    await call("browser_select_client", { id });
    const url = urlOf((await call("browser_snapshot")).text);
    log(`[probe] ${id} -> ${url}`);
    if (/chatgpt\.com|chat\.openai\.com/i.test(url)) {
      chosen = id;
      break;
    }
    if (!chosen) chosen = id;
  }
  await call("browser_select_client", { id: chosen });
  log(`using client ${chosen}`);

  // ensure the tab is ChatGPT
  if (!/chatgpt\.com|chat\.openai\.com/i.test(urlOf((await call("browser_snapshot")).text))) {
    log("[nav] -> https://chatgpt.com/");
    await call("browser_navigate", { url: "https://chatgpt.com/" });
    await sleep(4500);
  }

  // 3) fresh snapshot -> ref -> type immediately; retry once on failure
  async function attempt() {
    const snap = (await call("browser_snapshot")).text;
    const { ref, desc } = findPromptRef(snap);
    log(`[prompt] ref=${ref || "NOT FOUND"} desc="${desc}"`);
    if (!ref) return false;
    const typed = await call("browser_type", { element: desc, ref, text: QUERY, submit: true });
    if (typed.isError) {
      log("[type] " + typed.text);
      return false;
    }
    return true;
  }
  let ok = await attempt();
  if (!ok) {
    log("[type] retrying with a fresh snapshot…");
    await sleep(1500);
    ok = await attempt();
  }
  log("[type] " + (ok ? `submitted: "${QUERY}"` : "FAILED"));

  // 4) read the answer back
  await sleep(10000);
  const after = (await call("browser_snapshot")).text;
  log("\n--- ChatGPT page after submit (tail) ---\n" + after.split("\n").slice(-45).join("\n"));
  log(
    `\nRESULT: ${ok ? "query submitted to ChatGPT (check the Edge tab for the streaming answer)." : "could not submit — see snapshot above."}`,
  );

  child.kill();
  process.exit(ok ? 0 : 2);
})().catch((e) => {
  console.error("ERR", e);
  try {
    child.kill();
  } catch {}
  process.exit(1);
});
