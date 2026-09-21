/**
 * Integration suite — a REAL Chrome, with the REAL built extension (roadmap B11).
 *
 * `npm run smoke` drives a FAKE browser: it proves an option left the server in
 * the right shape and that a reply rendered correctly. It can never prove Chrome
 * did the right thing with it. Every "[User] — needs a real browser" check in the
 * plan exists because of that gap. This closes the half a machine can do.
 *
 * Shape: fixture pages served from `scripts/fixtures/` over loopback → a Chrome
 * launched by Puppeteer with `--load-extension` pointed at the WXT build output →
 * the extension dials the relay → `dist/index.js` drives it over MCP stdio. The
 * plumbing, and the rule that keeps this off the user's own browser, live in
 * `scripts/lib/browser-harness.mjs`.
 *
 * Run:  npm run test:integration        (needs `npm run build` AND an extension
 *                                        build; add -- --headed to watch it)
 * Exit: 0 = all assertions passed, 1 = failure.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  disposeOwnBrowsers,
  init,
  isErr,
  launchOwnBrowser,
  makeController,
  requireFreshBuilds,
  settledRoster,
  sleep,
  startFixtureServer,
  text,
} from "./lib/browser-harness.mjs";

const HEADED = process.argv.includes("--headed");

// ── assertions ──────────────────────────────────────────────────────────────
const checks = [];

/**
 * What the run knows about itself, printed only when something failed. A FAIL
 * line on its own says a browser did the wrong thing; it does not say WHICH
 * browser, which build, or which page — and this suite drives two profiles now,
 * so "the browser" stopped being an answer on its own.
 */
const env = {
  browser: process.env.AUTOMATE_BROWSER_TEST_BROWSER || "puppeteer's bundled Chrome",
  headless: null,
  fixtures: null,
  clients: {},
  page: null,
};

/** The scenario currently running. Every check is filed under the one it ran in. */
let scenario = "startup";
const scene = (name) => {
  scenario = name;
  console.log(String.fromCharCode(10) + "== " + name + " ==");
};

