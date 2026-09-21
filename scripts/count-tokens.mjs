// Measure what the tool schemas cost an agent's context (roadmap C23), and fail
// the build when that cost creeps past its budget.
//
// Every MCP client pays for the whole tool list on every single request, so this
// is the baseline any tool-slimming work has to beat. Numbers come from the
// *built* server via the hidden --print-tools flag, so they always reflect
// dist/, never a stale source tree.
//
// Tokenizer caveat: Anthropic publishes no offline tokenizer for Claude 3+, so
// this counts with OpenAI's `o200k_base` (GPT-4o/5 family). That is a real BPE
// tokenizer — far better than a chars/4 guess — but treat it as "within a few
// percent of Claude", not exact. The chars/4 heuristic is still printed on the
// total line so you can see how badly it lies.
//
// Usage:  npm run build && npm run tokens [profile]
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encode } from "gpt-tokenizer/encoding/o200k_base";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "dist/index.js");

/**
 * Per-profile token ceiling, enforced in CI. A schema change that blows through
 * one of these is a deliberate decision: re-run `npm run tokens`, justify the
 * cost, and raise the number in the same commit — never bump it reflexively.
 * An unlisted profile (or a category list) simply reports without gating.
 */
// Measured 2026-08-25 with the tool registry in place, all three ~5% of slack:
//   full 7 763 / 40 tools · core 3 902 / 19 · slim 1 500 / 7
// full was unchanged from the 2026-08-02 pre-registry baseline — the registry
// reorders nothing, so `full` stayed byte-identical to the old inline list.
//
// RAISED 2026-08-26 for C17, the per-call `timeout` param. It is mixed into the
// 12 tools that can actually block (3 navigating + 9 interacting), and a param
// costs ~31 tokens per tool it appears on — so it is a standing ~370-token tax on
// `full` and ~290 on `core`, forever, for a knob agents will use rarely. Taken
// deliberately: without it an agent cannot bail out of a hung page at all, and it
// waits out the 8 s/20 s server default on every call instead. Measured after:
//   full 8 263 / 40 · core 4 192 / 19 · slim 1 542 / 7
// Ceilings keep roughly the same slack they had before (~1.5-4%).
//
// RAISED 2026-08-26 for C4, the `browser_issues` tool — the 41st tool, and the
// first added since the registry landed. It costs ~233 tokens of `full`, which is
// what a whole new tool costs: an agent must be told it exists on every request,
// whether or not it ever calls it. Taken deliberately, with the user's explicit
// go-ahead: it is the only route to a whole class of failure that produces NO
// console error at all — CSP blocks, deprecations, interventions, failed and
// 4xx/5xx requests. Without it an agent facing "the button silently did nothing"
// has no next move; with it, one call names the cause. `core` and `slim` are
// unaffected — it lives in the `capture` category, which neither profile serves,
// so an agent that opted into a cheaper profile pays nothing for this.
// Measured after: full 8 496 / 41 · core 4 192 / 19 · slim 1 542 / 7
//
// RAISED AGAIN 2026-08-26 for the rest of Stage 4 — four params, ~178 tokens
// before trimming, ~134 after. Unlike the C4 tool, this one hits ALL THREE
// profiles: `verbose` and `filePath` sit on `browser_snapshot`, which every
// profile serves, so `core` and `slim` pay ~20 each. `initScript` and
// `handleBeforeUnload` are on `browser_navigate` (full + core).
// Shortest-honest-wording was applied FIRST and recovered 44 tokens; the ceilings
// moved only for what was left. What the spend buys: a full page tree and a
// file-backed snapshot for pages too large to inline, running setup code before
// a page boots, and getting past a "Leave site?" prompt instead of hanging on it.
// Measured after: full 8 674 / 41 · core 4 370 / 19 · slim 1 720 / 7
//
// RAISED 2026-08-26 for Stage 6's C19 — `browser_eval` gains `function`, `args`,
// `filePath` and `dialogAction`: 128 tokens before trimming, 73 after (shortest
// honest wording recovered 55, applied FIRST as always). Only `full` and `slim`
// serve `browser_eval`; `core` does not, and is unchanged at 4 370.
// `slim` absorbed its share inside the existing ceiling — 1 793 against 1 870 —
// so ONLY `full` moves, 8 820 → 8 900.
// What the spend buys: `(el) => el.innerText` with a ref straight from a snapshot
// or find, instead of re-querying by selector inside the expression — the exact
// fragility refs exist to remove, and doubly so now that refs survive a
// re-render. Plus a file-backed result and a way past a dialog raised by the
// evaluated code, which otherwise burns the whole call timeout.
// Measured after: full 8 846 / 41 · core 4 370 / 19 · slim 1 793 / 7
//
// RAISED 2026-08-26 for Stage 6's B8 — `browser_downloads`, the 42nd tool: a
// WHOLE new tool, not a param, so there is no version of this that costs nothing.
// 235 tokens as first written, 214 after shortest-honest-wording (applied FIRST,
// as always) — in line with its neighbours (set_cookie 207, storage 254,
// network_requests 291), so the remainder is the irreducible cost of a tool.
// It sits in the `state` category, which `core` and `slim` do not serve, so only
// `full` moves: 8 900 → 9 100.
// What the spend buys: a click that triggers a download stops being a dead end —
// the agent gets the file's final path on disk and can wait for the transfer to
// land instead of guessing. Paths only; reading the file stays the Stage 1 file
// sandbox's job.
// Measured after: full 9 060 / 42 · core 4 370 / 19 · slim 1 793 / 7
//
// RAISED 2026-08-26 for Stage 7's A2 + A3 — the stage's ONE raise, spent on two
// items at once rather than twice on one each.
// A2 (coordinate click) chose the CHEAP shape after measuring both: a separate
// `browser_click_at` tool cost 151 tokens, `x`/`y`/`dblClick` as params on
// `browser_click` cost 46, and 37 after trimming. A2 alone fitted inside 9 100.
// A3 (`ref`, `webp`, `filePath` on `browser_screenshot`) is +47 after trimming,
// and `browser_screenshot` is served by ALL THREE profiles, so core and slim pay
// too — both still fit inside their existing ceilings (4 453 / 4 520 and
// 1 832 / 1 870), so only `full` moves: 9 100 → 9 200.
// Folded into the same raise: `browser_click`'s DESCRIPTION now says a point is
// an address ("Click an element by ref, or a viewport point by x/y"), because a
// param nobody discovers is a feature nobody has. That was carried as an
// explicit debt from A2 rather than triggering a second raise.
// What the spend buys: driving a canvas/map/PDF that no ref can address, and a
// screenshot of ONE element written to a file instead of a full-page PNG
// inlined into the context window — the single most expensive thing this server
// could previously do to a context.
// Measured after: full 9 143 / 42 · core 4 453 / 19 · slim 1 832 / 7
//
// RAISED AGAIN 2026-08-27 for Stage 7's A4 + A5 — `browser_emulate`, the 43rd
// tool. This is the stage's SECOND raise, against its own "at most one" rule, so
// the reason is written out rather than assumed:
//   - Rule 1 of the stage ("must it be a new tool at all?") was applied and the
//     answer is yes. Emulation is eight options across two mechanisms; the only
//     existing tool it could hide in is `browser_advanced_mode`, which would
//     conflate "attach the debugger" with "emulate a phone".
//   - A4 and A5 were built as ONE task for the same reason A5 demands one tool:
//     splitting them would have meant raising the ceiling twice for one schema.
//   - Shortest-honest-wording FIRST, and it recovered a LOT: 479 tokens as first
//     written -> 319. What was cut and why: `{latitude, longitude}` and
//     `{width, height}` became two-element ARRAYS; seven `.nullable()` options
//     became one `clear: string[]` (each nullable costs an `anyOf` wrapper, and
//     the clear names are validated server-side instead so a typo is still
//     refused); the enum inside `clear` was dropped because it duplicated all
//     seven names on every request; and the `outputSchema` went, since the tool
//     answers in prose. `accuracy` and `deviceScaleFactor` were dropped as
//     deliberate trims — add them back if anyone asks.
// `advanced` is in neither `core` nor `slim`, so only `full` moves once more:
// 9 200 -> 9 480.
// What the spend buys: responsive testing (the thing A1 was dropped for),
// dark-mode testing, a faithful user agent, network and CPU throttling, a faked
// location, and extra request headers — none of which existed in any form.
// Measured after: full 9 462 / 43 · core 4 453 / 19 · slim 1 832 / 7
//
// RAISED 2026-08-27 for Stage 7's C3b — the `include` param. THIRD raise of the
// stage, and the loudest, because this is a param paid on every request forever:
//   - NARROWED FIRST, from twelve interacting tools to THREE. It is on
//     browser_click, browser_type and browser_navigate — where "what happened
//     after that?" is the question an agent actually asks — and NOT on hover,
//     drag, select_option, scroll or press_key, where the answer is almost
//     always "nothing worth a payload". Those can still be followed by an
//     explicit snapshot / console / network call, exactly as today.
//   - CHEAPEST SHAPE, measured: an enum ARRAY cost 34 tokens per tool, a
//     comma-separated STRING costs 23. The section names are validated
//     server-side instead, so a typo is still refused rather than silently
//     attaching nothing. 102 -> 70 across the three.
// `browser_click` and `browser_navigate` are both in `core`, so core pays too;
// `slim` serves navigate only and absorbs its 23 inside the existing ceiling
// (1 856 / 1 870). full 9 480 -> 9 560, core 4 520 -> 4 560.
// What the spend buys: the fresh snapshot, the new console lines and the request
// log arrive WITH the action that caused them, instead of two or three more
// round-trips that an agent usually does not make — which is how a failure gets
// missed. C3a's footer says something broke; this is the half that shows what.
// Measured after: full 9 532 / 43 · core 4 523 / 19 · slim 1 856 / 7
//
// RAISED 2026-08-27 for Stage 8 — the stage's ONE raise, spent on TWO new tools
// and two descriptions, measured together rather than four times over.
//   - Rule 1 ("must it be a new tool at all?") was applied to both and answered
//     differently for each, which is the point of asking:
//       * C8 (CrUX field data) COULD have been `browser_perf_trace {action:"field"}`
//         for roughly 115 tokens less. Rejected on correctness, not size:
//         `browser_perf_trace` is `readOnlyHint:false`, so every call runs the
//         console-delta probe — a real drive against a browser this call never
//         touches — and the tool's own contract says it needs advanced/debugger
//         mode, which this needs no part of. A cheap shape that lies about what
//         it does is not the cheap shape.
//       * C12 (proxy) COULD have hidden inside `browser_emulate`, whose `clear`
//         array is already the off switch it needs. Rejected because every other
//         option there is PER TAB and evaporates with the tab, and this one
//         changes the browsing of the human sharing the browser. Burying a
//         whole-browser mutation among per-tab ones is how it gets made by
//         accident.
//   - Shortest-honest-wording FIRST, as always, and it recovered 43: proxy
//     246 -> 223, field data 205 -> 196, perf_trace 343 (from ~373), console
//     logs 130 (from ~153). What was NOT cut: the "AFFECTS THE WHOLE BROWSER"
//     sentence and the "sends the URL to Google's public API" sentence. Both are
//     the disclosure the tool exists to make; trimming them would have bought
//     ~20 tokens by removing the only warning an agent ever reads.
//   - A6 (trace analysis) cost almost nothing: one enum value. The vitals are
//     also computed on `stop`, where the events are already in hand — free.
//   - B10 (audit log) and C13 (remote relay) cost ZERO: no schema at all. The
//     audit tail rides in `browser_status`'s TEXT, and `browser_status` still
//     takes no arguments.
// `network` and `state` are in neither `core` nor `slim`, so both stay exactly
// where they were — an agent on a cheaper profile pays nothing for this stage.
// What the spend buys: a recorded trace that answers "is this page slow?" instead
// of handing over a file, the real-user numbers to check that answer against, and
// proxy control, which is one of the two things this server can do that
// chrome-devtools-mcp cannot do at all.
// Measured after: full 9 993 / 45 · core 4 523 / 19 · slim 1 856 / 7
//
// RAISED 2026-08-30 for plan 02 (agent tab ownership) — NO new tool, and that is
// exactly why this raise is unusual: the whole spend is DESCRIPTION, on five tools
// whose wording is the only thing steering the agent away from the user's tabs.
//   - What it buys: `browser_navigate` now says it works in the agent's own tab
//     and never the user's; `browser_switch_tab` says in as many words that it
//     STEALS FOCUS; `browser_select_tab` names itself as the takeover path;
//     `browser_new_tab` says background, and its `active` flag reads as the
//     focus-stealing opt-in it is. The code enforces the rule, but an agent that
//     does not know the rule exists reaches for the focus-stealing tool by habit.
//   - Shortest-honest-wording FIRST, and it recovered 108 of the 157 the first
//     draft cost: navigate 3 sentences -> 2, new_tab's `active` describe 40 -> 25,
//     switch_tab and select_tab each lost a redundant clause. What was NOT cut:
//     "Never touches the tab the user is viewing" and "STEALS THE USER'S FOCUS".
//     Those two phrases ARE the fix, as far as the agent is concerned.
//   - Eight tools also lost the phrase "the active tab", which became a lie the
//     day the agent stopped driving the user's active tab. "the tab you are
//     driving" is ~2 tokens dearer each; an accurate description that costs 16
//     tokens beats a free one that sends the agent to the wrong tab.
// Headroom, not a ceiling raised to fit: `core` was passing with ONE token to
// spare, which is a gate that fails on any future rewording regardless of merit.
// Measured after: full 10 069 / 45 · core 4 559 / 19 · slim 1 894 / 7
//
// RAISED 2026-09-04 for plan 09 (second sweep of chrome-devtools-mcp), Task 1.
// `full` was at 10 088 / 45 with THIRTY-TWO tokens to spare — a gate that fails on
// any rewording regardless of merit. Stage 9 adds schema to six tools and exactly
// one new tool, so the ceiling is raised ONCE, here, before any feature work,
// rather than nudged six times as the stage lands.
//
// The projection is measured, not guessed — each fragment below was tokenised as
// the JSON it will actually serialise to (scratch script, o200k_base, same
// encoder as this file):
//     56   D1  `page` on browser_get_console_logs + browser_network_requests (28 x2)
//     22   D5  `incognito` on browser_new_tab
//     52   D6  `frames` + `intervalMs` on browser_screenshot (28 + 24)
//      6   D7  two `action` enum values on browser_perf_trace (3 each)
//     26   D8  `audit` on browser_issues
//     22   D15 `reveal` on browser_get_network_request
//    160   D4  browser_page_tools, the stage's ONE new tool (existing tools
//              measure 116-196; an action enum plus two optional params is mid-range)
//   ----
//    344   projected, plus an 88-token margin for wording that runs longer than
//          the sample fragments — which it usually does, and which is exactly how
//          a budget ends up being raised twice.
//
// NOT included, and each needs its own raise if it is ever approved: D9 add-on
// control (~160, held pending a user decision because it forces a permission
// re-prompt on every existing install). D21 invalid certificates was BUILT on
// 2026-09-10 and needed NO raise: one optional boolean on an existing tool cost
// +43 tokens (932 -> 975 on browser_advanced_mode), absorbed by the margin above.
// That leaves SIX tokens of headroom on `full` — the next description change,
// however small, should expect to raise this.
// `core` and `slim` are deliberately NOT raised — nothing in Stage 9 enters them.
// Measured before: full 10 088 / 45 · core 4 559 / 19 · slim 1 894 / 7
// RAISED 2026-09-16 for `core` and `slim`, and this one is a CORRECTION, not a
// new cost. Both had been over their ceilings since Stage 9 and nothing said so:
// D6 added `frames` + `intervalMs` to `browser_screenshot`, which is in all three
// profiles, at a measured 52 tokens — exactly `slim`'s overrun — while that stage
// raised `full` alone, reasoning that "nothing in Stage 9 enters them". It did.
// Found at Stage 10's acceptance (2026-09-15) by measuring the two profiles the
// gate never ran; the gate itself is fixed below, which is the half that matters.
//
// Measured 2026-09-16 against the accepted build: full 10 471 / 46 tools ·
// core 4 637 / 19 · slim 1 972 / 7 — `full` was 10 498 until deleting the dead
// `acceptInsecureCerts` argument the same day returned 27 tokens, which is what a
// single optional boolean costs. The two new ceilings each leave room for about
// one more optional argument (~27 tokens measured), so the next small rewording
// does not fail the gate on size rather than merit — the trap this file warns
// about above. `full` is deliberately NOT raised here: it has 49 to spare, and
// raising it buys context cost no one asked for, so the next description change
// should expect to raise it in the commit that needs it.
// LOWERED 2026-09-18 — the first time these numbers have ever moved DOWN, and the
// reason they can is a measurement nobody had taken: every Claude Code transcript
// on the author's machine (348 sessions, 89,258 model turns, 3,811 calls) costed
// by OCCUPANCY — a result's tokens times the turns it then sits in context for.
// The tool schemas came to 934,620,518 tokens, 80.1% of everything this server has
// ever cost, because the per-request budget this gate enforces had never been
// multiplied by the number of requests. 8,782 of those turns were in 36 sessions
// that never called a browser tool at all.
//
// Two cuts, neither of which removes a tool, a parameter, or a validation rule:
//   - `$schema` stripped at the wire (`wireSchema`, src/tools/tool.ts): 46 input
//     schemas and 9 output schemas carried "http://json-schema.org/draft-07/
//     schema#", a key the protocol never reads. 770 tokens.
//   - Three envelope descriptions said once instead of six times over —
//     `includeSnapshot` (29 tokens x 6 tools), `waitUntil`, `settleMs`. The prose
//     moved to the shipped skill's page-interaction reference, which is read once
//     per TASK rather than once per TURN. ~300 tokens.
//
//   full 10,471 -> 9,435 (-9.9%) · core 4,637 -> 4,145 (-10.6%) · slim 1,972 -> 1,826 (-7.4%)
//
// The cuts came to -1,066 / -522 / -176; 30 of each were then SPENT, deliberately,
// on one clause of `browser_screenshot`: reach for `ref` when you are checking one
// element. That is the other half of the same measurement — 445 real captures, a
// viewport picture averaging ~1,531 tokens that never leaves the context again, and
// only 20 of the 445 scoped to an element. 30 tokens per request to stop that is the
// best trade in this file.
//
// Ceilings are set ~1.5% above each measurement, the same slack they carried
// before, so the next addition still has to argue for itself. Everything above
// this line is the history of them going UP; leave it, it is the record of what
// each raise bought.
const BUDGETS = { full: 9580, core: 4210, slim: 1855 };

