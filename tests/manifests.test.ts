/**
 * The distribution manifests must all pin package.json's version (D12).
 *
 * `npm run verify:release` asserts the same thing, but it runs `npm pack` and
 * fetches a remote schema — a minute, and a network. This file is the same
 * assertion in milliseconds, so a doctored version fails while you are still
 * editing rather than at publish time.
 *
 * The second block is the part that matters: it proves the check can FAIL. A
 * green gate that cannot go red is not a gate.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { VERSIONED_MANIFESTS, checkManifestVersions } from "../scripts/lib/manifest-versions.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("distribution manifests", () => {
  it("every manifest pins the version package.json declares", () => {
    const { expected, results } = checkManifestVersions(root);
    const problems = results.filter((r) => r.problem).map((r) => r.problem);
    assert.deepEqual(problems, [], `expected every manifest at ${expected}`);
  });

  it("checks every manifest, and each has something to check", () => {
    const { results } = checkManifestVersions(root);
    assert.equal(results.length, VERSIONED_MANIFESTS.length);
    for (const r of results) assert.notEqual(r.checked, "", `${r.file} checked nothing`);
  });

  it("fails when one manifest's version is doctored", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ab-manifests-"));
    try {
      cpSync(join(root, "package.json"), join(sandbox, "package.json"));
      for (const file of VERSIONED_MANIFESTS) {
        mkdirSync(dirname(join(sandbox, file)), { recursive: true });
        cpSync(join(root, file), join(sandbox, file));
      }

      const victim = "gemini-extension.json";
      const doctored = JSON.parse(readFileSync(join(sandbox, victim), "utf8"));
      doctored.version = "9.9.9";
      writeFileSync(join(sandbox, victim), JSON.stringify(doctored, null, 2));

      const problems = checkManifestVersions(sandbox)
        .results.filter((r) => r.problem)
        .map((r) => r.problem);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /gemini-extension\.json.*9\.9\.9/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("fails when a pinned npx spec drifts from the version field", () => {
    // The failure a `version` check alone would miss: the manifest SAYS 0.2.0
    // and installs something else.
    const sandbox = mkdtempSync(join(tmpdir(), "ab-manifests-"));
    try {
      cpSync(join(root, "package.json"), join(sandbox, "package.json"));
      for (const file of VERSIONED_MANIFESTS) {
        mkdirSync(dirname(join(sandbox, file)), { recursive: true });
        cpSync(join(root, file), join(sandbox, file));
      }

      const victim = "mcp.json";
      const raw = readFileSync(join(sandbox, victim), "utf8");
      writeFileSync(
        join(sandbox, victim),
        raw.replace(/@automatebrowser\/mcp@[\d.]+/, "@automatebrowser/mcp@0.1.0"),
      );

      const problems = checkManifestVersions(sandbox)
        .results.filter((r) => r.problem)
        .map((r) => r.problem);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /mcp\.json.*0\.1\.0/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
