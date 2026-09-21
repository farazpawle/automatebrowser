/**
 * Agent eval harness (roadmap C24).
 *
 * B11 asks "does the code work". This asks the question no assertion in this
 * repo has ever asked: CAN A MODEL ACTUALLY GET THE JOB DONE with these tools,
 * given nothing but their descriptions? That is what tool descriptions, error
 * messages and response shapes decide, and C3, C4 and B6 are all bets on it
 * with no other way to be validated.
 *
 * It puts a real Claude in front of the real MCP server driving a real Chrome,
 * with no human in the loop, and scores it on the OUTCOME — usually by reading
 * the page itself afterwards, so the model's wording cannot fake a pass.
 *
 * COSTS MONEY on every run. Deliberately:
 *   - NOT part of `npm run check` and NOT in any CI workflow. A flaky, paid,
 *     model-dependent gate that blocks merges gets disabled within a week.
 *   - run by hand, before a release:  npm run eval
 *   - credentials come from the SDK's own resolution (ANTHROPIC_API_KEY,
 *     ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile). Never hardcode one.
 *   - `--dry-run` exercises everything except the model call, for free.
 *     `--only=<id>` runs one scenario. `--headed` shows the browser.
 *
 * Scenarios are DATA in `scripts/eval-scenarios.json`; results are written to
 * `evals/results.md`, so a regression in a tool DESCRIPTION
 * shows up as a diff in a pull request.
 */
import fs from "node:fs";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import {
  ROOT,
  init,
  launchOwnBrowser,
  makeController,
  requireFreshBuilds,
  startFixtureServer,
  text,
} from "./lib/browser-harness.mjs";

const MODEL = process.env.AUTOMATE_BROWSER_EVAL_MODEL || "claude-opus-5";
const HEADED = process.argv.includes("--headed");
const DRY_RUN = process.argv.includes("--dry-run");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice("--only=".length);
const SCENARIO_FILE = path.join(ROOT, "scripts", "eval-scenarios.json");
const RESULTS_FILE = path.join(ROOT, "evals", "results.md");

const SYSTEM = [
  "You are driving a real web browser through tools. A tab is already open on the page the task",
  "refers to — do not navigate away from it unless the task asks you to.",
  "Work it out from the tools' own descriptions; nobody will answer questions for you.",
  "When you are done, reply with the answer in plain text and stop calling tools.",
].join(" ");

/**
 * `--dry-run` swaps the model for a two-step stub: read the page, then answer
 * with what it read. It spends nothing, so the loop, the tool_result shaping,
 * the scorer and the report have a check that anyone can run — the paid path is
 * the only part it does not cover, and the paid path is the one that needs a key.
 * It is NOT an eval: it proves the harness, never the tool descriptions.
 */
function stubClient() {
  let step = 0;
  return {
    messages: {
      create: async ({ messages }) => {
        step++;
        if (step === 1) {
          return {
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "stub-1",
                name: "browser_read_page",
                input: { format: "text" },
              },
            ],
          };
        }
        const last = messages[messages.length - 1];
        const seen = Array.isArray(last.content)
          ? last.content.map((b) => b.content ?? "").join(" ")
          : String(last.content);
        return { stop_reason: "end_turn", content: [{ type: "text", text: seen }] };
      },
    },
  };
}

// ── the agent loop ──────────────────────────────────────────────────────────
/**
 * Run one scenario to completion. Returns the final text, the number of tool
 * calls it took, and why it stopped. The tool-call count is scored too (7.6):
 * a change that doubles the round-trips to the same answer is a regression even
 * when the answer is still right.
 */
async function runScenario(client, controller, tools, scenario) {
  const messages = [{ role: "user", content: scenario.task }];
  let toolCalls = 0;
  let turns = 0;

  for (;;) {
    if (turns >= (scenario.maxTurns ?? 12)) {
      return { answer: "", toolCalls, stop: "max_turns" };
    }
    turns++;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools,
      messages,
    });

    if (response.stop_reason === "refusal") {
      return { answer: "", toolCalls, stop: "refusal" };
    }

    messages.push({ role: "assistant", content: response.content });
    const calls = response.content.filter((b) => b.type === "tool_use");

    if (!calls.length) {
      const answer = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { answer, toolCalls, stop: response.stop_reason };
    }

    // Every tool_result for one assistant turn goes back in ONE user message —
    // splitting them teaches the model to stop calling tools in parallel.
    const results = [];
    for (const call of calls) {
      toolCalls++;
      const r = await controller.call(call.name, call.input);
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: text(r) || "(no content)",
        is_error: !!(r?.error || r?.result?.isError),
      });
    }
    messages.push({ role: "user", content: results });
  }
}

// ── scoring: on the outcome, never on the wording ───────────────────────────
async function score(controller, scenario, run) {
  const failures = [];
  const a = scenario.assert ?? {};
  const answer = run.answer.toLowerCase();

  if (run.stop === "max_turns") failures.push("hit the turn limit without finishing");
  if (run.stop === "refusal") failures.push("the model declined the task");

  for (const needle of a.answerContains ?? []) {
    if (!answer.includes(needle.toLowerCase())) failures.push(`answer is missing "${needle}"`);
  }
  if (a.answerContainsAny?.length) {
    const hit = a.answerContainsAny.some((n) => answer.includes(n.toLowerCase()));
    if (!hit) failures.push(`answer names none of: ${a.answerContainsAny.join(", ")}`);
  }

  // The strongest assertions: read the page ourselves rather than believe the
  // transcript. A model that says it logged in cannot pass these by saying so.
  if (a.pageContains?.length || a.pageMissing?.length) {
    const page = text(await controller.call("browser_read_page", { format: "text" })).toLowerCase();
    for (const needle of a.pageContains ?? []) {
      if (!page.includes(needle.toLowerCase())) failures.push(`the page never showed "${needle}"`);
    }
    for (const needle of a.pageMissing ?? []) {
      if (page.includes(needle.toLowerCase())) failures.push(`the page still shows "${needle}"`);
    }
  }

  return failures;
}

