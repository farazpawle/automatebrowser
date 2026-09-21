/**
 * A quiet "you are running an old copy" notice (plan 09, D3).
 *
 * Why this exists at all in a product whose pitch is that nothing leaves your
 * machine: the multi-IDE relay partition that started this roadmap was CAUSED by
 * a stale install, and nothing in the product told anyone they were behind. The
 * pre-existing C25b warning compares two LOCAL processes to each other; it can
 * never notice that both are old.
 *
 * The honesty is in saying so, not in withholding the feature. What is sent is a
 * bare GET to the public npm registry for this package's published version — no
 * identifier, no telemetry, no body. What is learned by the other end is that
 * some machine runs this package. `AUTOMATE_BROWSER_NO_UPDATE_CHECK=1` stops it,
 * and README says all of that by name and URL.
 *
 * Three properties are load-bearing and every one of them is a rule, not taste:
 *   - **stderr only.** stdout is the stdio MCP transport; one stray byte there
 *     corrupts the session. Everything here goes through `log`, which is stderr.
 *   - **never blocks.** Startup does not await this. A registry that hangs must
 *     cost the user nothing, so the notice for a slow first run simply arrives on
 *     the NEXT run, off the cache.
 *   - **never throws.** Offline, DNS-poisoned, 403, garbage JSON, unwritable home
 *     directory — every one of them is a silent no-op. An update nag that breaks
 *     a session is worse than no update nag.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { log } from "./log";
import { logPath } from "./log-dir";

const PACKAGE = "@automatebrowser/mcp";
const REGISTRY = `https://registry.npmjs.org/${PACKAGE}/latest`;
const CACHE_FILE = "update-check.json";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The request is a courtesy, not a feature; it never gets to be slow. */
const TIMEOUT_MS = 3_000;

interface Cache {
  /** Epoch ms of the last COMPLETED request, successful or not. */
  checkedAt: number;
  /** Last version the registry reported. Absent until one request succeeds. */
  latest?: string;
}

/**
 * `-1 | 0 | 1`, semver-ish, enough to answer "is b newer than a".
 *
 * Deliberately hand-rolled: a dependency for this would be a dependency in the
 * shipped runtime, and the whole comparison is fifteen lines. Build metadata is
 * ignored (semver says it is not part of precedence) and a prerelease sorts
 * below its own release, so `0.3.0-beta.1` never nags someone on `0.3.0`.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const s = String(v ?? "")
      .trim()
      .replace(/^v/, "");
    const plus = s.indexOf("+");
    const core = plus === -1 ? s : s.slice(0, plus);
    const dash = core.indexOf("-");
    return {
      nums: (dash === -1 ? core : core.slice(0, dash))
        .split(".")
        .map((n) => Number.parseInt(n, 10) || 0),
      pre: dash === -1 ? "" : core.slice(dash + 1),
    };
  };

  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // 1.0.0 outranks 1.0.0-beta
  if (!y.pre) return -1;
  // ponytail: lexical, so `beta.10` sorts below `beta.9`. We publish no
  // prereleases; make this per-identifier numeric the day we do.
  return x.pre < y.pre ? -1 : 1;
}

function readCache(file: string): Cache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Cache;
    return typeof parsed?.checkedAt === "number" ? parsed : undefined;
  } catch {
    return undefined; // absent, unreadable or corrupt — all mean "never checked"
  }
}

function writeCache(file: string, cache: Cache): void {
  try {
    writeFileSync(file, JSON.stringify(cache), "utf8");
  } catch {
    // A cache we cannot persist just means we ask again next start.
  }
}

/** The one line the user sees, on stderr, at most once per process. */
function notify(current: string, latest: string): void {
  log.warn(
    `A newer ${PACKAGE} is available: ${current} → ${latest}. ` +
      `Update with \`npm i -g ${PACKAGE}\`. ` +
      `Set AUTOMATE_BROWSER_NO_UPDATE_CHECK=1 to silence this.`,
  );
}

export interface UpdateCheckOptions {
  /** Overridden by the tests so no temp home directory is needed. */
  cacheFile?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  /** Overridden by the tests to capture the notice instead of printing it. */
  onNotice?: (current: string, latest: string) => void;
}

/**
 * Report a newer published version on stderr, at most one registry request per
 * 24 hours. Resolves when the work is done; callers do not await it.
 *
 * The cached version is reported BEFORE any request, so the common path prints
 * instantly and the network is only ever touched to refresh a stale cache.
 */
export async function checkForUpdate(
  current: string,
  opts: UpdateCheckOptions = {},
): Promise<void> {
  if (process.env.AUTOMATE_BROWSER_NO_UPDATE_CHECK) return;

  const file = opts.cacheFile ?? logPath(CACHE_FILE);
  const now = opts.now ?? Date.now();
  const announce = opts.onNotice ?? notify;
  const cache = readCache(file);

  if (cache?.latest && compareVersions(current, cache.latest) < 0) {
    announce(current, cache.latest);
  }

  if (cache && now - cache.checkedAt < DAY_MS) return;

  let latest: string | undefined;
  try {
    const res = await (opts.fetchImpl ?? fetch)(REGISTRY, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const body = (await res.json()) as { version?: unknown };
      if (typeof body?.version === "string") latest = body.version;
    }
  } catch {
    // Offline, blocked, slow, or serving nonsense. Silence is the whole contract.
  }

  // Stamp the attempt either way, so an offline machine retries daily, not hourly.
  writeCache(file, { checkedAt: now, ...(latest ? { latest } : {}) });

  // Only speak if the refresh taught us something the cached line did not say.
  if (latest && latest !== cache?.latest && compareVersions(current, latest) < 0) {
    announce(current, latest);
  }
}
