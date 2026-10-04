// Regenerate the README's tool reference from the server's own schemas (roadmap
// C22), so the public docs cannot drift from the code.
//
// Owns three things in README.md:
//   1. everything between the AUTO-GENERATED:tools markers — the profile line
//      and the section tables
//   2. the tool count, wherever the phrase "<n> … tools" appears
//   3. everything between the AUTO-GENERATED:config markers — the environment
//      variable table, rendered from src/utils/env-vars.ts (plan 09, D13)
//
// The env-var half also GATES: a variable read anywhere in src/ but missing from
// that declaration fails the run, and so does a declared variable nothing reads.
// Both directions, because the table went wrong in both — it had never heard of
// AUTOMATE_BROWSER_PORT, which in turn was wired to nothing.
//
// Row descriptions are the FIRST SENTENCE of each tool's schema description.
// Several descriptions are multi-paragraph prompts aimed at an agent; pasting
// them whole would bury the table. First sentence keeps it scannable while
// still coming from the code.
//
// Section membership lives in SECTIONS below, because a tool schema carries no
// category. That list is checked against the live tool set on every run: a tool
// missing from it, or a name in it that no longer exists, fails the script — so
// adding a tool without documenting it cannot pass CI.
//
// Usage:  npm run build && npm run docs:generate
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = resolve(root, "README.md");
// The SHIPPED skill's tool table (plan 02, Task 7.18). It is the same rendered
// block as README's, written from the same schemas in the same run — because the
// skill is what reaches users' agents, and a skill that lists a tool the server
// no longer has is worse than no skill. Adding a tool without documenting it
// already fails this script; now it fails for both targets at once.
const skillRefPath = resolve(root, "skills/automate-browser/references/tool-reference.md");
const entry = resolve(root, "dist/index.js");

const START =
  "<!-- AUTO-GENERATED:tools START — do not edit by hand; run `npm run docs:generate` -->";
const END = "<!-- AUTO-GENERATED:tools END -->";

// The Configuration table (plan 09, D13). Same mechanism as the tool tables, for
// the same reason: it was the last list in README maintained by hand, and it had
// already drifted — `AUTOMATE_BROWSER_PORT` was being read in src/ and the table
// had never heard of it.
const CONFIG_START =
  "<!-- AUTO-GENERATED:config START — do not edit by hand; run `npm run docs:generate` -->";
const CONFIG_END = "<!-- AUTO-GENERATED:config END -->";
const envVarsPath = resolve(root, "src/utils/env-vars.ts");

