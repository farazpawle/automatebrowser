// Run the unit suite (plan 09, D2).
//
// Why a script rather than `node --test tests/`: passing a DIRECTORY makes tsx's
// resolver treat it as a module specifier and fail with ERR_UNSUPPORTED_DIR_IMPORT,
// and passing a GLOB depends on test-runner glob support that Node 20 (what CI
// runs) does not have. Enumerating the files here and passing them as explicit
// paths works identically on every Node from 20 up, which is the whole point of a
// gate: it must not fail for a reason that has nothing to do with the code.
//
// Usage:  npm test
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = join(root, "tests");

/** Every `*.test.ts` under tests/, at any depth. */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

let files;
try {
  files = collect(testsDir);
} catch (err) {
  console.error(`No tests/ directory at ${testsDir}: ${err.message}`);
  process.exit(1);
}

if (files.length === 0) {
  // An empty suite passing silently is how a suite quietly stops existing.
  console.error("No *.test.ts files found under tests/ — refusing to report success.");
  process.exit(1);
}

console.log(`Running ${files.length} test file(s):`);
for (const f of files) console.log(`  ${relative(root, f)}`);

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  cwd: root,
});

process.exit(result.status ?? 1);
