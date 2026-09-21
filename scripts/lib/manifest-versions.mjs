/**
 * One version number, five files that repeat it (plan 09, D12).
 *
 * Every distribution manifest restates `package.json`'s version — some as a
 * `version` field, some inside an `npx --package @automatebrowser/mcp@X` argument
 * that a store will run verbatim on a stranger's machine. Nothing about a stale
 * one is visible: the JSON stays valid, the build stays green, and the listing
 * quietly installs a version that may not exist.
 *
 * Shared by `scripts/verify-release.mjs` (the release gate) and
 * `tests/manifests.test.ts` (the same assertions, in seconds).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Files that restate the version. `.claude-plugin/marketplace.json` is absent on
 * purpose — it carries the tool COUNT, not a version, and `docs:generate` owns
 * that. A file listed here must carry something checkable or it fails below.
 */
export const VERSIONED_MANIFESTS = [
  "server.json",
  "gemini-extension.json",
  "plugin.json",
  "mcp.json",
  ".claude-plugin/plugin.json",
];

/** Matches the pinned npm spec wherever it appears — args arrays included. */
const PINNED_SPEC = /@automatebrowser\/mcp@(\d[^"\s]*)/g;

/**
 * @param {string} root Repository root.
 * @returns {{expected: string, results: {file: string, problem: string|null, checked: string}[]}}
 */
export function checkManifestVersions(root) {
  const expected = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

  const results = VERSIONED_MANIFESTS.map((file) => {
    let raw;
    try {
      raw = readFileSync(join(root, file), "utf8");
    } catch {
      return { file, checked: "", problem: `${file}: missing — a listing points at it` };
    }

    let declared;
    try {
      declared = JSON.parse(raw).version;
    } catch (err) {
      return { file, checked: "", problem: `${file}: not valid JSON — ${err.message}` };
    }

    const pinned = [...raw.matchAll(PINNED_SPEC)].map((m) => m[1]);
    const claims = [
      ...(declared === undefined ? [] : [["version", declared]]),
      ...pinned.map((v) => ["@automatebrowser/mcp@", v]),
    ];

    if (claims.length === 0) {
      return {
        file,
        checked: "",
        problem: `${file}: no version to check — was the field renamed, or does it belong in this list?`,
      };
    }

    const wrong = claims.filter(([, v]) => v !== expected);
    if (wrong.length > 0) {
      return {
        file,
        checked: "",
        problem:
          `${file}: ${wrong.map(([k, v]) => `${k}${k.endsWith("@") ? "" : " is "}${v}`).join(", ")}` +
          ` — package.json says ${expected}`,
      };
    }

    return { file, checked: `${claims.length} version claim(s)`, problem: null };
  });

  return { expected, results };
}
