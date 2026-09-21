/**
 * The update notice (D3). Everything here runs against a stubbed fetch and a
 * temp cache file — a test that reached the real npm registry would be slow,
 * flaky offline, and would itself violate the promise this feature is careful
 * about.
 *
 * Five properties are load-bearing:
 *
 *  - **The opt-out really opts out.** `AUTOMATE_BROWSER_NO_UPDATE_CHECK` must
 *    prevent the REQUEST, not merely the printed line. A "silenced" check that
 *    still phones home is the version of this feature nobody agreed to.
 *  - **At most one request per 24 hours**, and a fresh cache means none at all.
 *  - **Failure is silent.** A throwing fetch, a non-ok response, or a body with
 *    no version must neither throw nor print — and must still stamp the cache,
 *    so an offline machine retries tomorrow rather than on every single start.
 *  - **It only speaks when behind**, and only once per process for a version.
 *  - **An unwritable cache is survivable**, because `~` is not always writable.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { checkForUpdate, compareVersions } from "@/utils/update-check";

const DAY = 24 * 60 * 60 * 1000;
/** A fixed clock, so "25 hours ago" means the same thing on every machine. */
const NOW = 1_800_000_000_000;

const dir = mkdtempSync(join(tmpdir(), "ab-update-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
/** A fresh cache path per test, so no test can observe another's file. */
const freshFile = () => join(dir, `cache-${n++}.json`);

/** A fetch stub that records its calls and answers with `version`. */
function stubFetch(version: string | undefined, ok = true) {
  const calls: string[] = [];
  const impl = (async (url: unknown) => {
    calls.push(String(url));
    return {
      ok,
      json: async () => (version === undefined ? {} : { version }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Collects notices instead of writing them to stderr. */
function collector() {
  const seen: Array<[string, string]> = [];
  return { seen, onNotice: (c: string, l: string) => void seen.push([c, l]) };
}

beforeEach(() => {
  delete process.env.AUTOMATE_BROWSER_NO_UPDATE_CHECK;
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    assert.equal(compareVersions("1.0.0", "2.0.0"), -1);
    assert.equal(compareVersions("0.2.0", "0.10.0"), -1);
    assert.equal(compareVersions("0.2.9", "0.2.10"), -1);
    assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
    assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
  });

  it("treats a missing part as zero and tolerates a v prefix", () => {
    assert.equal(compareVersions("1", "1.0.0"), 0);
    assert.equal(compareVersions("v1.2.0", "1.2.0"), 0);
  });

  it("sorts a prerelease below its own release", () => {
    assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0", "1.0.0-beta.1"), 1);
    assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
  });

  it("ignores build metadata, which semver excludes from precedence", () => {
    assert.equal(compareVersions("1.0.0+abc", "1.0.0+zzz"), 0);
  });

  // Garbage parses to 0.0.0 with whatever followed the first dash as a
  // prerelease tag, so it always sorts LOW. That is the safe direction: a
  // registry that answers with nonsense can never talk anyone into an upgrade.
  it("never reads garbage as newer", () => {
    assert.equal(compareVersions("", ""), 0);
    assert.equal(compareVersions("0.2.0", "not-a-version"), 1);
    assert.equal(compareVersions("0.2.0", "{}"), 1);
    assert.equal(compareVersions("0.2.0", "latest"), 1);
  });
});

describe("checkForUpdate", () => {
  it("reports a newer published version once", async () => {
    const { impl, calls } = stubFetch("0.3.0");
    const { seen, onNotice } = collector();
    await checkForUpdate("0.2.0", { cacheFile: freshFile(), fetchImpl: impl, onNotice });

    assert.equal(calls.length, 1);
    assert.match(calls[0], /registry\.npmjs\.org/);
    assert.deepEqual(seen, [["0.2.0", "0.3.0"]]);
  });

  it("says nothing when up to date or ahead of the registry", async () => {
    for (const current of ["0.3.0", "0.4.0"]) {
      const { impl } = stubFetch("0.3.0");
      const { seen, onNotice } = collector();
      await checkForUpdate(current, { cacheFile: freshFile(), fetchImpl: impl, onNotice });
      assert.deepEqual(seen, [], `expected silence on ${current}`);
    }
  });

  it("makes no request at all when the opt-out is set", async () => {
    process.env.AUTOMATE_BROWSER_NO_UPDATE_CHECK = "1";
    const { impl, calls } = stubFetch("9.9.9");
    const { seen, onNotice } = collector();
    const file = freshFile();
    await checkForUpdate("0.2.0", { cacheFile: file, fetchImpl: impl, onNotice });

    assert.deepEqual(calls, []);
    assert.deepEqual(seen, []);
    assert.throws(() => readFileSync(file, "utf8"), "must not even write a cache");
  });

  it("skips the request while the cache is under 24 hours old", async () => {
    const file = freshFile();
    writeFileSync(file, JSON.stringify({ checkedAt: NOW - 60_000, latest: "0.3.0" }));

    const { impl, calls } = stubFetch("0.4.0");
    const { seen, onNotice } = collector();
    await checkForUpdate("0.2.0", { cacheFile: file, fetchImpl: impl, now: NOW, onNotice });

    assert.deepEqual(calls, [], "a fresh cache must not touch the network");
    // Still told from the cache, so the notice never waits on a refresh.
    assert.deepEqual(seen, [["0.2.0", "0.3.0"]]);
  });

  it("refreshes once the cache is older than 24 hours", async () => {
    const file = freshFile();
    writeFileSync(file, JSON.stringify({ checkedAt: NOW - 25 * 60 * 60 * 1000 }));

    const { impl, calls } = stubFetch("0.3.0");
    const { seen, onNotice } = collector();
    await checkForUpdate("0.2.0", { cacheFile: file, fetchImpl: impl, now: NOW, onNotice });

    assert.equal(calls.length, 1);
    assert.deepEqual(seen, [["0.2.0", "0.3.0"]]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      checkedAt: NOW,
      latest: "0.3.0",
    });
  });

  it("announces a cached version once, not again after the refresh confirms it", async () => {
    const file = freshFile();
    writeFileSync(file, JSON.stringify({ checkedAt: NOW - DAY, latest: "0.3.0" }));

    const { impl } = stubFetch("0.3.0"); // the registry agrees with the cache
    const { seen, onNotice } = collector();
    await checkForUpdate("0.2.0", { cacheFile: file, fetchImpl: impl, now: NOW, onNotice });

    assert.equal(seen.length, 1, "the same version must not be reported twice");
  });

  it("stays silent and stamps the cache when the request throws", async () => {
    const file = freshFile();
    const impl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    }) as unknown as typeof fetch;
    const { seen, onNotice } = collector();

    await checkForUpdate("0.2.0", { cacheFile: file, fetchImpl: impl, now: NOW, onNotice });

    assert.deepEqual(seen, []);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { checkedAt: NOW });
  });

  it("stays silent on a non-ok response or a body with no version", async () => {
    const cases: Array<[string | undefined, boolean]> = [
      [undefined, true],
      ["0.3.0", false],
    ];
    for (const [version, ok] of cases) {
      const { seen, onNotice } = collector();
      const { impl } = stubFetch(version, ok);
      await checkForUpdate("0.2.0", { cacheFile: freshFile(), fetchImpl: impl, onNotice });
      assert.deepEqual(seen, []);
    }
  });

  it("survives an unwritable cache path without throwing", async () => {
    const parent = freshFile();
    writeFileSync(parent, "{}");
    const { impl } = stubFetch("0.3.0");
    const { seen, onNotice } = collector();
    // The parent of this path is a FILE, so both the read and the write fail.
    await checkForUpdate("0.2.0", {
      cacheFile: join(parent, "nested.json"),
      fetchImpl: impl,
      onNotice,
    });
    assert.deepEqual(seen, [["0.2.0", "0.3.0"]]);
  });
});
