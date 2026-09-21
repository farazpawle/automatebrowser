/**
 * The five checks that were marked `[User]` — run by a machine instead.
 *
 * These five, A4-A8, were once listed as "needs a person", and every one of
 * them gave the same reason: *the extension has to be reloaded in a real browser,
 * and an agent cannot click that*. That reason is true about the browser the USER
 * is running. It is not true in general — `launchOwnBrowser` starts a throwaway
 * Chrome with `--load-extension` pointed at the fresh WXT build, so the extension
 * it loads is the one that was just built. There is nothing to reload. The same
 * trick `integration-browser.mjs` has used all along closes these five too.
 *
 * This file exists separately from `integration-browser.mjs` for one reason: A8
 * needs an HTTPS origin with a DELIBERATELY BAD certificate, which means a second
 * server, a generated key pair, and a browser that will refuse to load the page.
 * That does not belong in the suite whose job is "the happy paths work".
 *
 * What each check replaces, and the honest limit of the replacement:
 *
 *   A4  the debugger-rendered screenshot must SAY why the banner appeared.
 *   A5  paging: the 50 newest, then the 50 before those, with no overlap or gap.
 *   A6  a credential in a request header must never reach the tool output.
 *       LIMIT: the token here is one this script generated, not one a real login
 *       issued. That difference does not matter — redaction matches on the HEADER
 *       NAME, so what is being proved is that the extension hands the headers over
 *       and the server redacts them, which a fixture proves exactly as well.
 *   A7  the LCP breakdown's spans must sum to the LCP reported above them.
 *       This is the one that most needed a real browser: the arithmetic was already
 *       pinned by unit tests, and what was missing was proof that a real Chrome
 *       emits the event SHAPES the parser reads. A synthetic array cannot lie about
 *       that in the same direction twice.
 *   A8  accepting an invalid certificate: on, off, and never remembered.
 *
 * SAFETY: inherits `launchOwnBrowser`, which adopts only a client that was absent
 * from the roster before launch AND connected after it. It cannot reach a browser
 * you were already running. Nothing here touches a logged-in session.
 *
 *   npm run test:live              # headless
 *   npm run test:live -- --headed  # watch it
 *
 * Exit: 0 = every check passed, 1 = at least one failed.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  init,
  isErr,
  launchOwnBrowser,
  makeController,
  requireFreshBuilds,
  sleep,
  text,
} from "./lib/browser-harness.mjs";

const HEADED = process.argv.includes("--headed");

// The credential A6 hunts for. Distinctive on purpose: the assertion that matters
// is "this string appears NOWHERE in the reply", and a short or common token would
// pass that by luck.
const SECRET = "lIvE-cHeCk-bEaReR-9f3a7c21d4e8b6";

const checks = [];
const assert = (name, cond, detail) => {
  checks.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : "\n      " + detail}`);
};

let browser = null;
let plain = null;
let tls = null;
let A = null;
let certDir = null;

// ── the pages these checks need ─────────────────────────────────────────────
// Inline rather than in `scripts/fixtures/`, because each one is written against
// the exact numbers its assertion checks (120 entries, one hero image, one
// credential header). Split them out and the page drifts from the check silently.

const CHATTY = `<!doctype html><meta charset=utf-8><title>chatty</title>
<h1>chatty</h1><p id=done>working</p><script>
// 120 of each: comfortably over the 50-per-page boundary, and not a multiple of
// it, so a short last page is exercised too.
for (let i = 1; i <= 120; i++) console.log("live-check console entry " + i);
(async () => {
  for (let i = 1; i <= 120; i++) await fetch("/ping?i=" + i);
  document.getElementById("done").textContent = "finished";
})();
</script>`;

const CREDS = `<!doctype html><meta charset=utf-8><title>creds</title>
<h1>creds</h1><p id=done>working</p><script>
fetch("/api/secret", {
  headers: {
    // The four shapes redaction has to catch, in one request.
    "Authorization": "Bearer ${SECRET}",
    "X-Api-Key": "${SECRET}",
    "X-Request-Id": "plain-diagnostic-header-must-survive",
  },
}).then(() => { document.getElementById("done").textContent = "finished"; });
</script>`;

// Render-blocking CSS plus a late hero image: the two things an LCP breakdown is
// supposed to be able to tell apart.
const SLOW = `<!doctype html><meta charset=utf-8><title>slow</title>
<link rel=stylesheet href="/blocking.css">
<h1>slow page</h1>
<img id=hero src="/hero.png" width=1200 height=600 alt="hero">
<p>text below the hero</p>`;

const PLAIN = `<!doctype html><meta charset=utf-8><title>plain</title><h1>plain page</h1>
<p>nothing here but a heading</p>`;

/** One handler, served over both http and https — A8 needs the same page on TLS. */
function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const send = (body, type = "text/html; charset=utf-8", extra = {}) =>
    res.writeHead(200, { "content-type": type, ...extra }).end(body);

  switch (url.pathname) {
    case "/":
    case "/plain.html":
      return send(PLAIN);
    case "/chatty.html":
      return send(CHATTY);
    case "/creds.html":
      return send(CREDS);
    case "/slow.html":
      return send(SLOW);
    case "/ping":
      return send("ok", "text/plain");
    case "/api/secret":
      // Set-Cookie is on the RESPONSE side, so this proves both directions get
      // redacted, not just the request headers the page sent.
      return send('{"ok":true}', "application/json", {
        "set-cookie": "session=" + SECRET + "; Path=/",
      });
    case "/blocking.css":
      // Blocking, and slow enough to be measurable against first paint.
      return setTimeout(() => send("h1{color:#036}", "text/css"), 400);
    case "/hero.png":
      // Late on purpose: this is the resource the LCP breakdown must attribute
      // load delay and load time to.
      return setTimeout(() => send(HERO_PNG, "image/png"), 900);
    default:
      return res.writeHead(404).end("not found");
  }
}

