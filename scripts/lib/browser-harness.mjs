/**
 * Shared plumbing for the two harnesses that drive a REAL browser:
 * `integration-browser.mjs` (B11 — does the code work) and `eval-agent.mjs`
 * (C24 — can a model actually get the job done with these tools).
 *
 * This exists so the SAFETY rule below has exactly one implementation. A second
 * copy of "adopt only a browser we started" is a second chance to get it wrong,
 * and getting it wrong means driving the user's real, logged-in tabs.
 *
 * SAFETY. The extension's port range (9009-9013) is compiled into
 * `Chrome-extension/lib/protocol.ts`, so neither harness can be moved to a
 * private port the way `npm run smoke` is — both land on whatever relay the user
 * already has. `launchOwnBrowser` therefore reads the roster BEFORE launching,
 * and adopts only a client that is both absent from that set AND connected after
 * launch, then pins every call to it with `browser_select_client`. A roster it
 * cannot parse THROWS: "no structured roster" must never read as "nobody is
 * connected".
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXT_DIR = path.join(ROOT, "Chrome-extension", ".output", "chrome-mv3");
export const FIXTURES = path.join(ROOT, "scripts", "fixtures");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── preflight ───────────────────────────────────────────────────────────────
/** Newest mtime under a file or directory tree. */
function newestMtime(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of fs.readdirSync(target)) {
    newest = Math.max(newest, newestMtime(path.join(target, entry)));
  }
  return newest;
}

/** Exits 1 with an instruction when either build is missing or the extension is stale. */
export function requireFreshBuilds() {
  const manifest = path.join(EXT_DIR, "manifest.json");
  if (!fs.existsSync(manifest)) {
    console.error(
      "No built extension at " +
        EXT_DIR +
        "\n" +
        "Build it first:  cd Chrome-extension && npm run compile && npm run build",
    );
    process.exit(1);
  }
  if (!fs.existsSync(path.join(ROOT, "dist", "index.js"))) {
    console.error("No dist/index.js. Run `npm run build` first.");
    process.exit(1);
  }
  // A harness that loads a stale build reports on code nobody is running. Chrome
  // is handed the OUTPUT directory, so the output has to be newer than the source.
  const built = newestMtime(manifest);
  const sources = ["entrypoints", "lib", "wxt.config.ts", "public"]
    .map((p) => path.join(ROOT, "Chrome-extension", p))
    .filter((p) => fs.existsSync(p));
  const stale = sources.filter((p) => newestMtime(p) > built);
  if (stale.length) {
    console.error(
      "The built extension is STALE — newer source in: " +
        stale.map((p) => path.relative(ROOT, p)).join(", ") +
        "\n" +
        "Rebuild it:  cd Chrome-extension && npm run compile && npm run build",
    );
    process.exit(1);
  }
}

// ── fixture server ──────────────────────────────────────────────────────────
const MIME = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

/** Serves `scripts/fixtures/` on an ephemeral loopback port. Never a live site. */
export function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/download.txt") {
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": 'attachment; filename="fixture-download.txt"',
        });
        res.end("this file exists to be downloaded\n");
        return;
      }
      // A script the server answers slowly. B09's fixture uses it to hold the
      // load event open for a known number of milliseconds without touching the
      // renderer's main thread, so what a navigation call measures is the page
      // loading and not the browser being busy.
      if (url.pathname === "/slow.js") {
        const ms = Math.min(Math.max(Number(url.searchParams.get("ms")) || 600, 0), 5000);
        setTimeout(
          () =>
            res
              .writeHead(200, { "content-type": "text/javascript; charset=utf-8" })
              .end("window.__stage10Slow = " + ms + ";\n"),
          ms,
        );
        return;
      }
      const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
      const file = path.join(FIXTURES, name);
      if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) {
        res.writeHead(404).end("not found");
        return;
      }
      let body = fs.readFileSync(file, "utf8");
      // The frame is served from the OTHER loopback name so the browser treats it
      // as a different origin — that is the whole point of the iframe case.
      // `127.0.0.1` and `localhost` are the same server on the same port and two
      // different origins to Chrome, which is what makes a cross-origin fixture
      // possible without a second listener or a hosts-file entry.
      const other = "http://localhost:" + server.address().port + "/";
      body = body.replace("__FRAME_SRC__", other + "frame.html");
      // B08's cross-origin form frame. It carries `origin=cross`, which is what
      // tells that instance to label its fields "cross" and to embed the nested
      // frame; the same-origin instance is loaded by a relative url and gets
      // `origin=same`.
      body = body.replace(
        "__FORM_FRAME_SRC__",
        other + "stage10-frame-form-child.html?origin=cross",
      );
      // B09's delay, per request: the fixture asks for one slow script, and how
      // slow is whatever the caller put in its own `delay`.
      body = body.replace(
        "__SLOW_SRC__",
        "slow.js?ms=" + (Number(url.searchParams.get("delay")) || 600),
      );
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "text/plain" }).end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ── one MCP controller (dist/index.js) speaking JSON-RPC over stdio ─────────
export function makeController(env) {
  const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    // The suite reads `structuredContent` (full ids, navigation timings), which a
    // controller withholds by default since plan 14 (F2).
    env: { ...process.env, AUTOMATE_BROWSER_STRUCTURED: "1", ...env },
  });
  let out = "";
  let stderr = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    out += d.toString();
    let i;
    while ((i = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
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
  child.stderr.on("data", (d) => (stderr += d.toString()));
  let nid = 1;
  const rpc = (method, params, timeoutMs = 45000) =>
    new Promise((resolve) => {
      const id = nid++;
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve({ id, error: { message: "timeout: " + method } });
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return {
    rpc,
    call: (name, args) => rpc("tools/call", { name, arguments: args ?? {} }),
    notify: (method, params) =>
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    getStderr: () => stderr,
    kill: () => {
      try {
        child.kill();
      } catch {}
    },
  };
}

export const text = (r) => {
  const c = r?.result?.content;
  if (Array.isArray(c)) return c.map((b) => b?.text ?? "").join("\n");
  return JSON.stringify(r?.result ?? r?.error ?? r);
};
export const isErr = (r) => !!(r?.error || r?.result?.isError);

export async function init(c, clientName = "harness") {
  await c.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: clientName, version: "0" },
  });
  c.notify("notifications/initialized", {});
}