/** Order here is the order rendered. `prose` is emitted between heading and table. */
const SECTIONS = [
  {
    title: "Navigation & history",
    tools: ["browser_navigate", "browser_go_back", "browser_go_forward"],
  },
  {
    title: "Snapshot & interaction",
    tools: [
      "browser_snapshot",
      "browser_click",
      "browser_hover",
      "browser_type",
      "browser_select_option",
      "browser_drag",
    ],
  },
  {
    title: "Input & timing",
    tools: ["browser_press_key", "browser_wait", "browser_wait_for"],
  },
  {
    title: "Reading content",
    tools: ["browser_read_page", "browser_get_html", "browser_find"],
  },
  {
    title: "Page-declared tools",
    prose:
      "Actions the PAGE publishes about itself, which an agent can call directly instead of finding and " +
      "clicking controls for. Forward-looking: the standard is a draft and almost no live site declares " +
      "anything yet, so `list` normally comes back empty with the reason.",
    tools: ["browser_page_tools"],
  },
  {
    title: "Forms & scrolling",
    tools: ["browser_fill_form", "browser_clear", "browser_scroll"],
  },
  {
    title: "State: cookies, storage, network, downloads, dialogs",
    tools: [
      "browser_get_cookies",
      "browser_set_cookie",
      "browser_storage",
      "browser_network_requests",
      "browser_handle_dialog",
      "browser_downloads",
      "browser_proxy",
    ],
  },
  {
    title: "Performance",
    prose:
      "`browser_perf_trace` measures THIS machine on THIS run. Recording attaches the debugger itself " +
      "(banner) and detaches it on stop unless advanced mode was already on; " +
      '`action: "memory"` samples the JS heap with no debugger and no banner. ' +
      "`browser_perf_field_data` needs no browser at all - it reads Google's Chrome UX Report for what " +
      "real visitors experienced, and sends the URL you ask about to that public API.",
    tools: ["browser_perf_field_data"],
  },
  {
    title: "Capture & evaluation",
    tools: ["browser_screenshot", "browser_get_console_logs", "browser_issues", "browser_eval"],
  },
  {
    title: "Tabs",
    tools: [
      "browser_list_tabs",
      "browser_new_tab",
      "browser_switch_tab",
      "browser_select_tab",
      "browser_close_tab",
    ],
  },
  {
    title: "Multi-IDE / clients",
    tools: [
      "browser_list_clients",
      "browser_select_client",
      "browser_force_claim",
      "browser_release_client",
      "browser_status",
    ],
  },
  {
    title: "Advanced (opt-in CDP)",
    prose:
      "Attach the Chrome debugger only when you need full-fidelity input or network bodies. Enable with\n" +
      "`browser_advanced_mode` first (a perf trace attaches by itself); a debugging banner shows only\n" +
      "while it's attached.",
    tools: [
      "browser_advanced_mode",
      "browser_upload_file",
      "browser_get_network_request",
      "browser_perf_trace",
      "browser_emulate",
    ],
  },
];

/**
 * First sentence of a description, collapsed onto one line and escaped for a
 * Markdown table cell. A sentence ends at `.`/`!`/`?` followed by whitespace or
 * end-of-string — with the abbreviations the descriptions actually use excluded,
 * so "Press a key or modifier combo (e.g. `Control+A`)" does not truncate to
 * "Press a key or modifier combo (e.g".
 */
const ABBREVIATIONS = ["e\\.g", "i\\.e", "etc", "vs", "approx", "cf"];

function firstSentence(description) {
  const flat = description.replace(/\s+/g, " ").trim();
  const re = new RegExp(`^(.*?(?<!\\b(?:${ABBREVIATIONS.join("|")}))[.!?])(?:\\s|$)`);
  const m = flat.match(re);
  const sentence = (m ? m[1] : flat).replace(/\.$/, "");
  return sentence.replace(/\|/g, "\\|");
}