const assert = (name, cond, detail) => {
  checks.push({ name, ok: !!cond, detail, scenario, page: env.page });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : "\n      " + detail}`);
};

/**
 * Refs are `e` + 4 base36 chars; a ref from a non-top frame is prefixed
 * `f<frameId>:`. Pull the ref off the snapshot line containing `needle` — the
 * suite never hard-codes one, because a stable-signature ref is derived, not
 * assigned, and hard-coding it would make the suite a copy of the algorithm.
 */
function refFor(snapshot, needle) {
  return refsFor(snapshot, needle)[0] ?? null;
}

/**
 * EVERY ref whose snapshot line mentions `needle`, in the order they appear.
 *
 * Normally there is one. A frame nested inside a cross-origin frame is listed
 * twice — once inline by its parent frame's walk, once as its own frame block —
 * and the two carry different prefixes, so a caller that needs a specific one has
 * to choose. See the nested case below for which and why.
 */
function refsFor(snapshot, needle) {
  const NL = String.fromCharCode(10);
  const out = [];
  for (const line of snapshot.split(NL)) {
    if (!line.includes(needle)) continue;
    const m = line.match(/\[ref=([^\]]+)\]/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * The navigation result behind `browser_navigate` / `browser_go_back` /
 * `browser_go_forward`: `settled`, `elapsedMs`, `urlBefore`, `urlAfter`. It rides
 * in `structuredContent`, and only when the call was made with
 * `includeSnapshot: false` — with a snapshot bundled the reply is the snapshot.
 */
const action = (r) => r?.result?.structuredContent?.action ?? {};

/** Read one expression out of the live page, exactly, rather than scraping text. */
async function evalIn(controller, expression) {
  return text(await controller.call("browser_eval", { expression }));
}

// ── the suite ───────────────────────────────────────────────────────────────
let server;
let A;
let B;
let C;
let D;

async function main() {
  requireFreshBuilds();

  server = await startFixtureServer();
  const base = "http://127.0.0.1:" + server.address().port;
  console.log("fixture server: " + base + "   headless: " + !HEADED);
  env.fixtures = base;
  env.headless = !HEADED;

  // Controller first: it spawns the relay (or joins one already running), so the
  // extension connects on its first try.
  A = makeController({ AUTOMATE_BROWSER_CLIENT_NAME: "IntegrationA" });
  await init(A, "integration");

  // Launches a throwaway Chrome and hands back ONLY a client this call started —
  // see the safety note in browser-harness.mjs.
  const launched = await launchOwnBrowser(A, { headed: HEADED });
  const ours = launched.clientId;
  const downloadDir = launched.downloadDir;
  assert("extension service worker starts in a headless Chrome", !!launched.serviceWorker);
  assert("the built extension connected to the relay as a new client", !!ours);
  if (!ours) return;

  // Pin to it. Everything after this line addresses our own throwaway Chrome by
  // id and can never wander onto a browser we did not start.
  env.clients.first = ours;
  const picked = await A.call("browser_select_client", { id: ours });
  assert("the suite pins itself to the browser it launched", !isErr(picked), text(picked));
  if (isErr(picked)) return;

  const opened = await A.call("browser_new_tab", { url: base + "/index.html" });
  assert("opened the fixture page in a real tab", !isErr(opened), text(opened));
  await sleep(1500);

  // ── refs survive a re-render (B12) ────────────────────────────────────────
  const snap1 = text(await A.call("browser_snapshot", {}));
  const goRef = refFor(snap1, "Say hello");
  assert("a snapshot of a real page yields a ref for the button", !!goRef, snap1.slice(0, 800));
  if (!goRef) return;

  const clicked = await A.call("browser_click", { element: "Say hello", ref: goRef });
  assert("clicking a real element by ref works", !isErr(clicked), text(clicked));
  const afterClick = text(await A.call("browser_read_page", { format: "text" }));
  assert(
    "the click actually changed the page",
    afterClick.includes("clicked"),
    afterClick.slice(0, 300),
  );

  // Re-render replaces every node and wipes every data-bmcp-ref attribute.
  const rerenderRef = refFor(snap1, "Re-render");
  await A.call("browser_click", { element: "Re-render the page", ref: rerenderRef });
  await sleep(1000);

  const snap2 = text(await A.call("browser_snapshot", {}));
  const goRef2 = refFor(snap2, "Say hello");
  assert(
    "the same element keeps the same ref across a re-render",
    goRef2 === goRef,
    goRef + " → " + goRef2,
  );

  // ── stale-ref recovery (B2) ──────────────────────────────────────────────
  // Wipe the tagging WITHOUT taking a new snapshot: the held ref now resolves to
  // nothing, and only the recovery walk can rescue the call.
  await A.call("browser_eval", {
    expression:
      "document.querySelectorAll('[data-bmcp-ref]').forEach(function(e){e.removeAttribute('data-bmcp-ref')}); " +
      "document.getElementById('status').textContent='idle'; 'wiped'",
  });
  const recovered = await A.call("browser_click", { element: "Say hello", ref: goRef });
  assert(
    "a ref whose tagging is gone recovers instead of failing",
    !isErr(recovered),
    text(recovered),
  );
  const afterRecover = text(await A.call("browser_read_page", { format: "text" }));
  assert(
    "the recovered click hit the right element",
    afterRecover.includes("clicked"),
    afterRecover.slice(0, 300),
  );

  // ── actionability refusal (B3) ───────────────────────────────────────────
  const snap3 = text(await A.call("browser_snapshot", {}));
  const blockedRef = refFor(snap3, "Cannot press me");
  const refused = blockedRef
    ? await A.call("browser_click", { element: "Cannot press me", ref: blockedRef })
    : null;
  assert(
    "a disabled button is refused, not silently clicked",
    !!refused && isErr(refused),
    text(refused),
  );
  assert(
    "the refusal names which check failed",
    !!refused && /not actionable|enabled|disabled/i.test(text(refused)),
    text(refused),
  );

  // ── cross-origin iframe (B5) ─────────────────────────────────────────────
  const frameRef = refFor(snap3, "Press me inside the frame");
  assert(
    "the snapshot reaches into a cross-origin iframe",
    !!frameRef && frameRef.startsWith("f"),
    frameRef ?? "(no frame ref in the snapshot)",
  );
  if (frameRef) {
    const frameClick = await A.call("browser_click", {
      element: "Press me inside the frame",
      ref: frameRef,
    });
    assert("clicking inside a cross-origin iframe works", !isErr(frameClick), text(frameClick));
    await sleep(600);
    const snap4 = text(await A.call("browser_snapshot", {}));
    assert(
      "the iframe click changed the frame's own content",
      snap4.includes("Frame button was pressed"),
      snap4.slice(0, 900),
    );
  }

  // ── a real download, with its path (B8) ──────────────────────────────────
  const dlRef = refFor(snap3, "Download the file");
  if (dlRef) {
    await A.call("browser_click", { element: "Download the file", ref: dlRef });
    const dl = text(await A.call("browser_downloads", { wait: true, timeout: 20 }));
    assert(
      "a real download reports its final path on disk",
      dl.includes("fixture-download"),
      dl.slice(0, 500),
    );
    assert(
      "the reported path is a real file",
      fs.existsSync(path.join(downloadDir, "fixture-download.txt")),
      "looked in " + downloadDir + ": " + (fs.readdirSync(downloadDir).join(", ") || "(empty)"),
    );
  } else {
    assert("a real download reports its final path on disk", false, "no ref for the download link");
  }

  // ── a ref held across a navigation is STALE, not a wrong-element click ───
  const beforeNav = refFor(snap3, "Say hello");
  await A.call("browser_navigate", { url: base + "/login.html", includeSnapshot: false });
  await sleep(600);
  const afterNav = await A.call("browser_click", { element: "Say hello", ref: beforeNav });
  assert("a ref held across a navigation fails as STALE_REF", isErr(afterNav), text(afterNav));
  assert(
    "the stale-ref error tells the agent to snapshot again",
    /STALE_REF|snapshot/i.test(text(afterNav)),
    text(afterNav),
  );

  // ── the rest of the actionability gate, on its own noisy page ────────────
  await A.call("browser_navigate", { url: base + "/gate.html", includeSnapshot: false });
  await sleep(800);
  const gateSnap = text(await A.call("browser_snapshot", {}));

  const coveredRef = refFor(gateSnap, "Button under an overlay");
  const covered = coveredRef
    ? await A.call("browser_click", { element: "Button under an overlay", ref: coveredRef })
    : null;
  assert(
    "a button under a full-cover overlay is refused",
    !!covered && isErr(covered),
    text(covered),
  );
  assert(
    "the refusal names the hit test, and what was in the way",
    !!covered && /hit-testable/i.test(text(covered)),
    text(covered),
  );

  // ── a CSS fade, in the two tabs that behave differently ──────────────────
  // These two checks asserted "the gate waits out a 300ms fade" and had been RED
  // since the agent stopped driving the user's foreground tab. Measured here on
  // 2026-09-01, in the background tab, mid-fade:
  //
  //     { hidden: true, inline opacity: "1", computed opacity: "0" }
  //
  // The script ran and set the target, and the transition never advanced off its
  // start value. **A CSS transition does not progress in a tab Chrome is not
  // drawing**, so the button never becomes visible and the gate is RIGHT to
  // refuse it. The old test asserted something unreachable in the tab the agent
  // actually works in. Both states are now checked for what is true in each.
  const revealRef = refFor(gateSnap, "Start the fade");
  const fadingRef = refFor(gateSnap, "Button that fades in");
  assert("the fade fixture is in the snapshot", !!revealRef && !!fadingRef, gateSnap.slice(0, 700));
  if (revealRef && fadingRef) {
    await A.call("browser_click", { element: "Start the fade", ref: revealRef });
    const faded = await A.call("browser_click", {
      element: "Button that fades in",
      ref: fadingRef,
    });
    assert(
      "a CSS fade never completes in a background tab, and the gate refuses rather than clicking a transparent element",
      isErr(faded) && /visible/i.test(text(faded)),
      text(faded),
    );
  }

  // The same fade in a FOREGROUND tab, where the transition does run: this is
  // the half that proves the gate WAITS rather than failing on the first poll.
  await A.call("browser_new_tab", { url: base + "/gate.html", active: true });
  await sleep(400);
  const fgSnap = text(await A.call("browser_snapshot", {}));
  const fgReveal = refFor(fgSnap, "Start the fade");
  const fgFading = refFor(fgSnap, "Button that fades in");
  if (fgReveal && fgFading) {
    await A.call("browser_click", { element: "Start the fade", ref: fgReveal });
    const fgFaded = await A.call("browser_click", {
      element: "Button that fades in",
      ref: fgFading,
    });
    assert("a button mid-fade IS waited out when the tab is drawn", !isErr(fgFaded), text(fgFaded));
    const fgPage = text(await A.call("browser_read_page", { format: "text" }));
    assert(
      "and that mid-fade click landed",
      fgPage.includes("fading pressed"),
      fgPage.slice(0, 300),
    );
  }
  // A page that never stops mutating: the settle cap is the only thing between
  // this call and a hang. Re-snapshotted rather than reusing `gateSnap`, because
  // the foreground check above left the agent driving a DIFFERENT tab — refs from
  // the old snapshot would be resolving against a page they did not come from.
  await A.call("browser_navigate", { url: base + "/gate.html", includeSnapshot: false });
  await sleep(400);
  const noisySnap = text(await A.call("browser_snapshot", {}));
  const ordinaryRef = refFor(noisySnap, "Ordinary button on a noisy page");
  assert("the noisy-page fixture is in the snapshot", !!ordinaryRef, noisySnap.slice(0, 700));
  if (ordinaryRef) {
    const started = Date.now();
    const noisy = await A.call("browser_click", { element: "Ordinary button", ref: ordinaryRef });
    const took = Date.now() - started;
    assert("a click on a permanently animating page returns", !isErr(noisy), text(noisy));
    assert("the settle cap holds it near a second, not forever", took < 5000, took + "ms");
  }

  // ── tools the PAGE declares (stage 9 D4) ─────────────────────────────────
  // The half that matters is the empty case: `list` on an ordinary page must
  // report "none" as a RESULT, because that is what every real site answers
  // today, and an error there would teach an agent to stop asking.
  const noTools = await A.call("browser_page_tools", { action: "list" });
  assert(
    "a page that declares no tools answers, rather than failing",
    !isErr(noTools),
    text(noTools),
  );
  assert(
    "and says plainly that there are none",
    /declares no tools/i.test(text(noTools)),
    text(noTools),
  );

  await A.call("browser_navigate", { url: base + "/page-tools.html", includeSnapshot: false });
  await sleep(400);
  const listed = text(await A.call("browser_page_tools", { action: "list" }));
  assert(
    "a declaring page lists its tools",
    /fixture_set_status/.test(listed),
    listed.slice(0, 400),
  );
  assert("and hands over each tool's argument names", /word\*/.test(listed), listed.slice(0, 400));

  const called = await A.call("browser_page_tools", {
    action: "call",
    name: "fixture_set_status",
    args: '{"word":"integration"}',
  });
  assert("calling one returns its result", !isErr(called), text(called));
  const afterCall = text(await A.call("browser_read_page", { format: "text" }));
  assert(
    "and the call actually ran in the page",
    afterCall.includes("integration"),
    afterCall.slice(0, 300),
  );

  const badJson = await A.call("browser_page_tools", {
    action: "call",
    name: "fixture_set_status",
    args: "{not json",
  });
  assert(
    "malformed args are refused by name, not thrown by the page",
    isErr(badJson),
    text(badJson),
  );
  assert(
    "and the refusal carries the BAD_ARGS code",
    /BAD_ARGS/.test(text(badJson)),
    text(badJson),
  );

  const missing = await A.call("browser_page_tools", { action: "call", name: "no_such_tool" });
  assert("calling a tool the page does not declare fails", isErr(missing), text(missing));
  assert(
    "and the failure lists what the page DOES offer",
    /fixture_set_status/.test(text(missing)),
    text(missing),
  );

  // ── a private window, refused (stage 9 D5) ───────────────────────────────
  // This browser is exactly a fresh install: the extension is NOT allowed in
  // private browsing, and only a person can change that. So the half that runs
  // here is the REFUSAL — which is the half our own code is responsible for.
  // The other half (the setting on, in both browsers) is
  // `node scripts/incognito-check.mjs`.
  const noIncognito = await A.call("browser_new_tab", {
    url: base + "/login.html",
    incognito: true,
  });
  assert("a private window is refused when the extension is not allowed one", isErr(noIncognito));
  assert(
    "the refusal names the exact setting, in both browsers' words",
    /Allow in Incognito/.test(text(noIncognito)) && /InPrivate/.test(text(noIncognito)),
    text(noIncognito),
  );
  assert(
    "and carries the INCOGNITO_BLOCKED code",
    /INCOGNITO_BLOCKED/.test(text(noIncognito)),
    text(noIncognito),
  );
  const stillDriving = await A.call("browser_read_page", { format: "text" });
  assert("a refused private window leaves the agent driving what it was", !isErr(stillDriving));

  // ── a strip of stills (stage 9 D6) ───────────────────────────────────────
  // The gate fixture's ticker rewrites the DOM every 50ms, so consecutive frames
  // of it MUST differ. That is the assertion that proves a strip captured motion
  // rather than the same picture four times, which is the failure a file count
  // would happily pass.
  await A.call("browser_navigate", { url: base + "/gate.html", includeSnapshot: false });
  await sleep(400);
  const noPath = await A.call("browser_screenshot", { frames: 4 });
  assert("a multi-frame strip without a filePath is refused", isErr(noPath), text(noPath));
  assert(
    "the refusal says why, and shows the naming",
    /BAD_ARGS/.test(text(noPath)) && /strip-01/.test(text(noPath)),
    text(noPath),
  );

  const stripDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-strip-"));
  const stripBase = path.join(stripDir, "strip.png");
  const strip = await A.call("browser_screenshot", {
    frames: 4,
    intervalMs: 150,
    filePath: stripBase,
  });
  assert("a strip of four frames is captured", !isErr(strip), text(strip));
  const stripFiles = [1, 2, 3, 4].map((n) => path.join(stripDir, `strip-0${n}.png`));
  assert(
    "every frame landed on disk, numbered in capture order",
    stripFiles.every((f) => fs.existsSync(f) && fs.statSync(f).size > 0),
    stripFiles.join("\n"),
  );
  assert(
    "the reply carries paths, never the images themselves",
    !/"type":"image"/.test(JSON.stringify(strip)) && text(strip).includes(stripFiles[3]),
    text(strip),
  );
  const firstFrame = fs.readFileSync(stripFiles[0]);
  const lastFrame = fs.readFileSync(stripFiles[3]);
  assert(
    "the frames differ from each other — the strip caught the page moving",
    !firstFrame.equals(lastFrame),
    `${firstFrame.length} vs ${lastFrame.length} bytes`,
  );
  fs.rmSync(stripDir, { recursive: true, force: true });

  // ── heap trend (stage 9 D7) ──────────────────────────────────────────────
  // The premise this feature rests on — that `performance.memory` returns a
  // usable number — cannot be verified by any gate without a browser, so it is
  // verified here. The leak is created from the test rather than baked into a
  // fixture: `browser_eval` runs in the page's MAIN world, so the allocations
  // land in exactly the heap the sampler reads.
  await A.call("browser_navigate", { url: base + "/index.html", includeSnapshot: false });

  const badWindow = await A.call("browser_perf_trace", { action: "memory", durationMs: 60000 });
  assert("a sampling window outside 1000-30000 is refused", isErr(badWindow), text(badWindow));
  assert(
    "the refusal names the bounds and the value it got",
    /BAD_ARGS/.test(text(badWindow)) && /60000/.test(text(badWindow)),
    text(badWindow),
  );

  const quiet = await A.call("browser_perf_trace", { action: "memory", durationMs: 1000 });
  assert(
    "performance.memory returns a real number on an ordinary page",
    !isErr(quiet),
    text(quiet),
  );
  assert(
    "the reply reports a window, samples in MB, and a trend",
    /JS heap over/.test(text(quiet)) && /trend /.test(text(quiet)) && /MB\/s/.test(text(quiet)),
    text(quiet),
  );
  assert(
    "growth is never presented as a leak",
    /not proof of a leak/.test(text(quiet)),
    text(quiet),
  );

  // ~1 MB retained every 250ms — an order of magnitude above the buckets Chrome
  // quantises usedJSHeapSize into, so a positive slope here is signal, not noise.
  await A.call("browser_eval", {
    expression:
      "(globalThis.__leak = [], globalThis.__leakTimer = setInterval(" +
      "() => globalThis.__leak.push(new Array(125000).fill(1.5)), 250), 'leaking')",
  });
  const leaking = await A.call("browser_perf_trace", { action: "memory", durationMs: 4000 });
  await A.call("browser_eval", {
    expression: "(clearInterval(globalThis.__leakTimer), globalThis.__leak = null, 'stopped')",
  });
  assert("a leaking page is sampled", !isErr(leaking), text(leaking));
  assert(
    "and the trend comes back POSITIVE — the one assertion that proves the fit works",
    /trend \+/.test(text(leaking)),
    text(leaking),
  );

  // No `heapsnapshot` sibling is tested because none exists. It was built on
  // 2026-09-05 and this suite is what killed it: Chrome answered
  // `{"code":-32601,"message":"'HeapProfiler.enable' wasn't found"}` — the domain
  // is not on `chrome.debugger`'s allow-list, and no extension can capture one.

  // ── accessibility audit (stage 9 D8) ─────────────────────────────────────
  // TWO premises are verified here, and the first is the one the plan got wrong.
  //
  // 1. axe-core runs in the ISOLATED world. The plan said MAIN. Nothing but a
  //    real browser can settle it: a11y.ts injects a 580 KB file and then calls
  //    into it across a second executeScript, so this checks both that the
  //    isolated world PERSISTS between the two calls and that axe can see enough
  //    of the page from there to find anything at all.
  // 2. The findings match what an independent checker reports. The fixture fails
  //    five named rules by construction, so "did it find them" is a count, not a
  //    judgement — which is what retires the [User] verification line.
  await A.call("browser_navigate", { url: base + "/a11y.html", includeSnapshot: false });

  // Snapshot FIRST: refs are `data-bmcp-ref` attributes the snapshot writes, so
  // an audit before any snapshot has no refs to map to. That ordering is the
  // feature, and getting it backwards is how the mapping would silently return
  // nothing while still passing a "did it find violations" check.
  const a11ySnap = text(await A.call("browser_snapshot", {}));
  // The unlabelled input is the only textbox on the fixture, and its missing
  // label is also one of the violations — so the same element is on both sides
  // of the mapping being checked.
  const fieldRef = refFor(a11ySnap, "textbox");

  const audit = await A.call("browser_issues", { audit: "a11y" });
  const auditText = text(audit);
  assert("axe-core runs in the ISOLATED world and returns a result", !isErr(audit), auditText);
  assert(
    "the report shows the page's OWN markup, not our snapshot tagging",
    !/data-bmcp-ref/.test(auditText),
    auditText.slice(0, 600),
  );

  // The five rules this fixture fails on purpose. Named individually rather than
  // counted, so a rule that stops firing is identified, not just missed.
  for (const rule of ["image-alt", "label", "button-name", "html-has-lang", "color-contrast"]) {
    assert(`the audit reports ${rule}`, auditText.includes(rule), auditText.slice(0, 1200));
  }

  assert(
    "the worst impact is reported first",
    auditText.indexOf("[critical]") < auditText.indexOf("[serious]"),
    auditText.slice(0, 600),
  );
  assert(
    "the per-rule example cap holds and the TRUE count still travels",
    /image-alt.*\(8 elements\)/.test(auditText) &&
      /\(\+3 more elements, same rule\)/.test(auditText),
    auditText.slice(0, 1200),
  );
  assert(
    "every audit states the floor, so a clean report cannot read as a pass",
    /a floor, not a pass/.test(auditText),
    auditText.slice(-300),
  );
  assert(
    "axe's own version is reported, so a report can be reproduced",
    /axe-core 4\.\d+\.\d+/.test(auditText),
    auditText.slice(0, 300),
  );

  // The mapping back to refs (9.7). Without this the agent gets a CSS selector
  // it cannot hand to any other tool.
  assert(
    "a violation maps back to the snapshot ref for that element",
    !!fieldRef && auditText.includes(fieldRef),
    `ref ${fieldRef} not found in audit:
${auditText.slice(0, 1500)}`,
  );

  // A page with no violations must still answer, and must still carry the floor.
  await A.call("browser_navigate", { url: base + "/gate.html", includeSnapshot: false });
  const clean = text(await A.call("browser_issues", { audit: "a11y" }));
  assert(
    "a page audits without error and reports how many rules PASSED",
    /rules passed\)/.test(clean),
    clean.slice(0, 400),
  );
  assert(
    "the floor is stated on a clean result too",
    /a floor, not a pass/.test(clean),
    clean.slice(-300),
  );

  // The audit must not have left itself on the page. MAIN-world injection would
  // have; this is the assertion that pins the deviation to ISOLATED.
  const leaked = text(await A.call("browser_eval", { expression: "typeof window.axe" }));
  assert(
    "axe is NOT left on the page — the audit runs in the isolated world",
    /undefined/.test(leaked),
    leaked.slice(0, 200),
  );

  // ── advanced mode must not reshape an interaction (D2) ───────────────────
  // The TRUSTED input path (CDP `Input.dispatch*`) returned a bare `{ok:true}`
  // until 2026-09-01: no `hit` naming what was under a coordinate, and no
  // post-action settle. Enabling the debugger for an unrelated reason therefore
  // changed both the shape and the timing of every click and key press.
  //
  // `npm run smoke` cannot catch this and never will — its fake browser answers
  // `browser_click` itself and dispatches no real input — so this suite is the
  // only gate that exercises the trusted path at all.
  // `active: true` is REQUIRED here, and that is the finding this block records.
  // Chrome discards trusted input aimed at a tab it is not drawing, so the agent's
  // usual BACKGROUND tab refuses the trusted path outright. Testing it needs a
  // foreground tab; using one is not the test cheating, it is the only state in
  // which trusted input exists at all.
  await A.call("browser_new_tab", { url: base + "/index.html", active: true });
  const advOn = await A.call("browser_advanced_mode", { enable: true });
  assert("advanced mode attaches the debugger", !isErr(advOn), text(advOn));

  if (!isErr(advOn)) {
    // Ask the page where the button is rather than hard-coding a pixel: font
    // metrics differ between machines, and a wrong coordinate would fail this
    // test for a reason that has nothing to do with what it checks.
    const where = await A.call("browser_eval", {
      function:
        "() => { const r = document.getElementById('go').getBoundingClientRect();" +
        " return Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2); }",
    });
    const at = text(where).match(/(\d+),(\d+)/);
    assert("located the button for a coordinate click", !!at, text(where));

    if (at) {
      const trusted = await A.call("browser_click", { x: Number(at[1]), y: Number(at[2]) });
      assert(
        "a TRUSTED coordinate click still names what was under the point",
        !isErr(trusted) && /hit\s+<button#go>/.test(text(trusted)),
        text(trusted),
      );
      const landed = text(await A.call("browser_read_page", { format: "text" }));
      assert(
        "and that trusted click actually landed on the page",
        landed.includes("clicked"),
        landed.slice(0, 200),
      );
    }

    // The key press is the more damaging half: Enter is how a form is submitted,
    // so a missing settle returns before the page has begun to react. Same tab,
    // which is still the foreground one.
    await A.call("browser_navigate", { url: base + "/login.html", includeSnapshot: false });
    const loginSnap = text(await A.call("browser_snapshot", {}));
    const userRef = refFor(loginSnap, "User");
    if (userRef) {
      await A.call("browser_type", { element: "User", ref: userRef, text: "ada", submit: false });
      const enter = await A.call("browser_press_key", { key: "Enter" });
      assert("a TRUSTED Enter is accepted", !isErr(enter), text(enter));
      const submitted = text(await A.call("browser_read_page", { format: "text" }));
      assert(
        "and the form reacted to it — the settle did not return early",
        /wrong credentials|welcome ada/.test(submitted),
        submitted.slice(0, 200),
      );
    }
    await A.call("browser_advanced_mode", { enable: false });
  }

  // ── embedded-form routing (B08) ──────────────────────────────────────────
  // Everything here needs a REAL frame tree. A unit test can prove the worker
  // aimed an injection at frame 3; only a browser can prove frame 3 is where the
  // field actually was, and that the value landed in it.
  await A.call("browser_navigate", {
    url: base + "/stage10-frame-form.html",
    includeSnapshot: false,
  });
  await sleep(800); // the nested frame is created by script, one boundary down
  const formSnap = text(await A.call("browser_snapshot", {}));

  const topRef = refFor(formSnap, "Parent field");
  const sameRef = refFor(formSnap, "same text field");
  const crossRef = refFor(formSnap, "cross text field");
  // A frame nested inside the cross-origin one is printed TWICE: once inline by
  // frame N's own walk (as `fN:<ref>.1`, because that walk had already seen the
  // same signature) and once as its own frame block (as `fM:<ref>`). Only the
  // second matches the `data-bmcp-ref` attribute actually left in the DOM — the
  // nested frame's own tagging pass ran last and overwrote the inline one. That
  // double-print is a real snapshot defect, recorded for the plan rather than
  // fixed here (changing it would move same-origin frames out of the inline tree,
  // which is a shape change, not a bug fix). This picks the usable one: the ref
  // whose frame prefix is NOT the cross-origin frame's.
  const crossFramePrefix = (crossRef ?? "").split(":")[0] + ":";
  const nestedRef =
    refsFor(formSnap, "nested text field").find((r) => !r.startsWith(crossFramePrefix)) ?? null;

  assert("the snapshot offers a top-page form field", !!topRef, formSnap.slice(0, 1200));
  assert(
    "the snapshot reaches the same-origin frame's field",
    !!sameRef,
    sameRef ?? formSnap.slice(0, 1800),
  );
  assert(
    "the snapshot reaches the cross-origin frame's field, and prefixes it",
    !!crossRef && crossRef.startsWith("f"),
    crossRef ?? formSnap.slice(0, 1800),
  );
  assert(
    "the snapshot reaches a frame nested inside the cross-origin one",
    !!nestedRef,
    nestedRef ?? formSnap.slice(0, 2600),
  );

  // Every document is walked ONCE, by its own injection. A frame used to be
  // walked twice when its parent could reach its `contentDocument` — inline by
  // the parent and again as itself — which printed its fields twice under two
  // different refs, only one of which matched what was left tagged in the DOM.
  assert(
    "a nested frame's field is listed exactly ONCE",
    refsFor(formSnap, "nested text field").length === 1,
    refsFor(formSnap, "nested text field").join(", "),
  );
  assert(
    "a same-origin frame's field is listed exactly once too",
    refsFor(formSnap, "same text field").length === 1,
    refsFor(formSnap, "same text field").join(", "),
  );
  assert(
    "a same-origin frame's ref carries its frame prefix, like any other frame",
    !!sameRef && sameRef.startsWith("f"),
    sameRef ?? "(none)",
  );

  // A `srcdoc` frame has no url and inherits the parent's origin. Now that the
  // parent walk stops at the <iframe> marker, this field is reachable ONLY if
  // Chrome enumerates the frame for `executeScript` — so this assertion is what
  // keeps "every document is walked by its own injection" from being an
  // assumption.
  // An invisible frame contributes no marker line. The walk cannot drop it by
  // "found nothing inside" any more, because it no longer looks inside — so
  // visibility is what does the dropping, and this is the check that says so.
  // Counted in the TOP tree only — everything from the first `- frame` heading on
  // belongs to another document, and the cross-origin frame emits a marker of its
  // own for the frame nested inside it.
  const topTree = formSnap.split(String.fromCharCode(10));
  const firstBlock = topTree.findIndex((l) => /^- frame /.test(l.trim()));
  const iframeMarkers = topTree
    .slice(0, firstBlock === -1 ? topTree.length : firstBlock)
    .filter((l) => /- iframe$/.test(l));
  assert(
    "a hidden tracking-pixel frame contributes no marker to the tree",
    iframeMarkers.length === 3,
    iframeMarkers.length + " markers in the top tree (expected same-origin, cross-origin, srcdoc)",
  );

  const srcdocRef = refFor(formSnap, "srcdoc text field");
  assert(
    "a srcdoc frame is still reached, now that the parent walk stops at the marker",
    !!srcdocRef,
    formSnap.slice(0, 3000),
  );
  if (srcdocRef) {
    const fill = await A.call("browser_fill_form", {
      fields: [{ ref: srcdocRef, value: "filled-srcdoc" }],
    });
    assert("and a srcdoc frame's field can be filled", !isErr(fill), text(fill));
    const back = await A.call("browser_eval", {
      function: "(el) => el.value",
      args: [srcdocRef],
    });
    assert(
      "and the value landed in the srcdoc frame",
      text(back).includes("filled-srcdoc"),
      text(back),
    );
  }

  // The reproduction: this exact call used to fill ZERO fields, because the
  // prefixed ref was searched for as a literal attribute in the top document.
  if (crossRef) {
    const crossFill = await A.call("browser_fill_form", {
      fields: [{ ref: crossRef, value: "filled-cross" }],
    });
    assert(
      "a cross-origin frame's field is filled, not reported missing",
      !isErr(crossFill) && /1\s*\/\s*1|filled 1/i.test(text(crossFill)),
      text(crossFill),
    );
    const readBack = await A.call("browser_eval", {
      function: "(el) => el.value",
      args: [crossRef],
    });
    assert(
      "and the value is really in the field inside that frame",
      text(readBack).includes("filled-cross"),
      text(readBack),
    );
  }

  if (nestedRef) {
    const nestedFill = await A.call("browser_fill_form", {
      fields: [{ ref: nestedRef, value: "filled-nested" }],
    });
    assert("a field two frames down is filled", !isErr(nestedFill), text(nestedFill));
    const readNested = await A.call("browser_eval", {
      function: "(el) => el.value",
      args: [nestedRef],
    });
    assert(
      "and the nested value landed in the nested frame",
      text(readNested).includes("filled-nested"),
      text(readNested),
    );
  }

  // A batch that spans frames, in an order that crosses back. This is the
  // property the consecutive-run grouping exists for: gathering each frame's
  // fields together would fill the third before the second.
  if (topRef && crossRef && sameRef) {
    const mixed = await A.call("browser_fill_form", {
      fields: [
        { ref: topRef, value: "mixed-top" },
        { ref: crossRef, value: "mixed-cross" },
        { ref: sameRef, value: "mixed-same" },
      ],
    });
    assert("a batch spanning three frames reports all three filled", !isErr(mixed), text(mixed));
    // Read back ONE REF PER CALL. `browser_eval` refuses a mixed-frame argument
    // list by design (B07), so three refs from three frames cannot share a call —
    // which is itself the first fix of this stage working as intended.
    const readEach = [];
    for (const ref of [topRef, crossRef, sameRef]) {
      readEach.push(
        text(await A.call("browser_eval", { function: "(el) => el.value", args: [ref] })),
      );
    }
    assert(
      "every field of the mixed batch got ITS OWN value, in its own frame",
      readEach[0].includes("mixed-top") &&
        readEach[1].includes("mixed-cross") &&
        readEach[2].includes("mixed-same"),
      readEach.join(" / "),
    );
  }

  // Failure attribution across frames: a bad ref in the middle must be reported
  // as the ref the caller wrote, and must not take the good fields down with it.
  if (topRef && crossRef) {
    const partial = await A.call("browser_fill_form", {
      fields: [
        { ref: topRef, value: "attributed-top" },
        { ref: "f9999:e0000", value: "nowhere" },
        { ref: crossRef, value: "attributed-cross" },
      ],
    });
    assert(
      "a batch with one unreachable field still reports per-field, not all-or-nothing",
      /f9999:e0000/.test(text(partial)),
      text(partial),
    );
  }

  // Clear, through the same reference rules.
  if (crossRef) {
    const cleared = await A.call("browser_clear", { ref: crossRef });
    assert("a cross-origin frame's field can be cleared", !isErr(cleared), text(cleared));
    const afterClear = await A.call("browser_eval", {
      function: "(el) => JSON.stringify(el.value)",
      args: [crossRef],
    });
    assert(
      "and the clear emptied the field in that frame",
      text(afterClear).includes('""'),
      text(afterClear),
    );
  }

  // ── the three siblings B08 names, reproduced rather than assumed ──────────
  // Each is a tool that takes a ref and resolves it somewhere other than through
  // the forms path. The assertion is deliberately weak: either it works on a
  // frame ref, or it refuses in a way that says WHY. What must not happen is a
  // "not found — take a fresh snapshot" that sends the agent back for the same
  // ref it already has.
  // Either it worked, or the refusal NAMES THE FRAME as the reason. What must
  // never happen is "not found — take a fresh browser_snapshot": the ref is
  // correct, and a fresh snapshot hands back the very same one.
  const explains = (r) =>
    !isErr(r) ||
    (/(frame \d+|cross-origin frame)/i.test(text(r)) &&
      !/take a fresh browser_snapshot/i.test(text(r)));

  if (crossRef) {
    const shotPath = path.join(downloadDir, "b08-frame-crop.png");
    const crop = await A.call("browser_screenshot", { ref: crossRef, filePath: shotPath });
    assert(
      "screenshot on a CROSS-origin frame ref says the frame is why it cannot crop",
      explains(crop),
      text(crop),
    );
  }
  // A same-origin frame CAN be cropped: its offset in the page is measurable from
  // inside it, by walking up `frameElement`. Only a cross-origin hop breaks that
  // chain, and only then is the refusal the honest answer.
  if (sameRef) {
    const samePath = path.join(downloadDir, "b08-same-origin-crop.png");
    const crop = await A.call("browser_screenshot", { ref: sameRef, filePath: samePath });
    assert("screenshot crops an element inside a same-origin frame", !isErr(crop), text(crop));
    assert(
      "and that crop is a real file on disk",
      fs.existsSync(samePath) && fs.statSync(samePath).size > 0,
      samePath,
    );
  }

  const upFile = path.join(downloadDir, "b08-upload.txt");
  fs.writeFileSync(upFile, "b08\n");
  await A.call("browser_advanced_mode", { enable: true });

  // The CROSS-ORIGIN case: a documented refusal, because one debugger session
  // does not reach another origin's frame.
  const crossUploadRef = refFor(formSnap, "cross upload field");
  if (crossUploadRef) {
    const up = await A.call("browser_upload_file", { ref: crossUploadRef, filePaths: [upFile] });
    assert(
      "upload on a cross-origin frame ref says the frame is why it cannot",
      explains(up),
      text(up),
    );
  }
  const crossClickRef = refFor(formSnap, "cross submit button");
  if (crossClickRef) {
    const trusted = await A.call("browser_click", { element: "cross submit", ref: crossClickRef });
    assert(
      "a trusted click on a cross-origin frame ref says the frame is why it cannot",
      explains(trusted),
      text(trusted),
    );
  }

  // The SAME-ORIGIN case: this one has to WORK. Its refs are bare, because the
  // top walk lists them inline, and the old top-level `querySelector` missed them
  // anyway — reporting a ref missing that was never wrong.
  const sameUploadRef = refFor(formSnap, "same upload field");
  if (sameUploadRef) {
    const up = await A.call("browser_upload_file", { ref: sameUploadRef, filePaths: [upFile] });
    assert("upload reaches a file input inside a same-origin frame", !isErr(up), text(up));
    const named = await A.call("browser_eval", {
      function: "(el) => (el.files[0] ? el.files[0].name : 'none')",
      args: [sameUploadRef],
    });
    assert(
      "and the file really is on that input, in its own frame",
      text(named).includes("b08-upload"),
      text(named),
    );
  }
  const sameClickRef = refFor(formSnap, "same submit button");
  if (sameClickRef) {
    const trusted = await A.call("browser_click", { element: "same submit", ref: sameClickRef });
    assert("a trusted click reaches a same-origin frame's button", !isErr(trusted), text(trusted));
    const landed = await A.call("browser_eval", {
      function: "(el) => el.dataset.clicked || 'no'",
      args: [sameClickRef],
    });
    assert(
      "and it landed on THAT button, not on whatever sat at the same point up top",
      text(landed).includes("yes"),
      text(landed),
    );
  }
  await A.call("browser_advanced_mode", { enable: false });

  // ── navigation lifecycle (B09) ───────────────────────────────────────────
  // A unit test can prove the worker waited for a scripted pair of events. Only
  // a browser can prove that Chrome's real events arrive in that shape, and that
  // `settled: true` names the document now on screen. The fixture blocks its own
  // load for `spin` ms, which is what turns "returned too early" into a number.
  {
    const NAV = base + "/stage10-navigation.html";
    const slow = await A.call("browser_navigate", {
      url: NAV + "?delay=900",
      includeSnapshot: false,
    });
    assert("the slow fixture loads", !isErr(slow), text(slow));
    const firstNonce = await evalIn(A, "window.__stage10.nonce");

    // The B09 repro. Before the fix this came back `settled: true` in 0 ms,
    // because the tab still reported the document being replaced as complete.
    const reloaded = await A.call("browser_navigate", { reload: true, includeSnapshot: false });
    const r = action(reloaded);
    assert(
      "a reload reports settled once the page has actually loaded",
      r.settled === true,
      JSON.stringify(r),
    );
    assert(
      "and it cannot report that before the new document has been built",
      r.elapsedMs >= 600,
      "elapsedMs=" + r.elapsedMs + " against a 900ms page",
    );
    const secondNonce = await evalIn(A, "window.__stage10.nonce");
    assert(
      "the document the reload settled on is a NEW one",
      firstNonce && secondNonce && firstNonce !== secondNonce,
      firstNonce + " -> " + secondNonce,
    );

    // A fragment move never loads at all. Waiting for a load event here would
    // hang the call for its whole budget rather than return.
    const frag = action(
      await A.call("browser_navigate", { url: NAV + "#deep", includeSnapshot: false }),
    );
    assert(
      "a same-document move returns instead of hanging",
      frag.settled === true,
      JSON.stringify(frag),
    );
    assert("and returns promptly", frag.elapsedMs < 5000, "elapsedMs=" + frag.elapsedMs);

    // `browser_go_back` / `browser_go_forward` always bundle a snapshot and take
    // no `includeSnapshot`, so their `settled` never reaches a caller — the clock
    // and the resulting url are what a client can actually observe, and a hang
    // would show in both.
    const backAt = Date.now();
    const back = await A.call("browser_go_back", {});
    const backMs = Date.now() - backAt;
    assert("back out of a fragment returns", !isErr(back), text(back).slice(0, 200));
    assert("and does not sit out its 10s budget", backMs < 5000, "took " + backMs + "ms");
    assert(
      "landing on the document without the fragment",
      !(await evalIn(A, "location.hash")).includes("deep"),
      await evalIn(A, "location.href"),
    );

    const fwdAt = Date.now();
    const forward = await A.call("browser_go_forward", {});
    const fwdMs = Date.now() - fwdAt;
    assert("and forward into it again", !isErr(forward), text(forward).slice(0, 200));
    assert("also without hanging", fwdMs < 5000, "took " + fwdMs + "ms");
    assert(
      "back at the fragment",
      (await evalIn(A, "location.hash")).includes("deep"),
      await evalIn(A, "location.href"),
    );

    // A redirect ends the transition somewhere other than where it was pointed,
    // and leaves no intermediate completion for the watcher to settle on.
    const hop = action(
      await A.call("browser_navigate", { url: NAV + "?redirect=1", includeSnapshot: false }),
    );
    assert(
      "a redirected navigation settles on where it landed",
      hop.settled === true,
      JSON.stringify(hop),
    );
    assert(
      "and reports the url it ended at, not the one it was given",
      typeof hop.urlAfter === "string" && hop.urlAfter.includes("from=redirect"),
      hop.urlAfter,
    );

    // The two ways of deliberately not waiting. Neither may claim a settle.
    const nowait = action(
      await A.call("browser_navigate", {
        url: NAV + "?delay=900",
        waitUntil: "none",
        includeSnapshot: false,
      }),
    );
    assert(
      "waitUntil none does not wait",
      nowait.settled === false && nowait.elapsedMs < 500,
      JSON.stringify(nowait),
    );

    const capped = action(
      await A.call("browser_navigate", {
        url: NAV + "?delay=2500",
        settleMs: 300,
        includeSnapshot: false,
      }),
    );
    assert(
      "settleMs caps the wait and reports the page as unsettled rather than lying",
      capped.settled === false && capped.elapsedMs < 1500,
      JSON.stringify(capped),
    );
  }

  // ── an init script survives long enough to run (B09, second half) ────────
  // The failure this covers was silent: the call answered `initScript:
  // "installed"` and the script was removed before any document could run it.
  {
    const NAV = base + "/stage10-navigation.html";
    await A.call("browser_advanced_mode", { enable: true });
    await A.call("browser_navigate", {
      url: NAV + "?delay=700",
      initScript: "window.__stage10Init = 'armed'",
      includeSnapshot: false,
    });
    assert(
      "an init script runs in the document the navigation was waiting for",
      (await evalIn(A, "window.__stage10.init")).includes("armed"),
      await evalIn(A, "String(window.__stage10.init)"),
    );

    // The same, without waiting — the path that used to tear the script down
    // before the navigation had even committed.
    await A.call("browser_navigate", { url: NAV, includeSnapshot: false });
    await A.call("browser_navigate", {
      url: NAV + "?delay=700",
      waitUntil: "none",
      initScript: "window.__stage10Init = 'armed-nowait'",
      includeSnapshot: false,
    });
    await sleep(2000);
    assert(
      "and still runs when the caller chose not to wait for the load",
      (await evalIn(A, "window.__stage10.init")).includes("armed-nowait"),
      await evalIn(A, "String(window.__stage10.init)"),
    );

    // And it is gone again afterwards: a later navigation must be clean.
    await A.call("browser_navigate", { url: NAV, includeSnapshot: false });
    assert(
      "and is torn down, so the next page is not still carrying it",
      (await evalIn(A, "String(window.__stage10.init)")).includes("null"),
      await evalIn(A, "String(window.__stage10.init)"),
    );
    await A.call("browser_advanced_mode", { enable: false });
  }

  // ── radio values (B10) ───────────────────────────────────────────────────
  // A unit test proves the injected function sets `checked` correctly. Only a
  // browser has a radio GROUP: the sibling that the browser itself unselects
  // when one is chosen, and that a mishandled value would displace. That is the
  // half a fake DOM cannot have.
  {
    await A.call("browser_navigate", { url: base + "/", includeSnapshot: false });
    const snap = text(await A.call("browser_snapshot", {}));
    const standard = refFor(snap, "Standard delivery");
    const express = refFor(snap, "Express delivery");
    const gift = refFor(snap, "Gift wrap");
    assert("the snapshot offers the radio group", !!standard && !!express, snap.slice(0, 400));

    // `[standard, express, overnight]`, read straight off the live group.
    const group = () =>
      evalIn(
        A,
        "JSON.stringify(Array.from(document.querySelectorAll('input[name=speed]')).map(function (r) { return r.checked; }))",
      );

    assert(
      "the group starts with the first option selected",
      (await group()).includes("[true,false,false]"),
      await group(),
    );

    await A.call("browser_fill_form", { fields: [{ ref: express, value: "true" }] });
    assert(
      "true selects an option and the browser unselects its sibling",
      (await group()).includes("[false,true,false]"),
      await group(),
    );

    // The B10 repro. Before the fix this SELECTED the option it was told to
    // clear, and reported full success doing it.
    const cleared = await A.call("browser_fill_form", {
      fields: [{ ref: express, value: "false" }],
    });
    assert("false on a radio is accepted", !isErr(cleared), text(cleared));
    assert(
      "and actually clears it, leaving the group with nothing selected",
      (await group()).includes("[false,false,false]"),
      await group(),
    );

    // False against an ALREADY-unselected option must be a no-op, not a select —
    // and must not re-select whatever the page last had.
    await A.call("browser_fill_form", { fields: [{ ref: standard, value: "false" }] });
    assert(
      "false on an unselected option changes nothing",
      (await group()).includes("[false,false,false]"),
      await group(),
    );

    // A value that is neither is the mistake worth catching: it is how a <select>
    // is filled, and it used to select the radio.
    const refused = await A.call("browser_fill_form", {
      fields: [{ ref: standard, value: "Standard" }],
    });
    assert(
      "an unsupported radio value is refused, not silently obeyed",
      /not a radio value/.test(text(refused)),
      text(refused),
    );
    assert(
      "and the refusal left the group alone",
      (await group()).includes("[false,false,false]"),
      await group(),
    );

    // Back to a normal selection, so the group ends usable.
    await A.call("browser_fill_form", { fields: [{ ref: standard, value: "true" }] });
    assert(
      "the group can be set again after all that",
      (await group()).includes("[true,false,false]"),
      await group(),
    );

    // The checkbox shares the branch and must be untouched by the radio fix.
    await A.call("browser_fill_form", { fields: [{ ref: gift, value: "true" }] });
    assert(
      "a checkbox still checks",
      (await evalIn(A, "giftwrap.checked")).includes("true"),
      await evalIn(A, "String(giftwrap.checked)"),
    );
    await A.call("browser_fill_form", { fields: [{ ref: gift, value: "false" }] });
    assert(
      "and still unchecks",
      (await evalIn(A, "String(giftwrap.checked)")).includes("false"),
      await evalIn(A, "String(giftwrap.checked)"),
    );
  }

  // ── origin refusal (B9) ──────────────────────────────────────────────────
  // A SECOND controller, configured to deny the fixture's origin, must refuse to
  // drive the very tab the first one is happily driving.
  B = makeController({
    AUTOMATE_BROWSER_CLIENT_NAME: "IntegrationB",
    AUTOMATE_BROWSER_DENY_ORIGINS: "http://127.0.0.1:*",
  });
  await init(B);
  await B.call("browser_select_client", { id: ours });
  const denied = await B.call("browser_navigate", {
    url: base + "/login.html",
    includeSnapshot: false,
  });
  assert("a denied origin is refused before the browser is touched", isErr(denied), text(denied));
  assert("the refusal names the deny list", /DENY_ORIGINS|deny/i.test(text(denied)), text(denied));

  // An allow-list of somewhere else refuses the fixture just as firmly.
  C = makeController({
    AUTOMATE_BROWSER_CLIENT_NAME: "IntegrationC",
    AUTOMATE_BROWSER_ALLOW_ORIGINS: "https://allowed.example",
  });
  await init(C);
  await C.call("browser_select_client", { id: ours });
  const offList = await C.call("browser_navigate", {
    url: base + "/login.html",
    includeSnapshot: false,
  });
  assert("an origin outside the allow-list is refused", isErr(offList), text(offList));
  assert(
    "that refusal names the origin and the setting",
    /ALLOW_ORIGINS/.test(text(offList)) && text(offList).includes("127.0.0.1"),
    text(offList),
  );

  // ── and an unrestricted controller is unaffected ─────────────────────────
  const stillWorks = await A.call("browser_navigate", {
    url: base + "/login.html",
    includeSnapshot: false,
  });
  assert(
    "an unrestricted controller still drives the same origin",
    !isErr(stillWorks),
    text(stillWorks),
  );

  // ── interaction two frames down (I03) ────────────────────────────────────
  // B08 proved a field TWO boundaries down can be FILLED. Nothing else that
  // takes a ref was tried there, and each of them resolves a ref by its own
  // path: `fill_form` injects into the frame that owns the field, the
  // interaction engine aims an event at a point, `select_option` walks options.
  // A frame inside a cross-origin frame is where those paths stop agreeing.
  //
  // Every assertion here is a PAIR: the nested field got it, and the identically
  // shaped field one frame up did not. The cross-origin frame and the frame
  // inside it are the same document served twice, so "a field called 'text
  // field' holds the value" is true of the wrong frame too — the pair is the
  // only thing separating the right answer from one that merely looks right.
  scene("interaction two frames down");
  env.page = base + "/stage10-frame-form.html";
  await A.call("browser_navigate", { url: env.page, includeSnapshot: false });
  await sleep(900); // the nested frame is created by script, one boundary down
  const deepSnap = text(await A.call("browser_snapshot", {}));

  const xText = refFor(deepSnap, "cross text field");
  // The nested frame is printed twice — see the B08 note above. The usable ref
  // is the one whose prefix is NOT the cross-origin frame's, because the nested
  // frame's own tagging pass ran last and is what the DOM actually carries.
  const xPrefix = (xText ?? String.fromCharCode(0)).split(":")[0] + ":";
  const deepRef = (needle) => refsFor(deepSnap, needle).find((r) => !r.startsWith(xPrefix)) ?? null;

  const nText = deepRef("nested text field");
  const nPick = deepRef("nested pick field");
  const nAgree = deepRef("nested agree box");
  const nSubmit = deepRef("nested submit button");
  const xPick = refFor(deepSnap, "cross pick field");
  const xAgree = refFor(deepSnap, "cross agree box");
  const xSubmit = refFor(deepSnap, "cross submit button");
  assert(
    "the snapshot offers every nested-frame control, and its cross-frame twin",
    !!(nText && nPick && nAgree && nSubmit && xText && xPick && xAgree && xSubmit),
    JSON.stringify({ nText, nPick, nAgree, nSubmit, xText, xPick, xAgree, xSubmit }),
  );

  /** One element, one expression, read out of whichever frame it lives in. */
  const readRef = async (ref, fn) =>
    text(await A.call("browser_eval", { function: fn, args: [ref] }));

  if (nText && xText) {
    // Seed the frame one level up, so "unchanged" is a value and not an absence.
    await A.call("browser_fill_form", { fields: [{ ref: xText, value: "cross-seed" }] });
    const typed = await A.call("browser_type", {
      element: "nested text field",
      ref: nText,
      text: "typed-two-deep",
      submit: false,
    });
    assert("browser_type reaches a field two frames down", !isErr(typed), text(typed));
    const landed = await readRef(nText, "(el) => el.value");
    assert("and the text is in the NESTED field", landed.includes("typed-two-deep"), landed);
    const twin = await readRef(xText, "(el) => el.value");
    assert(
      "and the identically named field one frame up is untouched",
      twin.includes("cross-seed") && !twin.includes("typed-two-deep"),
      twin,
    );
  }

  if (nPick && xPick) {
    const chosen = await A.call("browser_select_option", {
      element: "nested pick field",
      ref: nPick,
      values: ["two"],
    });
    assert("browser_select_option reaches a select two frames down", !isErr(chosen), text(chosen));
    const chose = await readRef(nPick, "(el) => el.value");
    assert("and the nested select holds the chosen option", chose.includes("two"), chose);
    const twinPick = await readRef(xPick, "(el) => JSON.stringify(el.value)");
    assert("and the select one frame up chose nothing", twinPick.includes('""'), twinPick);
  }

  if (nAgree && xAgree) {
    const ticked = await A.call("browser_click", { element: "nested agree box", ref: nAgree });
    assert("browser_click ticks a checkbox two frames down", !isErr(ticked), text(ticked));
    const isOn = await readRef(nAgree, "(el) => String(el.checked)");
    assert("and that checkbox is the one that got ticked", isOn.includes("true"), isOn);
    const twinBox = await readRef(xAgree, "(el) => String(el.checked)");
    assert("and the checkbox one frame up is still clear", twinBox.includes("false"), twinBox);
  }

  if (nSubmit && xSubmit) {
    // The button records its own click ON ITSELF. A click aimed at the wrong
    // frame's coordinates lands on whatever sits at that point and still reports
    // success, so reading the flag back off each button is what tells them apart.
    const pressed = await A.call("browser_click", { element: "nested submit", ref: nSubmit });
    assert("browser_click presses a button two frames down", !isErr(pressed), text(pressed));
    const self = await readRef(nSubmit, "(el) => el.dataset.clicked || 'no'");
    assert("and the nested button recorded the press on itself", self.includes("yes"), self);
    const twinBtn = await readRef(xSubmit, "(el) => el.dataset.clicked || 'no'");
    assert(
      "and the button one frame up was never pressed",
      twinBtn.includes("no") && !twinBtn.includes("yes"),
      twinBtn,
    );
  }

  // ── a partial fill, counted by the page (I03) ────────────────────────────
  // "Filled 2/3" is the server describing itself. What matters is WHICH two, and
  // whether the third left a mark — a fill that reports a refusal and half-writes
  // the field anyway is the failure this scenario exists to catch. The fixture
  // counts the `input`/`change` events its own document received, so the count is
  // the PAGE's rather than the reply's, and the two are free to disagree.
  scene("a partial fill, counted by the page");
  const topField = refFor(deepSnap, "Parent field");
  const topChoice = refFor(deepSnap, "Parent choice");
  const sameText = refFor(deepSnap, "same text field");
  if (topField && topChoice && sameText) {
    await A.call("browser_eval", { expression: "window.__stage10Reset()" });
    const partial = await A.call("browser_fill_form", {
      fields: [
        { ref: topField, value: "kept-top" },
        // A REAL element that refuses for a real reason — no matching option. A
        // bogus ref only proves the resolver can miss; this proves a field that
        // WAS found and declined is reported as declined and left alone.
        { ref: topChoice, value: "gamma" },
        { ref: sameText, value: "kept-same" },
      ],
    });
    assert(
      "a fill where one field of three refuses is not reported as a failed call",
      !isErr(partial),
      text(partial),
    );
    assert("and the count is the honest one", /2\s*\/\s*3/.test(text(partial)), text(partial));
    assert(
      "and the refusal names the field and why",
      text(partial).includes(topChoice) && /no <option> matched/i.test(text(partial)),
      text(partial),
    );
    // I04. `isErr` above is the OLD question, and it has only two answers — so
    // "two of three" came back indistinguishable from "three of three". The
    // outcome is the field that tells them apart, and it has to survive the real
    // wire, not just a stub.
    assert(
      "and the outcome says partial, which the error flag alone cannot",
      partial?.result?.outcome === "partial",
      JSON.stringify(partial?.result?.outcome),
    );
    const partialStruct = partial?.result?.structuredContent;
    assert(
      "and the per-field verdicts come back structured as well as in prose",
      partialStruct?.filled === 2 &&
        partialStruct?.total === 3 &&
        partialStruct?.errors?.length === 1 &&
        partialStruct.errors[0]?.ref === topChoice,
      JSON.stringify(partialStruct),
    );

    const keptTop = await readRef(topField, "(el) => el.value");
    const keptSame = await readRef(sameText, "(el) => el.value");
    const refused = await readRef(topChoice, "(el) => JSON.stringify(el.value)");
    assert("the field before the refusal holds its value", keptTop.includes("kept-top"), keptTop);
    assert(
      "the field AFTER the refusal holds its value too, in its own frame",
      keptSame.includes("kept-same"),
      keptSame,
    );
    assert("and the refused field was left exactly as it was", refused.includes('""'), refused);

    // The page's own tally. One field of THIS document was filled, so this
    // document saw one `input` and one `change`, both on that field — the
    // same-origin frame's field fires in the frame's document, not in this one.
    const seen = await evalIn(A, "JSON.stringify(window.__stage10Events)");
    let tally = {};
    try {
      tally = JSON.parse(seen.slice(seen.indexOf("{"), seen.lastIndexOf("}") + 1));
    } catch {
      /* the assertion below reports it */
    }
    assert(
      "the page counted exactly one field of its own being filled",
      tally.input === 1 && tally.change === 1 && tally.byField?.["parent-field"] === 2,
      seen,
    );
    assert(
      "and the refused field received no event at all",
      !tally.byField?.["parent-choice"],
      seen,
    );

    // Nothing landed at all: that IS a failed call, and it has to say so.
    const noneAtAll = await A.call("browser_fill_form", {
      fields: [
        { ref: topChoice, value: "gamma" },
        { ref: "e0000", value: "nowhere" },
      ],
    });
    assert(
      "a fill where NOTHING landed is reported as an error",
      isErr(noneAtAll),
      text(noneAtAll),
    );
    assert(
      "and its count says zero, not silence",
      /0\s*\/\s*2/.test(text(noneAtAll)),
      text(noneAtAll),
    );
    assert(
      "and it is labelled failed, not partial",
      noneAtAll?.result?.outcome === "failed",
      JSON.stringify(noneAtAll?.result?.outcome),
    );

    // The other end of the same contract: a fill where everything lands must
    // NOT be labelled partial, or the label means nothing.
    const wholly = await A.call("browser_fill_form", {
      fields: [{ ref: topField, value: "all-of-it" }],
    });
    assert(
      "a fill where every field lands is a plain success",
      !isErr(wholly) && wholly?.result?.outcome === "success",
      text(wholly) + " " + JSON.stringify(wholly?.result?.outcome),
    );
  }

  // ── two independent browser profiles (I03) ───────────────────────────────
  // Two browsers on one relay is the shape this project is FOR, and every
  // targeting bug in it looks identical from the browser you are driving: the
  // call worked. It has to be read from the OTHER one — the tab that must not
  // have moved, the storage that must not be shared, the claim that must not
  // have spread.
  scene("two independent browser profiles");
  const second = await launchOwnBrowser(A, { headed: HEADED });
  env.clients.second = second.clientId;
  assert(
    "a second disposable profile connects as a client of its own",
    !!second.clientId && second.clientId !== ours,
    "first=" + ours + " second=" + second.clientId,
  );
  if (second.clientId) {
    D = makeController({ AUTOMATE_BROWSER_CLIENT_NAME: "IntegrationD" });
    await init(D);
    // A fresh controller's roster arrives on a push frame just after it connects,
    // and a select against an empty roster fails as "no connection to browser
    // extension" — the one error message that means something else entirely. Wait
    // for the roster to settle, exactly as the launch path does.
    const seenByD = await settledRoster(D);
    assert(
      "the second controller sees both browsers before it chooses one",
      seenByD.has(second.clientId) && seenByD.has(ours),
      [...seenByD].join(", "),
    );
    const pinD = await D.call("browser_select_client", { id: second.clientId });
    assert("a second controller pins itself to the second profile", !isErr(pinD), text(pinD));

    // Park profile one somewhere known, and leave a mark in its storage.
    env.page = base + "/index.html";
    await A.call("browser_navigate", { url: env.page, includeSnapshot: false });
    await A.call("browser_eval", {
      expression: "localStorage.setItem('ab-profile', 'one'), 'marked'",
    });

    const openedTwo = await D.call("browser_new_tab", { url: base + "/login.html" });
    assert("the second profile opens a tab of its own", !isErr(openedTwo), text(openedTwo));
    await sleep(900);

    const whereOne = await evalIn(A, "location.pathname");
    const whereTwo = text(await D.call("browser_eval", { expression: "location.pathname" }));
    assert(
      "driving the second profile leaves the first exactly where it was",
      whereOne.includes("/index.html"),
      whereOne,
    );
    assert("and the second profile is on its own page", whereTwo.includes("/login.html"), whereTwo);

    // Same origin, same relay, different profile. If storage were shared, these
    // would be two windows of one browser and "two profiles" would be a story.
    const leaked = text(
      await D.call("browser_eval", { expression: "String(localStorage.getItem('ab-profile'))" }),
    );
    assert("the two profiles share no storage on the same origin", leaked.includes("null"), leaked);

    // The roster is the targeting surface: two ids, each driven by its own agent.
    const bothR = await A.call("browser_list_clients", {});
    const list = bothR?.result?.structuredContent?.clients ?? [];
    assert(
      "both browsers are listed as two distinct clients",
      list.some((c) => c.id === ours) && list.some((c) => c.id === second.clientId),
      text(bothR),
    );
    const driverOf = (id) =>
      (list.find((c) => c.id === id)?.claims ?? []).map((cl) => cl.controllerName).join(",");
    assert(
      "each browser is claimed by the agent driving it, and not by the other",
      driverOf(ours).includes("IntegrationA") &&
        !driverOf(ours).includes("IntegrationD") &&
        driverOf(second.clientId).includes("IntegrationD"),
      "first driven by [" + driverOf(ours) + "] second by [" + driverOf(second.clientId) + "]",
    );

    // And a claim on one browser is not a claim on the relay.
    env.page = base + "/gate.html";
    const stillOne = await A.call("browser_navigate", { url: env.page, includeSnapshot: false });
    assert(
      "the first profile is still drivable while another agent drives the second",
      !isErr(stillOne),
      text(stillOne),
    );
    const afterOne = await evalIn(A, "location.pathname");
    assert(
      "and that action landed on the first profile",
      afterOne.includes("/gate.html"),
      afterOne,
    );
  }
}