/**
 * The clients currently on the relay, read from `structuredContent` — the text
 * block is a human summary that truncates ids to 8 chars. A missing structured
 * block THROWS rather than reading as "nobody is connected".
 */
export async function roster(c) {
  const r = await c.call("browser_list_clients", {});
  const structured = r?.result?.structuredContent;
  if (!structured) throw new Error("browser_list_clients returned no roster: " + text(r));
  return structured.clients ?? [];
}

/**
 * The roster arrives on a push frame just after the controller connects, so an
 * immediate read can report an empty relay that is not empty. Read until two
 * reads a second apart agree — this set is a safety boundary, and an under-read
 * of it is exactly the failure that boundary exists to prevent.
 */
export async function settledRoster(c) {
  let prev = null;
  for (let i = 0; i < 8; i++) {
    const ids = (await roster(c))
      .map((b) => b.id)
      .sort()
      .join(",");
    if (prev !== null && ids === prev) return new Set(ids ? ids.split(",") : []);
    prev = ids;
    await sleep(1000);
  }
  return new Set(prev ? prev.split(",") : []);
}

/**
 * Every browser this process launched, with the temp directory made for it.
 * A harness that dies mid-scenario used to leave both behind — the browser
 * because only the ONE variable the suite happened to assign was closed, and the
 * download directory because nothing ever removed it. `disposeOwnBrowsers` is
 * the counterpart every launch is registered with, so cleanup is a property of
 * launching rather than of remembering.
 */
const owned = [];

/**
 * Close every browser launched here and remove its download directory. Safe to
 * call twice, and safe to call after a failure — each disposal is independent,
 * so one hung browser cannot strand the rest. Puppeteer removes the disposable
 * PROFILE itself on close (each launch gets its own temp `--user-data-dir`,
 * which is what makes two launches two genuinely independent browsers rather
 * than two windows of one).
 */
export async function disposeOwnBrowsers() {
  for (const entry of owned.splice(0)) {
    try {
      await entry.browser.close();
    } catch {}
    try {
      fs.rmSync(entry.downloadDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Launch a throwaway Chrome with the built extension and hand back ONLY a client
 * this call started. Returns `{ browser, clientId, downloadDir }`, or a
 * `clientId` of null when no new client appeared — never a pre-existing one.
 *
 * Call it TWICE for two independent profiles: the pre-existing roster is read
 * fresh each time, so the browser started by the first call is treated exactly
 * like the user's own — present before, therefore never adopted.
 */
export async function launchOwnBrowser(controller, { headed = false } = {}) {
  const { default: puppeteer } = await import("puppeteer");

  const preexisting = await settledRoster(controller);
  const launchedAt = Date.now();
  if (preexisting.size) {
    console.log("already connected (will not be touched): " + [...preexisting].join(", "));
  }

  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-harness-dl-"));
  const browser = await puppeteer.launch({
    headless: !headed,
    // Point this at msedge.exe (or any Chromium build) to run the same suite
    // against a different browser. Added for D7, where the plan asked for the
    // heap premise to be confirmed "in Chrome and in Edge" — without it, the
    // Edge half is a [User] task forever, and a [User] task is one that
    // quietly never happens.
    executablePath: process.env.AUTOMATE_BROWSER_TEST_BROWSER || undefined,
    args: [
      "--disable-extensions-except=" + EXT_DIR,
      "--load-extension=" + EXT_DIR,
      "--no-sandbox",
      "--no-first-run",
    ],
  });
  owned.push({ browser, downloadDir });
  // Headless Chrome discards downloads unless a directory is set for them.
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true,
  });

  // The extension's service worker IS the WS client — no worker, no connection.
  const swDeadline = Date.now() + 20000;
  let serviceWorker = null;
  while (Date.now() < swDeadline && !serviceWorker) {
    serviceWorker = browser.targets().find((t) => t.type() === "service_worker") ?? null;
    if (!serviceWorker) await sleep(300);
  }

  // Two independent signals must agree — an id we had not seen AND a connection
  // made after we launched — so a roster hiccup cannot hand us the user's browser.
  let clientId = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !clientId) {
    const now = await roster(controller);
    clientId =
      now.find((b) => !preexisting.has(b.id) && Number(b.connectedAt) >= launchedAt)?.id ?? null;
    if (!clientId) await sleep(1000);
  }

  return { browser, clientId, downloadDir, serviceWorker };
}
