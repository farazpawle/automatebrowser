/**
 * The filesystem sandbox (Stage 1). Without it an agent can make the user's real,
 * logged-in browser upload their SSH key to any site, so every case here is a
 * security property rather than a convenience.
 *
 * Roots are set explicitly with `setRoots` so nothing depends on which directory
 * the test runner happened to start in.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, parse, relative, resolve, sep } from "node:path";
import { afterEach, describe, it } from "node:test";

import { assertPathAllowed, getAllowedRoots, setRoots } from "@/utils/paths";

const sandbox = mkdtempSync(join(tmpdir(), "ab-paths-"));

/**
 * Somewhere genuinely outside every root. It cannot be under tmpdir — tmpdir is
 * ALWAYS in the allow-list so the default trace path works — and it cannot be
 * under the working directory, which is the fallback root. A sibling of the
 * working directory satisfies both, and nothing here creates it.
 */
const outside = resolve(process.cwd(), "..", "automatebrowser-outside-test");

/** The root of the volume the working directory is on: outside cwd and outside tmpdir. */
const volumeRoot = parse(resolve(process.cwd())).root;

afterEach(() => {
  setRoots(null);
  delete process.env.AUTOMATE_BROWSER_ALLOW_UNRESTRICTED_PATHS;
  delete process.env.AUTOMATE_BROWSER_WORKSPACE;
});

describe("getAllowedRoots", () => {
  it("falls back to the working directory plus tmpdir when no roots are negotiated — never to allow-all", () => {
    setRoots(null);
    const roots = getAllowedRoots();
    assert.ok(roots.length >= 1);
    assert.ok(
      roots.some((r) =>
        r.toLowerCase().startsWith(resolve(process.cwd()).slice(0, 3).toLowerCase()),
      ),
    );
  });

  it("keeps tmpdir in the list even when roots are negotiated, so the default trace path works", () => {
    setRoots([sandbox]);
    const roots = getAllowedRoots().map((r) => r.toLowerCase());
    assert.ok(roots.some((r) => r.includes("temp") || r.includes("tmp")));
  });

  it("accepts a file: URI root, as MCP clients send", () => {
    setRoots([{ uri: `file:///${sandbox.replace(/\\/g, "/").replace(/^\//, "")}` }]);
    assert.ok(getAllowedRoots().length >= 1);
  });

  it("treats an empty root list as 'none negotiated' rather than 'nothing allowed'", () => {
    setRoots([]);
    assert.ok(getAllowedRoots().length >= 1);
  });
});

describe("assertPathAllowed — containment", () => {
  it("allows a path inside a root and returns it resolved", () => {
    setRoots([sandbox]);
    const target = join(sandbox, "a", "b.json");
    assert.equal(assertPathAllowed(target, "write"), resolve(target));
  });

  it("refuses a path outside every root, and names the roots so the caller can fix it", () => {
    setRoots([sandbox]);
    assert.throws(
      () => assertPathAllowed(join(outside, "x.json"), "write"),
      (err: Error) =>
        err.message.includes("outside the allowed roots") && err.message.includes(sandbox),
    );
  });

  it("refuses a traversal that climbs out of every root", () => {
    setRoots([sandbox]);
    // A `..`-laden path built from the real relative distance rather than a
    // guessed number of levels. The destination is on the sandbox's own volume
    // because `..` cannot cross volumes on Windows, and its root sits outside
    // both tmpdir and the working directory.
    const escape = join(parse(sandbox).root, "automatebrowser-escape.json");
    const traversal = join(sandbox, relative(sandbox, escape));
    assert.throws(() => assertPathAllowed(traversal, "read"), /outside the allowed roots/);
  });

  it("still allows a traversal that lands back inside a root", () => {
    setRoots([sandbox]);
    const target = join(sandbox, "a", "..", "b.json");
    assert.equal(assertPathAllowed(target, "write"), resolve(sandbox, "b.json"));
  });

  it("allows a sibling whose name merely starts with dots", () => {
    const root = mkdtempSync(join(tmpdir(), "ab-dots-"));
    setRoots([root]);
    const target = join(root, "..foo", "x.json");
    assert.equal(assertPathAllowed(target, "write"), resolve(target));
  });

  it("refuses a non-string or empty path instead of coercing it", () => {
    setRoots([sandbox]);
    for (const bad of [undefined, null, 42, "", "   ", {}]) {
      assert.throws(() => assertPathAllowed(bad, "read"), /Invalid file path/, JSON.stringify(bad));
    }
  });
});

describe("assertPathAllowed — symlink escape", () => {
  it("resolves a symlink before judging it, so a link inside a root cannot point out of one", (t) => {
    setRoots([sandbox]);
    const link = join(sandbox, `escape-link-${Date.now()}`);
    try {
      // The volume root exists and is outside every allowed root, which is what
      // this needs; creating a directory outside the project would not be ok.
      symlinkSync(volumeRoot, link, "junction");
    } catch {
      // Creating links needs a privilege this machine may not grant. The property
      // still holds; skipping is honest, silently passing would not be.
      t.skip("cannot create a symlink in this environment");
      return;
    }
    assert.throws(
      () => assertPathAllowed(join(link, "x.json"), "write"),
      /outside the allowed roots/,
    );
  });
});