/**
 * A real PNG, built here rather than read from the repo, so the check does not
 * silently start passing against a different image. 1200x600 of one colour: the
 * BYTES are small, which is fine — LCP is decided by rendered area, and the
 * lateness that makes it interesting comes from the 900ms delay above.
 */
const HERO_PNG = (() => {
  const W = 1200;
  const H = 600;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      raw[row + 1 + x * 3] = 0x22;
      raw[row + 2 + x * 3] = 0x55;
      raw[row + 3 + x * 3] = 0x99;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

/**
 * A self-signed certificate for `localhost`, generated into a temp directory and
 * deleted afterwards. Generated rather than committed: a private key in the
 * repository is a finding in every scanner that will ever look at it, and this
 * one has no reason to outlive the run.
 */
function makeBadCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-badcert-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  return { dir, key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));

// ── the checks ──────────────────────────────────────────────────────────────

/** A4 — a debugger-rendered capture must say WHY the banner appeared. */
async function a4(base) {
  await A.call("browser_navigate", { url: base + "/plain.html", includeSnapshot: false });
  await sleep(600);

  // Our tab was opened in the background and never focused, so a capture of it
  // has to go through the debugger. That is the case the note exists for.
  const bg = await A.call("browser_screenshot", { format: "png" });
  const bgText = text(bg);
  assert(
    "A4 a background-tab capture succeeds against a real browser",
    !isErr(bg),
    bgText.slice(0, 400),
  );
  assert(
    "A4 it SAYS it was rendered through the debugger",
    /Rendered through the debugger/i.test(bgText),
    bgText.slice(0, 600),
  );
  assert(
    "A4 and it names the REASON, not just the fact",
    /foreground|minimi|focus|visible/i.test(bgText),
    bgText.slice(0, 600),
  );

  // The structured form of the same two facts lives on the filePath branch only —
  // the inline branch has no structuredContent at all. That is deliberate and is
  // what the register describes, so the check has to take the same route.
  const shotPath = path.join(os.tmpdir(), "ab-live-a4-" + Date.now() + ".png");
  const toFile = await A.call("browser_screenshot", { format: "png", filePath: shotPath });
  const structured = toFile?.result?.structuredContent ?? {};
  assert(
    "A4 the same two facts reach structuredContent on the filePath branch",
    structured.viaDebugger === true && typeof structured.reason === "string" && !!structured.reason,
    JSON.stringify(structured).slice(0, 400),
  );
  try {
    fs.rmSync(shotPath, { force: true });
  } catch {}

  // Now make it the foreground tab. The note must disappear — an always-on note
  // would be indistinguishable from a correct one on the evidence above.
  const tabs = await A.call("browser_list_tabs", {});
  const ours = (tabs?.result?.structuredContent?.tabs ?? []).find((t) =>
    String(t.url).includes("/plain.html"),
  );
  if (ours) {
    await A.call("browser_switch_tab", { tabId: ours.tabId });
    await sleep(800);
    const fg = text(await A.call("browser_screenshot", { format: "png" }));
    assert(
      "A4 a FOREGROUND capture carries no debugger note at all",
      !/Rendered through the debugger/i.test(fg),
      fg.slice(0, 400),
    );
  } else {
    assert("A4 found our own tab in the tab list", false, JSON.stringify(tabs?.result ?? {}));
  }
}

/** A5 — paging over a log with more than one page in it. */
async function a5(base) {
  await A.call("browser_navigate", { url: base + "/chatty.html", includeSnapshot: false });
  // 120 sequential fetches; give them room to finish.
  await sleep(6000);

  const p1 = text(await A.call("browser_get_console_logs", {}));
  const p2 = text(await A.call("browser_get_console_logs", { page: 2 }));

  const nums = (s) => [...s.matchAll(/live-check console entry (\d+)/g)].map((m) => Number(m[1]));
  const n1 = nums(p1);
  const n2 = nums(p2);

  assert("A5 console page 1 returns a full page of 50", n1.length === 50, "got " + n1.length);
  assert(
    "A5 console page 1 is the NEWEST 50, not the oldest",
    Math.max(...n1) === 120,
    String(n1[0]),
  );
  assert(
    "A5 console page 2 is the 50 BEFORE those — no overlap, no gap",
    n2.length === 50 && Math.max(...n2) === 70 && Math.min(...n2) === 21,
    "page2 " + Math.min(...n2) + "-" + Math.max(...n2),
  );
  assert(
    "A5 the footer names the page, the total and the exact next call",
    /page 1\/3 of 120 /i.test(p1) && /\{"page":2\}/.test(p1),
    p1.slice(-400),
  );

  const past = text(await A.call("browser_get_console_logs", { page: 99 }));
  assert(
    "A5 a page past the end says so rather than returning nothing",
    /does not exist|only \d+ page|page 1 of/i.test(past),
    past.slice(-400),
  );

  const net1 = text(await A.call("browser_network_requests", {}));
  const net2 = text(await A.call("browser_network_requests", { page: 2 }));
  const ping = (s) => [...s.matchAll(/\/ping\?i=(\d+)/g)].map((m) => Number(m[1]));
  assert(
    "A5 the network list pages the same way, newest first",
    ping(net1).length > 0 && Math.max(...ping(net1)) > Math.max(...ping(net2), 0),
    "p1 max " + Math.max(...ping(net1), 0) + " p2 max " + Math.max(...ping(net2), 0),
  );
  assert(
    "A5 the network footer names the next call too",
    /page 1\/\d+ of \d+ /i.test(net1) && /\{"page":2\}/.test(net1),
    net1.slice(-400),
  );
}

/** A6 — a credential in a header must not reach the output. */
async function a6(base) {
  const on = await A.call("browser_advanced_mode", { enable: true });
  assert("A6 advanced mode attaches against a real browser", !isErr(on), text(on).slice(0, 300));
  if (isErr(on)) return;

  await A.call("browser_navigate", { url: base + "/creds.html", includeSnapshot: false });
  await sleep(2500);

  const red = await A.call("browser_get_network_request", { url: "/api/secret" });
  const redText = text(red);
  assert("A6 the request was captured at all", !isErr(red), redText.slice(0, 400));

  // The headline assertion, and the only one that would matter if it failed.
  assert(
    "A6 the real credential appears NOWHERE in the redacted reply",
    !redText.includes(SECRET),
    redText.slice(0, 600),
  );
  assert(
    "A6 the header NAMES are kept, so a missing header stays distinguishable",
    /authorization/i.test(redText) && /x-api-key/i.test(redText),
    redText.slice(0, 600),
  );
  assert(
    "A6 it says how many values were withheld",
    /redacted/i.test(redText),
    redText.slice(0, 600),
  );
  assert(
    "A6 an ordinary diagnostic header is left alone",
    redText.includes("plain-diagnostic-header-must-survive"),
    redText.slice(0, 600),
  );

  const shown = text(
    await A.call("browser_get_network_request", { url: "/api/secret", revealValues: true }),
  );
  assert(
    "A6 revealValues opts back in to the real values",
    shown.includes(SECRET),
    shown.slice(0, 400),
  );

  await A.call("browser_advanced_mode", { enable: false });
}

/** A7 — the LCP breakdown's spans must sum to the LCP above them. */
async function a7(base) {
  const on = await A.call("browser_advanced_mode", { enable: true });
  if (isErr(on)) {
    assert("A7 advanced mode attaches", false, text(on).slice(0, 300));
    return;
  }
  await A.call("browser_navigate", { url: base + "/slow.html", includeSnapshot: false });
  await sleep(1000);

  // A breakdown only exists when the trace caught the DOCUMENT request's timing,
  // and on a loaded machine Chrome sometimes leaves that out. The tool then says
  // so in as many words instead of inventing spans, which is right — but this
  // check used to match `/LCP breakdown/`, and that matches the SENTENCE SAYING
  // THERE IS NO BREAKDOWN just as happily as a real one. So a trace that simply
  // lacked the data was reported as a breakdown whose spans summed to zero, and
  // this check failed intermittently for a reason its own message denied
  // (`spans [] sum 0.0 vs LCP 993`). Tell the two apart, and ask again for a
  // usable trace rather than failing on an empty one.
  const REAL = new RegExp("LCP breakdown " + String.fromCharCode(8212) + " \\d+ms total");
  const NO_DOC_TIMING = /LCP breakdown: no document-request timing/;
  const ATTEMPTS = 3;
  let rec;
  let out = "";
  let taken = 0;
  while (taken < ATTEMPTS) {
    taken++;
    rec = await A.call("browser_perf_trace", { action: "start", reload: true, autoStop: true });
    out = text(rec);
    if (isErr(rec) || !NO_DOC_TIMING.test(out)) break;
    await sleep(1500);
  }
  assert("A7 a trace records against a real page", !isErr(rec), out.slice(0, 500));
  if (isErr(rec)) {
    await A.call("browser_advanced_mode", { enable: false });
    return;
  }

  const lcp = out.match(/LCP[^\n]*?([\d.]+)\s*ms/i);
  assert("A7 the trace reports an LCP at all", !!lcp, out.slice(0, 800));

  const hasBreakdown = REAL.test(out);
  assert(
    "A7 a real Chrome emits the event shapes the breakdown parser reads",
    hasBreakdown,
    (NO_DOC_TIMING.test(out)
      ? `no document-request timing in ${taken} trace(s) — the breakdown was never produced, ` +
        `so there are no spans to sum. `
      : "") + out.slice(0, 1200),
  );

  if (hasBreakdown && lcp) {
    // The headline property: the parts must account for the whole.
    const spans = [
      ...out.matchAll(
        /^\s*(?:[-|]\s*)?(time to first byte|resource load delay|resource load time|render delay)[^\d]*([\d.]+)\s*ms/gim,
      ),
    ].map((m) => Number(m[2]));
    const sum = spans.reduce((a, b) => a + b, 0);
    const total = Number(lcp[1]);
    assert(
      "A7 the spans sum to the reported LCP (within rounding)",
      spans.length >= 2 && Math.abs(sum - total) <= Math.max(2, total * 0.02),
      "spans " + JSON.stringify(spans) + " sum " + sum.toFixed(1) + " vs LCP " + total,
    );
    assert(
      "A7 it names a cause and a fix, not just a number",
      /cause:/i.test(out) && /fix:/i.test(out),
      out.slice(0, 900),
    );
  }

  assert(
    "A7 the render-blocking stylesheet is listed as a blocker",
    /render-blocking/i.test(out) && /blocking\.css/.test(out),
    out.slice(0, 1200),
  );

  await A.call("browser_advanced_mode", { enable: false });
}

/**
 * A8 — a bad certificate still stops the agent, and the switch that claimed to
 * get past it is GONE.
 *
 * **What this check originally proved, and why it now proves less.** Until
 * 2026-09-16 `browser_advanced_mode {acceptInsecureCerts:true}` existed, and this
 * block was written to fail the day it started working: Chrome answers
 * `-32601 'Security.setIgnoreCertificateErrors' wasn't found` to an extension,
 * because `chrome.debugger` exposes a FIXED allow-list of CDP domains and
 * `Security` is not on it — the same allow-list that killed D7's heap snapshot.
 * Measured 2026-09-10 in three configurations (headless Chrome 153, headed
 * Chrome 153, Edge) and again on 2026-09-15: identical in all of them.
 *
 * The argument was deleted on the user's decision, so the probe that reached the
 * CDP command no longer exists and **nothing announces it if Chrome ever changes
 * its mind.** That is the accepted cost of deleting it: the feature was a
 * permanent error charged to every request, and a tripwire is not worth paying
 * per-request forever. Re-deriving it would mean re-adding the argument.
 *
 * What is pinned below is what a user actually experiences: a bad certificate
 * stops the page, attaching the debugger does not change that, and asking for the
 * removed switch is refused in terms that name the two routes that DO work rather
 * than failing blankly.
 */
async function a8(base, secureBase) {
  const good = base + "/plain.html";
  const bad = secureBase + "/plain.html";
  const LOADED = "nothing here but a heading";
  const body = async () => {
    const r = await A.call("browser_read_page", { format: "text" });
    // On the interstitial the page is an error page, and reading it is refused —
    // which is itself a reliable "did not load" signal, not a surprise.
    return isErr(r) ? "" : text(r);
  };
  const goTo = async (url) => {
    await A.call("browser_navigate", { url, includeSnapshot: false });
    await sleep(900);
  };

  // ── a plain attach must NOT get past the certificate ──────────────────────
  await goTo(good);
  const attach = await A.call("browser_advanced_mode", { enable: true });
  assert("A8 advanced mode attaches from a good page", !isErr(attach), text(attach).slice(0, 300));
  assert(
    "A8 attaching says nothing about certificates any more",
    !/certificate/i.test(text(attach)),
    text(attach).slice(0, 300),
  );

  await goTo(bad);
  assert("A8 a plain attach does NOT get past a bad certificate", !(await body()).includes(LOADED));

  // ── the removed switch is refused by name, from a real browser ────────────
  await goTo(good);
  const gone = await A.call("browser_advanced_mode", { enable: true, acceptInsecureCerts: true });
  const goneText = text(gone);
  assert(
    "A8 the removed acceptInsecureCerts is REFUSED, not silently ignored",
    isErr(gone) && /BAD_ARGS/.test(goneText),
    goneText.slice(0, 400),
  );
  assert(
    "A8 the refusal names the cause and the real way round it, rather than just failing",
    /Security domain/i.test(goneText) && /--ignore-certificate-errors/.test(goneText),
    goneText.slice(0, 400),
  );

  await goTo(bad);
  assert(
    "A8 and the bad-certificate page is still refused — asking changed nothing",
    !(await body()).includes(LOADED),
  );

  // ── what still holds, and is worth keeping pinned ─────────────────────────
  await goTo(good);
  await A.call("browser_advanced_mode", { enable: false });
  const reattach = await A.call("browser_advanced_mode", { enable: true });
  assert("A8 re-attaching plainly works", !isErr(reattach), text(reattach).slice(0, 300));
  await goTo(bad);
  assert(
    "A8 a FRESH attach carries no bypass — there is nothing left to inherit",
    !(await body()).includes(LOADED),
  );

  await goTo(good);
  await A.call("browser_advanced_mode", { enable: false });
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  requireFreshBuilds();

  plain = await listen(http.createServer(handler));
  const base = "http://127.0.0.1:" + plain.address().port;

  const bad = makeBadCert();
  certDir = bad.dir;
  tls = await listen(https.createServer({ key: bad.key, cert: bad.cert }, handler));
  // `localhost` rather than 127.0.0.1: the certificate names localhost, so what
  // makes this fail is the SELF-SIGNING, not a name mismatch as well. One defect
  // at a time is what makes the "checking is back on" assertions readable.
  const secureBase = "https://localhost:" + tls.address().port;

  console.log("plain: " + base + "   tls: " + secureBase + "   headless: " + !HEADED);

  A = makeController({ AUTOMATE_BROWSER_CLIENT_NAME: "LiveChecks" });
  await init(A, "live-checks");

  const launched = await launchOwnBrowser(A, { headed: HEADED });
  browser = launched.browser;
  assert("a throwaway Chrome connected with the freshly built extension", !!launched.clientId);
  if (!launched.clientId) return;

  const picked = await A.call("browser_select_client", { id: launched.clientId });
  assert("pinned to the browser this script launched", !isErr(picked), text(picked));
  if (isErr(picked)) return;

  const opened = await A.call("browser_new_tab", { url: base + "/plain.html" });
  assert("opened our own tab", !isErr(opened), text(opened));
  await sleep(1200);

  await a4(base);
  await a5(base);
  await a6(base);
  await a7(base);
  await a8(base, secureBase);
}

async function teardown() {
  try {
    await browser?.close();
  } catch {}
  A?.kill();
  try {
    plain?.close();
  } catch {}
  try {
    tls?.close();
  } catch {}
  if (certDir) {
    try {
      fs.rmSync(certDir, { recursive: true, force: true });
    } catch {}
  }
}

main()
  .catch((e) => {
    console.error("HARNESS_ERROR", e);
    checks.push({ name: "harness ran to completion", ok: false });
  })
  .finally(async () => {
    await teardown();
    const failed = checks.filter((c) => !c.ok);
    console.log("\n" + (checks.length - failed.length) + "/" + checks.length + " checks passed");
    if (failed.length && A) console.log("--- controller stderr ---\n" + A.getStderr().trim());
    process.exit(failed.length ? 1 : 0);
  });