// ── report ──────────────────────────────────────────────────────────────────
/**
 * Written WITHOUT a timestamp or any per-run id. The file is tracked so that a
 * regression shows up as a diff; a clock in it would make every run a diff and
 * the signal would be lost in the noise.
 */
function writeResults(results) {
  const lines = [
    "---",
    "Title: Agent Eval Results",
    "Description: >",
    "  Scored output of `npm run eval` (roadmap C24) — a real model driving the real tools",
    "  against the local fixture, with no human in the loop. Tracked on purpose: this file is",
    "  a diff, so a regression in a tool DESCRIPTION or an error message shows up in review",
    "  even though nothing in src/ changed. Deliberately carries no timestamp — a clock would",
    "  make every run a diff and drown the signal. Re-generate with `npm run eval`.",
    "---",
    "",
    "# Agent eval results",
    "",
    `Model: \`${MODEL}\``,
    "",
    "| Scenario | Result | Tool calls | Stopped because | What it probes |",
    "|---|---|---|---|---|",
  ];
  for (const r of results) {
    lines.push(
      `| \`${r.id}\` | ${r.failures.length ? "❌ FAIL" : "✅ pass"} | ${r.toolCalls} | ${r.stop} | ${r.probes} |`,
    );
  }
  const failed = results.filter((r) => r.failures.length);
  if (failed.length) {
    lines.push("", "## Failures", "");
    for (const r of failed) {
      lines.push(`### \`${r.id}\``, "");
      for (const f of r.failures) lines.push(`- ${f}`);
      lines.push("", "Final answer:", "", "```", r.answer || "(none)", "```", "");
    }
  }
  lines.push("");
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.writeFileSync(RESULTS_FILE, lines.join("\n"));
}

// ── main ────────────────────────────────────────────────────────────────────
let server;
let browser;
let controller;

async function main() {
  requireFreshBuilds();

  const config = JSON.parse(fs.readFileSync(SCENARIO_FILE, "utf8"));
  const scenarios = config.scenarios.filter((s) => !ONLY || s.id === ONLY);
  if (!scenarios.length) {
    console.error(`No scenario matched --only=${ONLY}`);
    process.exit(1);
  }

  server = await startFixtureServer();
  const base = "http://127.0.0.1:" + server.address().port;
  console.log(`model: ${MODEL}   fixtures: ${base}   scenarios: ${scenarios.length}`);

  controller = makeController({ AUTOMATE_BROWSER_CLIENT_NAME: "EvalHarness" });
  await init(controller, "eval");

  const launched = await launchOwnBrowser(controller, { headed: HEADED });
  browser = launched.browser;
  if (!launched.clientId) {
    console.error("The built extension never connected as a NEW browser — refusing to continue.");
    process.exit(1);
  }
  await controller.call("browser_select_client", { id: launched.clientId });

  // The model gets the SAME schemas a real MCP client would — that is the whole
  // point. Rewriting them here would test a tool surface nobody ships.
  const listed = await controller.rpc("tools/list", {});
  const tools = (listed?.result?.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
  console.log(`tools offered to the model: ${tools.length}`);

  // Zero-arg on purpose: the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
  // or an `ant auth login` profile. Demanding the env var specifically would
  // refuse to run for someone who is perfectly well authenticated.
  const real = DRY_RUN ? null : new Anthropic();
  const results = [];
  for (const scenario of scenarios) {
    await controller.call("browser_navigate", { url: base + scenario.url, includeSnapshot: false });
    // A fresh stub per scenario — one shared counter would silently skip the
    // tool step on every scenario after the first.
    const client = DRY_RUN ? stubClient() : real;
    const run = await runScenario(client, controller, tools, scenario);
    const failures = await score(controller, scenario, run);
    results.push({ ...scenario, ...run, failures });
    console.log(
      `${failures.length ? "FAIL" : "pass"}  ${scenario.id}  (${run.toolCalls} tool calls, ${run.stop})` +
        (failures.length ? "\n      " + failures.join("\n      ") : ""),
    );
  }

  // A dry run must never overwrite the tracked results: it would replace a real
  // scored eval with a stub's output and the diff would lie.
  if (DRY_RUN) {
    console.log(
      "\n--dry-run: harness exercised, results file left untouched (no model was called)",
    );
    return 0;
  }
  writeResults(results);
  console.log(`\nwrote ${path.relative(ROOT, RESULTS_FILE)}`);
  return results.filter((r) => r.failures.length).length;
}

main()
  .then(async (failed) => {
    try {
      await browser?.close();
    } catch {}
    controller?.kill();
    server?.close();
    process.exit(failed ? 1 : 0);
  })
  .catch(async (e) => {
    if (
      e instanceof Anthropic.AuthenticationError ||
      /api.?key|credential/i.test(e?.message ?? "")
    ) {
      console.error(
        "No usable Anthropic credentials. This harness calls a real model and costs money per run;\n" +
          "it is run by hand before a release, never in CI. Either `ant auth login`, or export\n" +
          "ANTHROPIC_API_KEY, then try again.",
      );
    } else {
      console.error("HARNESS_ERROR", e);
    }
    try {
      await browser?.close();
    } catch {}
    controller?.kill();
    server?.close();
    process.exit(1);
  });