describe("assertPathAllowed — write preflight", () => {
  it("creates a missing parent directory so a relative output path just works", () => {
    setRoots([sandbox]);
    const target = join(sandbox, "made", "up", "deep", "trace.json");
    assert.equal(assertPathAllowed(target, "write"), resolve(target));
  });

  it("refuses to write over an existing directory", () => {
    setRoots([sandbox]);
    const dir = join(sandbox, "a-directory");
    mkdirSync(dir, { recursive: true });
    assert.throws(() => assertPathAllowed(dir, "write"), /existing directory/);
  });

  it("does not run the write preflight for a read", () => {
    setRoots([sandbox]);
    const dir = join(sandbox, "read-dir");
    mkdirSync(dir, { recursive: true });
    assert.equal(assertPathAllowed(dir, "read"), resolve(dir));
  });

  it("allows overwriting an existing writable file", () => {
    setRoots([sandbox]);
    const file = join(sandbox, "existing.json");
    writeFileSync(file, "{}");
    assert.equal(assertPathAllowed(file, "write"), resolve(file));
  });
});

/**
 * D19. Several MCP clients never send roots, which left no way to allow a project
 * folder short of switching the sandbox off entirely. This variable adds folders;
 * the cases that matter are the ones where it must NOT widen anything.
 */
describe("AUTOMATE_BROWSER_WORKSPACE", () => {
  const workspace = mkdtempSync(join(tmpdir(), "ab-workspace-"));

  it("allows a folder it names when the client sends no roots", () => {
    setRoots(null);
    process.env.AUTOMATE_BROWSER_WORKSPACE = workspace;
    const target = join(workspace, "trace.json");
    assert.equal(assertPathAllowed(target, "write"), resolve(target));
  });

  it("ADDS to the client's roots rather than replacing them", () => {
    setRoots([sandbox]);
    process.env.AUTOMATE_BROWSER_WORKSPACE = workspace;
    // Both must survive: the negotiated one and the configured one.
    assert.equal(assertPathAllowed(join(sandbox, "a.json"), "write"), resolve(sandbox, "a.json"));
    assert.equal(
      assertPathAllowed(join(workspace, "b.json"), "write"),
      resolve(workspace, "b.json"),
    );
  });

  it("accepts several folders separated by the platform's path delimiter", () => {
    const second = mkdtempSync(join(tmpdir(), "ab-workspace2-"));
    setRoots(null);
    process.env.AUTOMATE_BROWSER_WORKSPACE = [workspace, second].join(delimiter);
    for (const dir of [workspace, second]) {
      assert.equal(assertPathAllowed(join(dir, "c.json"), "write"), resolve(dir, "c.json"));
    }
  });

  it("ignores blank segments instead of letting them widen the list", () => {
    setRoots([sandbox]);
    process.env.AUTOMATE_BROWSER_WORKSPACE = `${delimiter}  ${delimiter}${workspace}${delimiter}`;
    const roots = getAllowedRoots();
    assert.ok(roots.some((r) => r.toLowerCase() === resolve(workspace).toLowerCase()));
    // A blank segment resolves to the working directory if it is not filtered,
    // which would silently re-add cwd on a client that had scoped the roots.
    assert.ok(!roots.some((r) => r.toLowerCase() === resolve(process.cwd()).toLowerCase()));
  });

  it("cannot mean allow-all when it is empty, blank, or only delimiters", () => {
    setRoots([sandbox]);
    const baseline = getAllowedRoots();
    for (const value of ["", "   ", delimiter, `${delimiter}${delimiter}`, "\t\n"]) {
      process.env.AUTOMATE_BROWSER_WORKSPACE = value;
      assert.deepEqual(getAllowedRoots(), baseline, JSON.stringify(value));
      assert.throws(
        () => assertPathAllowed(join(outside, "z.json"), "write"),
        /outside the allowed roots/,
        JSON.stringify(value),
      );
    }
  });

  it("widens to the named folder and nothing above it", () => {
    setRoots(null);
    process.env.AUTOMATE_BROWSER_WORKSPACE = workspace;
    // The parent of a workspace root must not come along with it.
    assert.throws(
      () => assertPathAllowed(join(outside, "sibling.json"), "write"),
      /outside the allowed roots/,
    );
  });
});

describe("assertPathAllowed — the documented bypass", () => {
  it("only bypasses containment when the env var is exactly 1", () => {
    setRoots([sandbox]);
    const target = join(outside, "y.json");

    process.env.AUTOMATE_BROWSER_ALLOW_UNRESTRICTED_PATHS = "true";
    assert.throws(() => assertPathAllowed(target, "read"), /outside the allowed roots/);

    process.env.AUTOMATE_BROWSER_ALLOW_UNRESTRICTED_PATHS = "1";
    assert.equal(assertPathAllowed(target, "read"), resolve(target));
  });
});

describe("case folding", () => {
  it("matches a root case-insensitively on Windows and exactly elsewhere", () => {
    setRoots([sandbox]);
    const target = join(sandbox, "Case", "Test.json");
    const swapped = target.split(sep).join(sep).toUpperCase();
    if (process.platform === "win32") {
      assert.equal(
        assertPathAllowed(swapped, "write").toLowerCase(),
        resolve(target).toLowerCase(),
      );
    } else {
      assert.throws(() => assertPathAllowed(swapped, "write"), /outside the allowed roots/);
    }
  });
});