// ── load the live tool set ─────────────────────────────────────────────────
let tools;
try {
  const out = execFileSync(process.execPath, [entry, "--print-tools", "full"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  tools = JSON.parse(out);
} catch (err) {
  console.error(`Failed to run ${entry} --print-tools full`);
  console.error(err.message ?? String(err));
  console.error("Did you run `npm run build` first?");
  process.exit(1);
}

const byName = new Map(tools.map((t) => [t.name, t]));

// Per-profile counts (roadmap C1). Measured from the built server the same way
// as the full set, so README can never claim a profile size the registry does
// not actually serve.
const PROFILES = ["full", "core", "slim"];
const profileCounts = PROFILES.map((name) => {
  try {
    const out = execFileSync(process.execPath, [entry, "--print-tools", name], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return "`" + name + "` (" + JSON.parse(out).length + ")";
  } catch (err) {
    console.error("Failed to run " + entry + " --print-tools " + name);
    console.error(err.message ?? String(err));
    process.exit(1);
  }
});

const profileLine =
  "**Tool profiles** — " +
  profileCounts.join(" · ") +
  ". Set `AUTOMATE_BROWSER_TOOLS` to a profile name or a comma-separated " +
  "category list to serve fewer schemas; `browser_status`, `browser_list_clients` " +
  "and `browser_select_client` are always served.";

// ── the section map must cover the tool set exactly ────────────────────────
const listed = SECTIONS.flatMap((s) => s.tools);
const duplicates = listed.filter((n, i) => listed.indexOf(n) !== i);
const undocumented = tools.map((t) => t.name).filter((n) => !listed.includes(n));
const unknown = listed.filter((n) => !byName.has(n));

const problems = [
  ...undocumented.map(
    (n) => `${n} exists but is in no SECTIONS entry — add it to scripts/generate-docs.mjs`,
  ),
  ...unknown.map((n) => `${n} is listed in SECTIONS but no longer exists — remove it`),
  ...duplicates.map((n) => `${n} is listed in more than one section`),
];

if (problems.length > 0) {
  console.error("Tool reference is out of sync with the server:");
  for (const p of problems) console.error(`  FAIL  ${p}`);
  process.exit(1);
}

// ── render ─────────────────────────────────────────────────────────────────
const body = SECTIONS.map((section) => {
  const rows = section.tools
    .map((n) => `| \`${n}\` | ${firstSentence(byName.get(n).description)} |`)
    .join("\n");
  // The blank line after prose is required — GitHub will not render a table that
  // butts directly against a preceding paragraph.
  return [
    `### ${section.title}`,
    ...(section.prose ? [section.prose, ""] : []),
    "| Tool | Description |",
    "|------|-------------|",
    rows,
  ].join("\n");
}).join("\n\n");

const rendered = [profileLine, body].join("\n\n");

/** Swap the marked block in `text` for `block`, or exit 1 naming the file. */
function replaceMarked(text, block, label, start = START, end = END) {
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (startAt === -1 || endAt === -1 || endAt < startAt) {
    console.error(
      `${label} is missing its AUTO-GENERATED markers (start=${startAt}, end=${endAt}).`,
    );
    process.exit(1);
  }
  return text.slice(0, startAt + start.length) + `\n\n${block}\n\n` + text.slice(endAt);
}

/** Write only when the content changed, so `git diff --exit-code` stays meaningful. */
function writeIfChanged(path, before, after, label) {
  if (after === before) {
    console.log(`  ok    ${label} already up to date`);
  } else {
    writeFileSync(path, after);
    console.log(`  wrote ${label}`);
  }
}

// ── the tool count, in every file that states one ──────────────────────────
// Matched by pattern rather than line number, and the hit count per file is
// asserted: a reworded sentence that loses a mention fails loudly rather than
// leaving a stale number behind somewhere else. Registering a new site here is
// the correct response to that failure — rewording to dodge the guard is how a
// wrong count ships.
//
// README is NOT the only file that states this number, and it is the least
// important one that does. Until 2026-09-01 it was the only one maintained, so a
// 46th tool would have left three user-facing files confidently claiming 45: the
// shipped SKILL.md, which an agent reads on every task, and the two plugin
// manifests, which are the listing a user reads before deciding to install.
const COUNT_RE = /\b\d+\b(?=\s+(?:browser\s+|MCP\s+)?tools\b)/g;

function applyCount(text, label, expect) {
  const hits = text.match(COUNT_RE) ?? [];
  if (hits.length !== expect) {
    console.error(
      `Expected ${expect} tool-count mention(s) in ${label}, found ${hits.length}.` +
        `\nEither a mention was reworded away or a new one appeared — reconcile, then` +
        ` update the expected count where ${label} is handled in scripts/generate-docs.mjs.`,
    );
    process.exit(1);
  }
  return text.replace(COUNT_RE, String(tools.length));
}

// ── the Configuration table, and the gate that keeps it honest ─────────────
// The declaration is TypeScript in src/, so it is read through tsx rather than
// parsed out of the file with a regex: a regex over source is a second, weaker
// copy of the language's own parser, and it fails silently the first time
// someone reformats the list.
let envVars;
try {
  const out = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      "import('./src/utils/env-vars.ts').then(m => console.log(JSON.stringify(m.ENV_VARS)))",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  envVars = JSON.parse(out);
} catch (err) {
  console.error(`Failed to read ${relative(root, envVarsPath)} through tsx`);
  console.error(err.message ?? String(err));
  process.exit(1);
}

// Every way this repo names an environment variable: read directly, or held in a
// `const X_ENV = "…"` that something else reads. Both forms are real reads, and
// a gate that knew only the first would have missed thirteen of the thirty.
const ENV_READ_RE =
  /process\.env\.(AUTOMATE_BROWSER_[A-Z0-9_]+)|process\.env\[\s*["'](AUTOMATE_BROWSER_[A-Z0-9_]+)["']\s*\]|["'](AUTOMATE_BROWSER_[A-Z0-9_]+)["']/g;

/** Every `*.ts` under src/, except the declaration itself. */
function collectSources(dir) {
  const out = [];
  for (const entryName of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entryName.name);
    if (entryName.isDirectory()) out.push(...collectSources(full));
    else if (entryName.name.endsWith(".ts") && full !== envVarsPath) out.push(full);
  }
  return out;
}

// Excluding env-vars.ts is not tidiness — it is the whole point. The declaration
// names every variable, so scanning it would make the list satisfy itself and the
// gate would pass no matter what src/ actually reads.
const readInSrc = new Map();
for (const file of collectSources(resolve(root, "src"))) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(ENV_READ_RE)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (!readInSrc.has(name)) readInSrc.set(name, relative(root, file));
  }
}

const declared = new Set(envVars.map((v) => v.name));
const configProblems = [];
for (const [name, where] of readInSrc) {
  if (!declared.has(name)) {
    configProblems.push(
      `${name} is read in ${where} but is not in src/utils/env-vars.ts — add it, with its default and one line of purpose`,
    );
  }
}
// The mirror. A variable that stops being read leaves a row telling users to set
// something that does nothing, which is the same rot in the other direction.
for (const name of declared) {
  if (!readInSrc.has(name)) {
    configProblems.push(
      `${name} is declared in src/utils/env-vars.ts but nothing in src/ reads it — delete the entry, or the dead read`,
    );
  }
}
if (configProblems.length > 0) {
  console.error("The Configuration table and the code disagree:");
  for (const p of configProblems) console.error(`  FAIL  ${p}`);
  process.exit(1);
}

const cell = (s) => s.replace(/\|/g, "\\|");
const configTable = [
  "| Variable | Purpose | Default |",
  "|----------|---------|---------|",
  ...envVars
    .filter((v) => !v.internal)
    .map((v) => `| \`${v.name}\` | ${cell(v.purpose)} | ${cell(v.default)} |`),
].join("\n");

// ── README ─────────────────────────────────────────────────────────────────
const readmeBefore = readFileSync(readmePath, "utf8");
let readmeAfter = replaceMarked(readmeBefore, rendered, "README.md");
readmeAfter = replaceMarked(
  readmeAfter,
  configTable,
  "README.md config table",
  CONFIG_START,
  CONFIG_END,
);
// 5 since 2026-08-31: the "Skills that ship with it" section names the count when
// describing the shipped tool reference.
readmeAfter = applyCount(readmeAfter, "README.md", 5);
writeIfChanged(readmePath, readmeBefore, readmeAfter, `README.md (${tools.length} tools)`);

// ── the shipped skill's copy of the same table ─────────────────────────────
// The section tables only: the profile line is a README concern (it documents an
// env var an agent does not set), and repeating it in the skill would be the
// duplication the skill rules forbid.
const skillOriginal = readFileSync(skillRefPath, "utf8");
const skillNext = replaceMarked(
  skillOriginal,
  body,
  "skills/automate-browser/references/tool-reference.md",
);

writeIfChanged(
  skillRefPath,
  skillOriginal,
  skillNext,
  "skills/automate-browser/references/tool-reference.md",
);

// Every tool must ALSO carry a hand-written gotcha row in that file. The
// generated table says a tool exists; the gotcha row is the part with the value,
// and it is exactly the part that silently rots when a tool is added. Checking
// for the backticked name outside the generated block is crude but catches the
// real failure: a new tool shipped with no guidance for the agents that ship it.
const gotchaRegion = skillNext.slice(skillNext.indexOf(END) + END.length);
const missingGotchas = tools
  .map((t) => t.name)
  .filter((n) => !gotchaRegion.includes("`" + n + "`"));

if (missingGotchas.length > 0) {
  console.error("The shipped skill documents a different tool set than the server serves:");
  for (const n of missingGotchas) {
    console.error(
      `  FAIL  ${n} has no entry in the hand-written "Arguments and gotchas" section` +
        ` of skills/automate-browser/references/tool-reference.md`,
    );
  }
  process.exit(1);
}

// ── SKILL.md: the count, the scope gate, and the section index ─────────────
const skillMdPath = resolve(root, "skills/automate-browser/SKILL.md");
const skillMdBefore = readFileSync(skillMdPath, "utf8");

// Three sites: the frontmatter description (which a client shows before the body
// is ever loaded), the Scope Gate, and the summary on the tool-reference block.
let skillMd = applyCount(skillMdBefore, "skills/automate-browser/SKILL.md", 3);

// The Scope Gate is the passage an agent is told to read BEFORE deciding whether
// this skill applies at all, and two places state where it lives — the
// frontmatter description and the heading itself. Adding a bullet to the gate
// moves its end line, and the agent then reads whatever now sits at the old
// range. The boundaries are mechanical (heading down to its closing rule), so
// this is derived rather than asserted: the file is corrected, not just blamed.
const skillLines = skillMd.split("\n");
const gateStart = skillLines.findIndex((l) => /^## Scope Gate\b/.test(l));
const gateEnd = skillLines.findIndex((l, i) => i > gateStart && /^---\s*$/.test(l));

if (gateStart === -1 || gateEnd === -1) {
  console.error(
    "skills/automate-browser/SKILL.md: could not locate the Scope Gate" +
      (gateStart === -1
        ? " — no `## Scope Gate` heading."
        : " — the heading has no closing `---` rule, so its end line is undefined."),
  );
  console.error(
    "  The frontmatter sends every agent to that line range before it reads anything else.",
  );
  process.exit(1);
}

const gateRange = `${gateStart + 1}-${gateEnd + 1}`;
skillMd = skillMd
  .replace(/lines \d+-\d+ of SKILL\.md/, `lines ${gateRange} of SKILL.md`)
  .replace(/\(Lines \d+-\d+\)/, `(Lines ${gateRange})`);

writeIfChanged(
  skillMdPath,
  skillMdBefore,
  skillMd,
  `skills/automate-browser/SKILL.md (scope gate ${gateRange})`,
);

// The index sends an agent to `references/x.md` lines 40-64 rather than to the
// whole file, which is the whole reason it is cheap to use. A reference that
// grows by three lines silently turns every range after it into a lie, and the
// agent reads the wrong section with no error anywhere. Unlike the scope gate,
// the section boundaries inside a reference are editorial and cannot be derived,
// so this one is caught and handed back rather than fixed: it checks each
// "(N lines)" claim against the file and names the correct number.
const refsDir = resolve(root, "skills/automate-browser/references");

const indexProblems = [];
for (const m of skillMd.matchAll(/references\/([\w-]+\.md) \((\d+) lines\)/g)) {
  const [, file, claimedLines] = m;
  let actualLines;
  try {
    actualLines = readFileSync(resolve(refsDir, file), "utf8").split("\n").length - 1;
  } catch {
    indexProblems.push(`${file} is in SKILL.md's index but does not exist`);
    continue;
  }
  if (Number(claimedLines) !== actualLines) {
    indexProblems.push(
      `${file}: SKILL.md says ${claimedLines} lines, file has ${actualLines} —` +
        ` the Section|Lines ranges for it are now wrong too`,
    );
  }
}

if (indexProblems.length > 0) {
  console.error("SKILL.md's section index no longer matches its references:");
  for (const p of indexProblems) console.error(`  FAIL  ${p}`);
  console.error(
    "  Fix the line counts AND the ranges in SKILL.md — an agent follows those ranges verbatim.",
  );
  process.exit(1);
}

// ── the distribution manifests ─────────────────────────────────────────────
// The sentence a user reads in a listing before deciding to install. Every file
// that states the count belongs here, not just the two this guard was written
// for: `verify:release` proves these files are PACKED and pin the right VERSION,
// and `claude plugin validate` proves the Claude pair PARSES. None of them reads
// what the description claims.
//
// `mcp.json` is absent because it carries no prose — adding it would assert a
// mention that is not there and fail every run.
for (const relPath of [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "plugin.json",
  "gemini-extension.json",
]) {
  const path = resolve(root, relPath);
  const before = readFileSync(path, "utf8");
  writeIfChanged(path, before, applyCount(before, relPath, 1), relPath);
}

// ── the landing page ─────────────────────────────────────────────────────
// `docs/index.html` is the first thing a stranger sees, and nothing read it
// until 2026-09-16, when it was found claiming 45 tools against a real 46 —
// exactly the state the shipped SKILL.md was in before 2026-09-01, and the two
// plugin manifests before 2026-09-07. Three times now, the same shape: a guard
// that covers the files it was written for rather than every file carrying the
// claim.
//
// It states the count twice, in two spellings. The prose mention is ordinary
// and `applyCount` handles it; the stat tile is a bare numeral inside markup,
// with no whitespace before the word, so it needs its own pattern. Both are
// asserted rather than best-effort — a redesign that drops either one fails the
// run instead of silently leaving a stale number on the page.
const sitePath = resolve(root, "docs/index.html");
const siteBefore = readFileSync(sitePath, "utf8");
const SITE_STAT_RE = /(<b>)\d+(<\/b><span>Tools<\/span>)/;

if (!SITE_STAT_RE.test(siteBefore)) {
  console.error(
    "docs/index.html: could not find the Tools stat tile" +
      " (expected `<b>N</b><span>Tools</span>`).\nIf the page was redesigned, update" +
      " SITE_STAT_RE in scripts/generate-docs.mjs — do not delete this guard, or the" +
      " count goes back to being maintained by memory.",
  );
  process.exit(1);
}

writeIfChanged(
  sitePath,
  siteBefore,
  applyCount(siteBefore.replace(SITE_STAT_RE, `$1${tools.length}$2`), "docs/index.html", 2),
  "docs/index.html",
);

// Every tool must ALSO appear in the page's hand-written catalogue, the section
// that says in plain words what each one is FOR. Same reasoning as the gotcha
// rows in the shipped reference: a count that is rewritten automatically proves
// only that the NUMBER is right, and a page claiming 47 tools while describing
// 46 is worse than one claiming 46, because the missing one is invisible.
// Checked both ways — a tool with no entry, and an entry for a tool that no
// longer exists, which is how a rename leaves a ghost behind.
const SITE_ENTRY_RE = /<dt>(browser_[a-z_0-9]+)<\/dt>/g;
const listedOnSite = [...siteBefore.matchAll(SITE_ENTRY_RE)].map((m) => m[1]);
const siteProblems = [];

for (const { name } of tools) {
  const seen = listedOnSite.filter((n) => n === name).length;
  if (seen === 0) siteProblems.push(`  FAIL  ${name} has no entry in the catalogue`);
  else if (seen > 1) siteProblems.push(`  FAIL  ${name} appears ${seen} times in the catalogue`);
}
for (const name of new Set(listedOnSite)) {
  if (!tools.some((t) => t.name === name)) {
    siteProblems.push(`  FAIL  ${name} is in the catalogue but the server no longer serves it`);
  }
}

if (siteProblems.length > 0) {
  console.error(
    'docs/index.html\'s "The full list" section no longer matches the tools the server serves:',
  );
  for (const line of siteProblems) console.error(line);
  console.error(
    "  This one is hand-written on purpose \u2014 it says what each tool is FOR, in a\n" +
      "  sentence a person reads, which nothing can generate. Add or remove the\n" +
      "  <dt>/<dd> pair in the matching category and keep the prose in that voice.",
  );
  process.exit(1);
}
