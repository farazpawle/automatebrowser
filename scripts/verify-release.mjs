// Pre-publish gate (roadmap C25a). Catches the two ways a release goes wrong
// here: a version that drifts between the seven places it is written — five
// distribution manifests plus three literals in the vendored config — and a
// tarball that ships without the entry points the `bin` field points at.
//
// Runs no publish and mutates nothing. Safe to run any time.
//
// Usage:  npm run build && npm run verify:release
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import addFormats from "ajv-formats";

import { checkManifestVersions } from "./lib/manifest-versions.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => resolve(root, p);
const readJson = (p) => JSON.parse(readFileSync(rel(p), "utf8"));

/**
 * Files that must survive `npm pack` — every path the `bin` field or a runtime
 * spawn relies on, PLUS the shipped skill.
 *
 * The skill is in this list because it is the product's expertise, and it reaches
 * users only through `package.json`'s `files` array: a typo or a rename would drop
 * it silently with every other gate still green. Nothing else notices a missing
 * Markdown file.
 */
const REQUIRED_FILES = [
  "dist/index.js",
  "dist/relay.js",
  "dist/cli.js",
  "skills/automate-browser/SKILL.md",
  // npm does NOT pack a changelog automatically the way it does README and
  // LICENSE, so it ships only because `files` names it. The whole reason it
  // exists is that someone on an old install cannot see what changed — which is
  // exactly the person who never visits the repository.
  "CHANGELOG.md",
  // The two manifests are what make the skill DISCOVERABLE. Shipping the skill
  // without them is the state this package was in until 2026-09-01: the files
  // were all present and correct, and nothing could install them.
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];

/**
 * Every reference the skill's own section index sends an agent to. A SKILL.md that
 * ships without its references is worse than useless — it confidently points at
 * files that are not there.
 */
const REQUIRED_SKILL_REFERENCES = [
  "capture-and-diagnostics",
  "page-interaction",
  "reading-and-extraction",
  "sessions-and-state",
  "tabs-and-multi-agent",
  "tool-reference",
  "troubleshooting",
].map((n) => `skills/automate-browser/references/${n}.md`);

const failures = [];
const fail = (msg) => failures.push(msg);
const ok = (msg) => console.log(`  ok    ${msg}`);

// ── versions ───────────────────────────────────────────────────────────────
const pkg = readJson("package.json");
const server = readJson("server.json");
const expected = pkg.version;

console.log(`Verifying release ${expected}\n`);

// ── server.json shape ──────────────────────────────────────────────────────
// Validate against the registry's own schema — the URL server.json declares, so
// the check follows the file if it ever moves to a newer schema revision. The
// registry rejects a malformed file at publish time; catching it here is
// cheaper. Draft-07, no external $refs, six `format` keywords.
//
// A network failure downgrades to a warning rather than failing the run: this
// is a supplementary check, and the version assertions below are the real gate.
// Skip deliberately with VERIFY_RELEASE_SKIP_SCHEMA=1 for offline work.
if (process.env.VERIFY_RELEASE_SKIP_SCHEMA === "1") {
  console.log("  skip  server.json schema (VERIFY_RELEASE_SKIP_SCHEMA=1)");
} else if (!server.$schema) {
  fail("server.json: no `$schema` declared — cannot validate its shape");
} else {
  try {
    const res = await fetch(server.$schema);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const schema = await res.json();

    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    if (validate(server)) {
      ok(`server.json validates against ${server.$schema}`);
    } else {
      for (const e of validate.errors ?? []) {
        fail(`server.json${e.instancePath || " (root)"}: ${e.message}`);
      }
    }
  } catch (err) {
    console.warn(
      `  warn  could not validate server.json against its schema: ${err.message ?? String(err)}`,
    );
  }
}

// ── every manifest that restates the version ───────────────────────────────
// server.json, the Gemini CLI extension, the agent-plugins pair and the Claude
// plugin manifest. Shared with tests/manifests.test.ts so the two can never
// disagree about what "version-matched" means.
for (const { file, checked, problem } of checkManifestVersions(root).results) {
  if (problem) fail(problem);
  else ok(`${file} — ${checked} at ${expected}`);
}

// The registry requires the package entry to pin the same version as its parent.
const npmPkg = (server.packages ?? []).find(
  (p) => p.identifier === pkg.name && p.registryType === "npm",
);
if (!npmPkg) {
  fail(`server.json: no npm package entry with identifier "${pkg.name}"`);
} else if (npmPkg.version !== expected) {
  fail(`server.json: packages[].version is ${npmPkg.version}, expected ${expected}`);
} else if (npmPkg.transport?.type !== "stdio") {
  fail(`server.json: packages[].transport.type is "${npmPkg.transport?.type}", expected "stdio"`);
} else {
  ok(`server.json npm package entry pins ${expected} over stdio`);
}