async function teardown() {
  // Every browser this run launched, even one a scenario never got to name — a
  // failure halfway through the second profile used to leave a Chrome and a temp
  // directory behind, because only the variable the suite had assigned was ever
  // closed.
  await disposeOwnBrowsers();
  A?.kill();
  B?.kill();
  C?.kill();
  D?.kill();
  try {
    server?.close();
  } catch {}
}

main()
  .catch((e) => {
    console.error("HARNESS_ERROR", e);
    // Filed under the scenario it died in, with the stack as its detail — an
    // abort is the one "failure" with no assertion behind it, so without this it
    // is the only line in the report that cannot say where it happened.
    checks.push({
      name: "harness ran to completion",
      ok: false,
      scenario,
      detail: String(e?.stack ?? e),
      page: env.page,
    });
  })
  .finally(async () => {
    await teardown();
    const failed = checks.filter((c) => !c.ok);
    const NL = String.fromCharCode(10);
    console.log(NL + (checks.length - failed.length) + "/" + checks.length + " checks passed");
    if (failed.length) {
      // A bare FAIL line is a fact with no address. This is the address: which
      // scenario, which page, which browser, and the command that shows it
      // happening — the things the next person types anyway, gathered once.
      console.log(NL + "--- what failed, and where ---");
      for (const c of failed) {
        console.log("  [" + c.scenario + "] " + c.name);
        if (c.page) console.log("      page:   " + c.page);
        if (c.detail) {
          console.log(
            "      detail: " +
              String(c.detail)
                .split(NL)
                .join(NL + "              "),
          );
        }
      }
      console.log(
        NL +
          "  browser:  " +
          env.browser +
          NL +
          "  headless: " +
          env.headless +
          NL +
          "  fixtures: " +
          env.fixtures +
          NL +
          "  clients:  " +
          JSON.stringify(env.clients),
      );
      console.log(
        NL +
          "  watch it happen:   npm run test:integration -- --headed" +
          NL +
          "  the other browser: AUTOMATE_BROWSER_TEST_BROWSER=<path to msedge.exe> npm run test:integration",
      );
      if (A) console.log(NL + "--- controller A stderr ---" + NL + A.getStderr().trim());
    }
    process.exit(failed.length ? 1 : 0);
  });
