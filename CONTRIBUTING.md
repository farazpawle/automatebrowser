# Contributing

Thanks for looking. This is a small project with unusually strict gates, for one reason: it drives a
real browser that is signed into everything, so a change that is merely *probably* right is not good
enough. Most of what follows exists because something went wrong once.

## Getting set up

```bash
npm install
npm run build          # tsup, three entries: dist/index.js, dist/relay.js, dist/cli.js
npm run check          # the whole gate, ~2 minutes
```

`src/` is the source of truth. `dist/` is gitignored but is a real build of it — never hand-edit it.
The browser extension is a separate package under `Chrome-extension/` with its own `npm install`.

For anything beyond a typo, open an issue first so the approach is agreed before you write it.

## The gate

`npm run check` runs everything below, in this order, and CI runs the same list on every push. It is
ordered so the cheap things fail first.

| Step | What it catches |
|---|---|
| `typecheck`, `typecheck:tests` | Types, source and tests separately |
| `lint`, `format:check` | ESLint and Prettier. **Fix the cause — never silence a rule with a disable comment** |
| `test` | The unit suite. No browser, no relay, no model; runs in under a second |
| `build` | It must compile and bundle cleanly |
| `verify:release` | Version drift across the manifests, the packed tarball's contents, and a changelog entry for the current version |
| `tokens` | The tool-schema token budget — see below |
| `docs:generate` | Regenerates the tool tables and counts; a diff means someone hand-edited generated output |
| `smoke` | 248 checks against a real relay with fake browsers |
| `npm audit --omit=dev` | Production dependency advisories |

Two more are not in `check` because they cost real time or a real browser:

- `npm run test:integration` — a real Chrome with the real extension.
- `npm run test:live` — the five checks that were once marked "needs a person". Serves a genuinely
  self-signed certificate and records a real trace, against a launched Chrome carrying the fresh
  extension build. Needs `openssl` on `PATH`. **Read its header before adding a `[User]` task** — it
  is the argument that "needs a real browser" and "needs a person" are not the same thing.
- `npm run memory:relay` — profiles the relay for heap growth across connection churn. Its own CI
  job. The relay is the only process here meant to outlive its clients, so it is the only one where
  a slow leak matters.

**Do not switch a gate off to get a change through.** If a gate is wrong, fix the gate in its own
commit and say why.

## The token budget

Every tool schema is sent to the model on **every single request**, whether or not the tool is used.
So a new parameter is not free — it is a tax on every conversation the user ever has.

`npm run tokens` measures the real cost with the real tokeniser and fails the build over budget:

| Profile | Budget | Currently |
|---|---|---|
| `full` | 10,520 | 10,471 across 46 tools |
| `core` | 4,610 | |
| `slim` | 1,920 | |

The rule: **write the description shorter before you raise the budget.** If a raise is genuinely
needed, raise it once, in its own commit, with the projected cost broken down per item and a stated
margin — see the comment block above `BUDGETS` in `scripts/count-tokens.mjs` for the format. A budget
raised reactively, twice, is a budget that has stopped meaning anything.

## The shipped skill

`skills/automate-browser/` is the one skill shipped in the package and auto-discovered when it is
installed as a plugin. It is about using the *tools*, never about `src/` internals. `SKILL.md` is the
always-read part; depth lives in `references/`, indexed by line range.

It is **one** skill, not several. It was four until they were consolidated, because two sets of
guidance are free to disagree and the stale one still ships. Add a *reference*, not a sibling skill.

## Documentation is part of the change, not after it

A behaviour change that has not reached the docs is not finished, in the same sense that one that
does not compile is not finished. Three things are owed:

1. **README** — a line in "What it can do", and a `###` section under Behaviour whenever the change
   alters what an agent experiences: a new capability, a changed default, a new failure mode, a
   limit, or an error that now reads differently. **State the honest limit.** Where a number was
   measured, put the number in — "adds latency" is not a number.
2. **The shipped skill** — because it is read by an agent on every task, and a wrong sentence there
   is not merely misleading, it is executed. Grep for the **old claim**, never the tool name: the
   phrase you just made false. `grep -rn "focused tab" skills/` is the check that would have caught
   the real case; grepping the tool name came back clean while the skill taught the bug for four days
   with CI green throughout.
3. **`src/utils/env-vars.ts`** — for any new environment variable. The README's Configuration table
   is generated from it, and `docs:generate` fails both ways: a variable read but not declared, and
   one declared that nothing reads.

Generated tables and tool counts are machine-maintained between the `AUTO-GENERATED` markers. Change
the tool's `description` in `src/tools/`, then run `npm run docs:generate`. **Never edit them by
hand.** A new tool also needs an entry in `SECTIONS` in `scripts/generate-docs.mjs`.

**The test:** name the line a user would find this from, having never read the code. If you cannot,
it is not documented.

## Tests

New logic needs a test. Styling, config and documentation changes do not, unless they contain
conditional logic. Prefer the cheapest suite that can fail honestly: a unit test with no browser
beats an integration test that needs one. Where a check genuinely cannot be automated, say so in the
pull request with the reason — never leave it silently unrun.

## Commits and pull requests

- Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`), with a
  scope where it helps.
- **Say why, not what.** The diff already says what.
- Add a `## [Unreleased]` entry in `CHANGELOG.md` for anything user-visible.
- Keep the working tree clean of generated drift: CI diffs `README.md`, `skills/`, `.claude-plugin/`
  and the root manifests and fails if regenerating changes them.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
