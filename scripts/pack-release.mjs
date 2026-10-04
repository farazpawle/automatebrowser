/**
 * Builds the two files a GitHub release offers for download, into `release/`:
 *
 *   automatebrowser.mcpb          one-click install for Claude Desktop
 *   automate-browser-skill.zip    the shipped agent skill, for any skills folder
 *
 * The names carry no version on purpose: the website links to
 * releases/latest/download/<name>, which only stays valid if the name never changes.
 *
 * Run `npm run build` first — this packs dist/ as it stands. Used by
 * .github/workflows/release.yml and runnable locally to check a bundle before tagging.
 *
 * The bundle carries its production node_modules: tsup leaves dependencies external, and
 * Claude Desktop installs nothing. `--ignore-scripts` stops `prepare` rebuilding inside the
 * stage, where there are no devDependencies to build with.
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned: the packer writes what every installer runs.
const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release");
const stage = join(out, "mcpb-stage");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("[pack-release] dist/index.js is missing — run `npm run build` first.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const file of ["package.json", "package-lock.json", "LICENSE"]) {
  cpSync(join(root, file), join(stage, file));
}
cpSync(join(root, "mcpb", "manifest.json"), join(stage, "manifest.json"));
cpSync(join(root, "docs", "logo.png"), join(stage, "icon.png"));
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });

const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });

console.log(`[pack-release] ${version}: installing production dependencies into the bundle`);
run("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", stage);

const mcpb = join(out, "automatebrowser.mcpb");
run(`npx -y ${MCPB_CLI} pack "${stage}" "${mcpb}"`);

// `zip` on Linux/macOS. Windows has no `zip`, but its own bsdtar writes one with -a — named by
// full path, because Git Bash puts a GNU tar (which cannot) first on PATH.
const skillZip = join(out, "automate-browser-skill.zip");
const skillsDir = join(root, "skills");
if (process.platform === "win32") {
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  run(`"${tar}" -a -c -f "${skillZip}" automate-browser`, skillsDir);
} else {
  run(`zip -qr "${skillZip}" automate-browser`, skillsDir);
}

rmSync(stage, { recursive: true, force: true });
console.log(`[pack-release] wrote ${mcpb}`);
console.log(`[pack-release] wrote ${skillZip}`);