// Three hardcoded literals live in the vendored config (appConfig.version,
// appConfig.server.version, mcpConfig.server.version). Match on the literal
// rather than importing, so this stays a pure text check with no build step.
const configPath = "src/vendor/config.ts";
const configSrc = readFileSync(rel(configPath), "utf8");
const literals = [...configSrc.matchAll(/version:\s*"([^"]+)"/g)].map((m) => m[1]);

if (literals.length === 0) {
  fail(`${configPath}: found no \`version: "…"\` literals — has it moved?`);
} else {
  const wrong = literals.filter((v) => v !== expected);
  if (wrong.length > 0) {
    fail(
      `${configPath}: ${wrong.length} of ${literals.length} version literals are ${[...new Set(wrong)].join(", ")}, expected ${expected}`,
    );
  } else {
    ok(`${configPath}: all ${literals.length} version literals are ${expected}`);
  }
}

// ── the changelog names the version being published ────────────────────────
// Task 21.6. The failure this catches is a silent one: `npm version` bumps
// package.json and every manifest gate above follows it happily, so a release
// can be fully "consistent" and still ship with no record of what changed. That
// is the state this project was in for its whole life until 2026-09-10.
//
// Deliberately a text match on the heading rather than a parse: the file is for
// humans first, and a gate that demands a particular structure ends up dictating
// how the prose is written.
const changelogPath = "CHANGELOG.md";
try {
  const changelog = readFileSync(rel(changelogPath), "utf8");
  // `## [0.2.0]` — the Keep a Changelog heading. The trailing date is optional
  // so an entry can be written before the release date is known.
  const heading = new RegExp(`^##\\s*\\[${expected.replace(/\./g, "\\.")}\\]`, "m");
  if (heading.test(changelog)) {
    ok(`${changelogPath} has an entry for ${expected}`);
  } else {
    fail(
      `${changelogPath}: no entry for ${expected} — add a "## [${expected}]" section describing ` +
        `what changed before publishing. Users on an older install have no other way to find out.`,
    );
  }
} catch (err) {
  fail(
    `${changelogPath}: could not be read (${err.code ?? err.message}) — every release needs one.`,
  );
}

// ── packed contents ────────────────────────────────────────────────────────
// --ignore-scripts ASKS npm not to re-run `prepare` (a full rebuild). npm 11
// obeys; npm 10.8 — which is what Node 20 ships, and what CI runs — does not,
// and the rebuild's banner then lands on stdout ahead of the JSON. Either way
// the listing reflects a current dist/, which is what actually gets published.
// CI runs `npm run build` immediately before this.
let packed;

/**
 * npm's `--json` array is not reliably the only thing on stdout: a `prepare`
 * that ran anyway prints first. CI failed exactly here on 2026-09-18 while the
 * same command passed locally on npm 11 — so anchor on the array rather than
 * assume a clean pipe. Anchored at a line start, because the first bare `[` in
 * the output belongs to an ANSI colour escape, not to JSON.
 */
function jsonArrayIn(out) {
  const trimmed = out.trim();
  if (trimmed.startsWith("[")) return trimmed;
  const at = /^\[/m.exec(out);
  // No anchor found: hand back the original so JSON.parse reports the real text.
  return at ? out.slice(at.index) : trimmed;
}

try {
  // execSync, not execFileSync: on Windows npm is a .cmd shim that Node refuses
  // to spawn directly (the CVE-2024-27980 fix), so it needs a shell either way.
  // The command is a fixed literal with no interpolation — nothing to inject.
  const out = execSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  packed = JSON.parse(jsonArrayIn(out));
} catch (err) {
  fail(`npm pack --dry-run failed: ${err.message ?? String(err)}`);
}

if (packed) {
  const files = (packed[0]?.files ?? []).map((f) => f.path.replace(/\\/g, "/"));
  if (files.length === 0) {
    fail("npm pack reported an empty file list");
  }
  for (const required of REQUIRED_FILES) {
    if (files.includes(required)) {
      ok(`tarball contains ${required}`);
    } else {
      fail(`tarball is missing ${required} — did the build run? (packed: ${files.length} files)`);
    }
  }

  // Counted rather than listed one by one: the point is that the set is complete,
  // and naming the missing ones is what makes the failure actionable.
  const missingRefs = REQUIRED_SKILL_REFERENCES.filter((f) => !files.includes(f));
  if (missingRefs.length === 0) {
    ok(`tarball contains all ${REQUIRED_SKILL_REFERENCES.length} skill references`);
  } else {
    fail(
      `tarball is missing ${missingRefs.length} skill reference(s) the SKILL.md points at: ` +
        missingRefs.join(", "),
    );
  }
}

// ── verdict ────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}

console.log(`\nRelease ${expected} looks consistent.`);
