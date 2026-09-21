/**
 * The private-browsing check — the half of stage 9 D5 that `npm run test:integration`
 * cannot reach, run on demand instead of handed to a person.
 *
 * `browser_new_tab { incognito: true }` only works if a HUMAN has ticked a setting
 * on the extension's details page ("Allow in Incognito" in Chrome, "Allow in
 * InPrivate" in Edge). The integration suite launches a throwaway browser where
 * that setting is off, so it can only prove the REFUSAL. This script proves the
 * other half: it flips the setting the way a person would — by clicking it on the
 * settings page — restarts the browser, and measures what actually changes.
 *
 * It is deliberately NOT in `npm run check`. It drives two browsers' internal
 * settings pages, whose markup belongs to Chrome and Edge and will move without
 * warning. When it breaks, that is news about the browser, not a failing build.
 *
 *   node scripts/incognito-check.mjs            # Chrome
 *   node scripts/incognito-check.mjs --edge     # Edge
 *
 * SAFETY: launches its own browser on a throwaway profile, like every other
 * harness here. It never touches a browser you were already running.
 *
 * Last run 2026-09-05: identical in both browsers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EXT_DIR, requireFreshBuilds, startFixtureServer } from "./lib/browser-harness.mjs";

const EDGE = process.argv.includes("--edge");
const EDGE_PATHS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const checks = [];
const assert = (name, cond, detail) => {
  checks.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : "\n      " + detail}`);
};

requireFreshBuilds();

const edgePath = EDGE_PATHS.find((p) => fs.existsSync(p));
if (EDGE && !edgePath) {
  console.error("Edge not found at either standard location; skipping.");
  process.exit(1);
}

const { default: puppeteer } = await import("puppeteer");
const server = await startFixtureServer();
const base = "http://127.0.0.1:" + server.address().port;
// One profile directory, reused across the restart — that is what makes the
// setting stick, exactly as it does for a real person.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ab-incognito-"));

const launch = () =>
  puppeteer.launch({
    // A private window IS a window. Headless has no business pretending here.
    headless: false,
    userDataDir: profile,
    ...(EDGE ? { executablePath: edgePath } : {}),
    args: [
      "--disable-extensions-except=" + EXT_DIR,
      "--load-extension=" + EXT_DIR,
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

/** The extension's service worker, waited for and confirmed alive. */
async function worker(browser) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const target = browser.targets().find((t) => t.type() === "service_worker");
    if (target) {
      try {
        const w = await target.worker();
        await w.evaluate(() => chrome.runtime.id);
        return w;
      } catch {
        /* the worker died under us — look again */
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("the extension's service worker never came up");
}

/** Ask the extension what it can do, and try the thing under test. */
function measure(sw, url) {
  return sw.evaluate(async (target) => {
    const r = { allowed: await chrome.extension.isAllowedIncognitoAccess() };
    try {
      const win = await chrome.windows.create({ url: target, incognito: true, focused: false });
      // The finding this whole script exists for: with the setting off this
      // RESOLVES NULL. It does not reject.
      r.window = win == null ? null : { id: win.id, incognito: win.incognito };
      r.tabId = win?.tabs?.[0]?.id ?? null;
    } catch (e) {
      r.createError = String(e?.message || e);
    }
    r.tabs = (await chrome.tabs.query({ windowType: "normal" })).map((t) => ({
      id: t.id,
      incognito: !!t.incognito,
    }));
    return r;
  }, url);
}

const label = EDGE ? "Edge" : "Chrome";
console.log(`${label}  fixtures: ${base}  profile: ${profile}\n`);

// ── 1. the setting OFF, which is every fresh install ───────────────────────
let browser = await launch();
let sw = await worker(browser);
const id = await sw.evaluate(() => chrome.runtime.id);
const off = await measure(sw, base + "/login.html");
assert(
  `${label}: a fresh profile does NOT allow the extension in private browsing`,
  off.allowed === false,
);
assert(
  `${label}: creating a private window without permission RESOLVES NULL rather than failing`,
  off.window === null && !off.createError,
  JSON.stringify(off),
);

// ── 2. flip it the way a person does ───────────────────────────────────────
const page = await browser.newPage();
await page.goto((EDGE ? "edge" : "chrome") + "://extensions/?id=" + id, {
  waitUntil: "domcontentloaded",
});
await new Promise((r) => setTimeout(r, 1500));
const clicked = await page.evaluate(() => {
  // Chrome's settings page: one Polymer element tree.
  const view = document
    .querySelector("extensions-manager")
    ?.shadowRoot?.querySelector("extensions-detail-view");
  const chromeToggle = view?.shadowRoot?.querySelector("#allow-incognito");
  if (chromeToggle) {
    (chromeToggle.shadowRoot?.querySelector("cr-toggle") ?? chromeToggle).click();
    return "chrome";
  }
  // Edge's is a different application entirely — find the row by its LABEL,
  // which is the only part likely to outlive a redesign.
  const seen = new Set();
  const findRow = (root, depth) => {
    if (depth > 12 || !root || seen.has(root)) return null;
    seen.add(root);
    for (const el of root.querySelectorAll("*")) {
      if (
        el.tagName.toLowerCase() === "standard-row" &&
        /Allow in InPrivate/i.test(el.textContent || "")
      ) {
        return el;
      }
      if (el.shadowRoot) {
        const found = findRow(el.shadowRoot, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  const row = findRow(document, 0);
  const toggle =
    row?.querySelector("fluent-switch") ?? row?.shadowRoot?.querySelector("fluent-switch");
  if (!toggle) return null;
  toggle.click();
  return "edge";
});
assert(`${label}: the setting can be found and clicked on the extension's own page`, !!clicked);
// Clicking it RELOADS the extension, so the service worker under us dies.
// Restarting the browser is both simpler than chasing it and closer to reality.
await new Promise((r) => setTimeout(r, 2000));
await browser.close();

// ── 3. the setting ON ──────────────────────────────────────────────────────
browser = await launch();
sw = await worker(browser);
const on = await measure(sw, base + "/login.html");
assert(`${label}: the extension is now allowed in private browsing`, on.allowed === true);
assert(
  `${label}: a private window is created, and reports itself as private`,
  on.window?.incognito === true,
  JSON.stringify(on),
);
assert(
  `${label}: the private tab appears in the tab list, flagged`,
  on.tabs.some((t) => t.id === on.tabId && t.incognito),
  JSON.stringify(on.tabs),
);

// ── 4. the trap: which cookie jar does a private tab read? ─────────────────
if (on.tabId) {
  const state = await sw.evaluate(
    async (tabId, origin) => {
      const stores = await chrome.cookies.getAllCookieStores();
      const own = stores.find((s) => s.tabIds?.includes(tabId))?.id ?? null;
      // Seed one in the NORMAL jar, the way an ordinary page would.
      await chrome.cookies.set({ url: origin, name: "ab_probe", value: "1" });
      return {
        storeCount: stores.length,
        ownStore: own,
        // What the extension reads with no store named — the old behaviour.
        unscoped: (await chrome.cookies.getAll({ url: origin })).map((c) => c.name),
        // What it reads when it names the private tab's own jar — the fix.
        scoped: own
          ? (await chrome.cookies.getAll({ url: origin, storeId: own })).map((c) => c.name)
          : null,
      };
    },
    on.tabId,
    base + "/",
  );
  assert(
    `${label}: a private window has its OWN cookie jar, separate from the normal one`,
    state.storeCount >= 2 && state.ownStore && state.ownStore !== "0",
    JSON.stringify(state),
  );
  assert(
    `${label}: asking for cookies WITHOUT naming the jar reads the user's real one`,
    state.unscoped.includes("ab_probe"),
    JSON.stringify(state),
  );
  assert(
    `${label}: naming the private tab's own jar reads the private one, which is empty`,
    Array.isArray(state.scoped) && !state.scoped.includes("ab_probe"),
    JSON.stringify(state),
  );
}

await browser.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