const CHARS_PER_TOKEN = 4;

/**
 * Measure ONE profile and report its verdict. Returns true when it is inside its
 * budget (or has none), false when it blew through.
 *
 * `detailed` prints the per-tool table. A run measuring every profile prints only
 * the verdict lines, because three full tables is 72 rows of noise in the middle
 * of `npm run check` and the number that matters is the total.
 */
function measure(profile, detailed) {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [entry, "--print-tools", profile], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`Failed to run ${entry} --print-tools ${profile}`);
    console.error(err.message ?? String(err));
    console.error("Did you run `npm run build` first?");
    process.exit(1);
  }

  const payload = stdout.trim();
  const tools = JSON.parse(payload);

  const rows = tools
    .map((tool) => {
      const json = JSON.stringify(tool);
      return {
        name: tool.name,
        chars: json.length,
        bytes: Buffer.byteLength(json, "utf8"),
        tokens: encode(json).length,
      };
    })
    .sort((a, b) => b.chars - a.chars);

  const totalChars = payload.length;
  const totalBytes = Buffer.byteLength(payload, "utf8");
  // Tokenize the whole payload rather than summing the rows — BPE merges across
  // boundaries, so the sum of the parts is not the cost of the whole.
  const totalTokens = encode(payload).length;

  if (detailed) {
    const nameWidth = Math.max(5, ...rows.map((r) => r.name.length));
    const col = (v, w) => String(v).padStart(w);
    const rule = "-".repeat(nameWidth + 32);

    console.log(`Tool schema cost — profile: ${profile} — ${tools.length} tools\n`);
    console.log(
      `${"tool".padEnd(nameWidth)}  ${col("chars", 8)}  ${col("bytes", 8)}  ${col("tokens", 9)}`,
    );
    console.log(rule);
    for (const r of rows) {
      console.log(
        `${r.name.padEnd(nameWidth)}  ${col(r.chars, 8)}  ${col(r.bytes, 8)}  ${col(r.tokens, 9)}`,
      );
    }
    console.log(rule);
    console.log(
      `${"TOTAL".padEnd(nameWidth)}  ${col(totalChars, 8)}  ${col(totalBytes, 8)}  ${col(totalTokens, 9)}`,
    );

    console.log(
      `\n${totalTokens.toLocaleString()} tokens (o200k_base) across ${tools.length} tools` +
        ` — every request pays this.` +
        `\nchars/${CHARS_PER_TOKEN} would have said ${Math.round(totalChars / CHARS_PER_TOKEN).toLocaleString()} (estimate).`,
    );
  }

  const budget = BUDGETS[profile];
  if (budget === undefined) {
    console.log(
      `\n${profile}: ${totalTokens.toLocaleString()} tokens across ${tools.length} tools` +
        ` — no budget set, reporting only.`,
    );
    return true;
  }
  if (totalTokens > budget) {
    console.error(
      `\nFAIL  "${profile}": ${totalTokens.toLocaleString()} tokens exceeds the ${budget.toLocaleString()} budget by ${(totalTokens - budget).toLocaleString()}.` +
        `\n      Trim a schema, or raise BUDGETS.${profile} in scripts/count-tokens.mjs and say why in the commit.`,
    );
    return false;
  }
  console.log(
    `\nOK  "${profile}": ${totalTokens.toLocaleString()} tokens, within the ${budget.toLocaleString()}-token budget (${(budget - totalTokens).toLocaleString()} to spare).`,
  );
  return true;
}

// WITH NO ARGUMENT, MEASURE EVERY BUDGETED PROFILE — not just `full`.
//
// It measured `full` alone until 2026-09-16, and `npm run check` passes no
// argument, so `core` and `slim` were never gated by anything. They were found
// 27 and 52 tokens over at Stage 10's acceptance, having been broken since
// Stage 9 put `frames` + `intervalMs` on `browser_screenshot` — a tool inside
// both of them — while raising `full`'s ceiling alone, on the explicit and
// wrong assumption that "nothing in Stage 9 enters them". Two weeks of green
// runs said nothing, because the gate only ever watched the profile it was
// written for. Deriving the list from BUDGETS means a fourth profile is gated
// the moment it has a ceiling, without anyone remembering to add it here.
const requested = process.argv[2];
const profiles = requested ? [requested] : Object.keys(BUDGETS);

let allPassed = true;
for (const p of profiles) {
  // Deliberately not short-circuited: one failing profile must not hide the
  // state of the others, or fixing them turns into one round trip each.
  if (!measure(p, profiles.length === 1)) allPassed = false;
}
if (!allPassed) process.exit(1);
