import { countErrors, type Context } from "@/context";
import { captureAriaSnapshot } from "@/utils/aria-snapshot";
import type { Tool, ToolOutcome, ToolResult } from "@/tools/tool";
import { ToolError, isLostResponse, isRefusal, isRetryable } from "@/tools/errors";
import { DEFAULT_PAGE_SIZE } from "@/tools/network";
import { categoryOf } from "@/tools/registry";
import { auditRecord } from "@/utils/audit";
import { log } from "@/utils/log";
import { denyDomains, evalRefusal, judge, policy, readOnlyRefusal } from "@/utils/origins";
import { assertPathAllowed } from "@/utils/paths";

/**
 * Backoff before the single retry. Long enough for a worker to come back.
 *
 * WHAT counts as retryable is not decided here: it lives with the taxonomy in
 * `errors.ts`, so `ToolError.retryable` and the auto-retry can never disagree.
 * Two lists would drift, and the drift would only show up as a retry firing when
 * it should not have — or not firing when it should.
 */
const RETRY_BACKOFF_MS = 300;

/**
 * C3b: the sections `include` can ask for. Handled HERE, at the one choke point,
 * for the same reason the C3a footer is: it needs the console/network delta
 * bookkeeping, and doing it per-tool would mean N copies of it, N probes per
 * call, and N chances for the attached payload and the footer to disagree about
 * what "new" means.
 */
const INCLUDABLE = ["snapshot", "console", "network"] as const;

function askedFor(args?: Record<string, unknown>): Set<string> {
  const raw = args?.include;
  // A comma-separated STRING, not an enum array: the array shape cost ~34 tokens
  // per tool against ~24, and this param is paid on every request forever. The
  // names are validated here instead, so a typo is still refused rather than
  // silently attaching nothing.
  const parts = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [])
    .map((v: string) => String(v).trim().toLowerCase())
    .filter(Boolean);
  const unknown = parts.filter((v) => !(INCLUDABLE as readonly string[]).includes(v));
  if (unknown.length > 0) {
    throw new Error(
      `Cannot include ${unknown.join(", ")} — known sections are ${INCLUDABLE.join(", ")}.`,
    );
  }
  return new Set(parts);
}

/**
 * The origin probe is a diagnostic round-trip, like the console-delta footer —
 * it must never cost more than the action it is guarding.
 */
const ORIGIN_PROBE_MS = 2_000;

/**
 * Categories exempt from the B9 gates. These tools pick WHICH browser and WHICH
 * tab; they never act on a page. Gating them would strand an agent exactly the
 * way `ALWAYS_ON` in the registry exists to prevent — with a policy set it could
 * not even select a browser, let alone call `browser_status` to learn why.
 *
 * Derived from the registry's own grouping rather than a second hand-kept list,
 * for the same reason `readOnlyHint` is reused below instead of re-listing the
 * mutating tools: two lists drift, and the drift is invisible until it matters.
 */
const UNGATED_CATEGORIES = new Set(["clients", "tabs"]);

/**
 * Which policy each browser has confirmed installing, keyed by its RELAY id.
 *
 * B05 — this was one process-wide boolean, so the first browser to be driven
 * latched it and every browser selected afterwards got no rules at all. The tool
 * gate still refused those calls, but `browser_eval` on an allowed page could
 * `fetch()` a denied origin from browser B all day.
 *
 * Keyed by the CONNECTION and not by the extension's stable `instanceId`, which
 * would have been the obvious "browser identity": dynamic rules outlive a
 * service-worker eviction, but nothing the server can see proves they did, and a
 * reconnect is precisely the moment installed state becomes unknowable. A new
 * relay id therefore drops the acknowledgement and the next protected call
 * reinstalls — one 2 s round-trip per reconnect to replace a guess.
 *
 * The VALUE is the policy the browser confirmed, so changing the deny-list
 * mid-session reinstalls rather than riding on an acknowledgement of the old one.
 */
const netPolicyAck = new Map<string, string>();

/**
 * B9's network half: the deny-list also becomes `declarativeNetRequest` block
 * rules, because tool-level gating alone leaves `browser_eval` free to `fetch()`
 * a denied origin from an allowed page.
 *
 * Best-effort and never fatal: an extension that predates the permission cannot
 * install the rules, and refusing every call in that case would brick a server
 * whose tool-level gate is working perfectly. The failure is logged and retried
 * on the next call rather than latched.
 */
async function pushNetPolicy(context: Context, deny: string[]): Promise<void> {
  if (deny.length === 0) return;
  const domains = denyDomains(deny);
  if (domains.length === 0) return;
  // Resolved BEFORE the send and then pinned to it, so the acknowledgement is
  // recorded against the browser that actually answered. Reading the target
  // afterwards would let a concurrent `browser_select_client` file browser B's
  // confirmation under browser A — the same class of bug one rung down.
  const id = context.activeBrowserId();
  if (!id) return; // Nothing connected, or several and none chosen: no target to install on.
  // Order-independent, so the same policy spelled in a different order is not a
  // different policy — a needless reinstall on every single call.
  const fingerprint = [...domains].sort().join(",");
  if (netPolicyAck.get(id) === fingerprint) return;
  try {
    const answer = (await context.sendSocketMessage(
      "browser_net_policy",
      { deny: domains, owner: context.ctrlId() ?? context.clientName() },
      { noClaim: true, browserId: id, timeoutMs: ORIGIN_PROBE_MS },
    )) as { mine?: number } | undefined;
    // `mine` is what the extension installed FOR US, as opposed to the union it
    // now holds for every agent sharing this browser. Fewer than we asked for
    // means the rules are not all there, so nothing is acknowledged and the next
    // call tries again. An older extension reports no `mine` at all; that is the
    // documented capability limit, not a failure, so its answer still counts.
    if (typeof answer?.mine === "number" && answer.mine < domains.length) {
      throw new Error(`extension installed ${answer.mine} of ${domains.length} deny rules`);
    }
    // Browsers that have since left cannot be re-acknowledged under the same id
    // (relay ids are never reused), so their entries are pure growth.
    const live = new Set(context.listClients().map((c) => c.id));
    for (const key of netPolicyAck.keys()) if (!live.has(key)) netPolicyAck.delete(key);
    netPolicyAck.set(id, fingerprint);
  } catch (e) {
    // Never latch a failure: an install that did not happen must not read as one
    // that did, on this browser or on any other.
    netPolicyAck.delete(id);
    log.debug(`[call] net policy not installed (tool gate still applies): ${String(e)}`);
  }
}

/**
 * B02 — the ONE argument, per tool, that may stand in for where the tool acts.
 *
 * A closed list and not a `url` lookup, because "it carries a url" and "it will
 * act on that url" are different claims. The hole this closes: the gate read
 * `args.url` off the RAW request for every tool, so
 * `browser_click { element, ref, url: "https://allowed.test" }` was judged on the
 * allowed address and then clicked the denied page — the click's own parser
 * discards the extra field, but only after the gate has already believed it.
 *
 * Three kinds of `url` argument exist in the registry and only the first belongs
 * here:
 *   - a DESTINATION, which is where the call will act (`browser_navigate`), or an
 *     off-page resource that IS the subject of the call (`browser_perf_field_data`
 *     queries the CrUX API about an address; it drives no page at all);
 *   - a FILTER — `browser_get_network_request { url }` is a substring matched
 *     against already-captured requests, and `browser_select_tab { url }` a
 *     substring matched against open tabs. Neither is a place the tool goes;
 *   - a field the tool does not declare at all, which is the attack above.
 *
 * Filters and unknown fields fall through to the origin probe, so the call is
 * judged on the tab it genuinely drives. `browser_select_tab`/`browser_new_tab`
 * never reach here — `UNGATED_CATEGORIES` exempts tab management, unchanged.
 */
const TARGET_URL_ARG: Readonly<Record<string, string>> = {
  browser_navigate: "url",
  browser_perf_field_data: "url",
};

/**
 * The destination this call declared, or `undefined` — which always means "ask
 * the browser where this is pointed", never "allow".
 *
 * Validated rather than merely read: a non-string, an empty string, or a value on
 * a tool that declares no destination cannot nominate the origin it is judged
 * against. Nothing here decides whether the URL is *usable* — `browser_navigate`
 * still applies its own scheme check — only whether it is the thing to judge.
 */
function declaredTarget(tool: Tool, args?: Record<string, unknown>): string | undefined {
  const field = TARGET_URL_ARG[tool.schema.name];
  if (!field) return undefined;
  const raw = args?.[field];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Where the gate looked, so dispatch can prove it is still aimed there.
 *
 * `undefined` means nothing was probed — no policy, or a declared destination
 * that needed no probe — and there is correspondingly nothing to re-check.
 */
type ProbedTarget = { browser?: string; tabId?: number } | undefined;

/**
 * B02's second half: a probe is only worth anything if the action lands on the
 * tab that was probed.
 *
 * The gate reads the page over the wire, and the handler dispatches afterwards;
 * between the two, a concurrent call on this same controller can select another
 * browser. Comparing the drive target before and after turns that from a silent
 * mismatch — judged one tab, drove another — into a refusal.
 *
 * A target the gate did not know yet is not a mismatch: the probe's own claiming
 * send is what provisions this controller's tab, so `undefined → 4` is the normal
 * first call, and only a CHANGE to a target the gate actually saw is refused.
 */
function assertSameTarget(context: Context, tool: Tool, probed: ProbedTarget): void {
  if (!probed) return;
  const now = context.auditTarget();
  const moved =
    (probed.browser !== undefined && now.browser !== probed.browser) ||
    (probed.tabId !== undefined && now.tabId !== probed.tabId);
  if (!moved) return;
  throw new ToolError(
    "ORIGIN_BLOCKED",
    `${tool.schema.name} refused — the target moved between the safety check and the action ` +
      `(checked ${probed.browser ?? "?"} tab ${probed.tabId ?? "?"}, now ${now.browser ?? "?"} ` +
      `tab ${now.tabId ?? "?"}). Nothing was sent; retry the call.`,
    { recover: "browser_status" },
  );
}

/**
 * Refuse the call outright when the operator's policy says so (B9).
 *
 * WHERE the tool will act: its declared destination when it has one (so a
 * navigation is judged on its destination, not on the page it is leaving),
 * otherwise the tab it is already on — read with the same tab resolution the
 * drive itself uses, or the check would judge a different tab than the one that
 * gets driven. `TARGET_URL_ARG` decides which tools have a destination at all;
 * an arbitrary `url` in the raw request is not one (B02).
 *
 * Returns the target the probe was taken against, for `assertSameTarget`.
 */
async function assertPolicyAllows(
  context: Context,
  tool: Tool,
  args?: Record<string, unknown>,
): Promise<ProbedTarget> {
  const p = policy();
  if (!p) return; // Nothing configured — not one extra byte crosses the wire.
  if (UNGATED_CATEGORIES.has(categoryOf(tool.schema.name) ?? "")) return;

  // D16 — the middle setting between full trust and read-only: drive and read a
  // real logged-in session, but never run code the operator did not write. Judged
  // FIRST, before the origin probe below, because the answer does not depend on
  // where the tab is; paying a 2 s round-trip to arrive at the same refusal would
  // be pure latency.
  if (p.noEval) {
    const why = evalRefusal(tool.schema.name, args);
    if (why) {
      throw new ToolError("EVAL_BLOCKED", `${tool.schema.name} refused — ${why}`, {
        recover: "browser_status",
      });
    }
  }

  const mutating = tool.schema.annotations?.readOnlyHint !== true;

  // B03 — read-only is a fact about the TOOL, not about where the tab is, so it
  // is settled here: before the probe, and before the two shortcuts below that
  // skip the probe and everything after it. The rule used to live only inside
  // `judge`, at the bottom of this function, and neither shortcut ever reached
  // it — so a mutating call went through in read-only mode whenever no browser
  // had connected yet, or the probe threw with only a deny-list configured.
  const readOnly = readOnlyRefusal(p, mutating);
  if (readOnly) {
    throw new ToolError("READ_ONLY", `${tool.schema.name} refused — ${readOnly}`, {
      recover: "browser_status",
    });
  }

  let url: string | undefined = declaredTarget(tool, args);
  let probed: ProbedTarget;
  if (!url && (p.allow.length > 0 || p.deny.length > 0 || p.sensitive.length > 0)) {
    if (!context.hasClients()) return undefined; // No browser to judge; nothing can happen yet.
    try {
      url = (await context.sendSocketMessage(
        "getUrl",
        {},
        {
          timeoutMs: ORIGIN_PROBE_MS,
        },
      )) as string;
      // Taken AFTER the probe, not before: the probe's own claiming send is what
      // provisions this controller's tab, so this is the first moment the answer
      // means "the tab that was read".
      probed = context.auditTarget();
    } catch (e) {
      // A probe that FAILED must not read as "allowed". With an allow-list set,
      // an unknown location is a refusal; with only a deny-list, it is not.
      log.debug(`[call] origin probe failed: ${String(e)}`);
      if (p.allow.length === 0) return undefined;
      throw new ToolError(
        "ORIGIN_BLOCKED",
        `could not read the target tab's URL to check it against ${"AUTOMATE_BROWSER_ALLOW_ORIGINS"}; refusing rather than guessing.`,
        { recover: "browser_status" },
      );
    }
  }

  const verdict = judge(p, url, mutating);
  if (!verdict.ok) {
    throw new ToolError(
      verdict.message.includes("read-only mode") ? "READ_ONLY" : "ORIGIN_BLOCKED",
      `${tool.schema.name} refused — ${verdict.message}`,
      { recover: "browser_status" },
    );
  }

  await pushNetPolicy(context, p.deny);
  return probed;
}

/**
 * The single choke point through which a tool is invoked. Both entry points go
 * through it — the MCP `tools/call` handler and the `automate-browser` CLI — so
 * the path sandbox and the console-delta footer cannot apply to one and silently
 * skip the other.
 *
 * Throws on failure; each caller shapes the error its own way (MCP returns an
 * `isError` result, the CLI prints to stderr and exits 1).
 *
 * B10's audit line is written HERE, wrapping everything, so a call refused by
 * the path sandbox or the origin policy is recorded as a refusal rather than
 * vanishing — "it tried and was stopped" is exactly the entry a user reading
 * this trail is looking for.
 */
export async function callTool(
  context: Context,
  tool: Tool,
  args?: Record<string, unknown>,
): Promise<ToolResult> {
  const startedAt = Date.now();
  // Captured BEFORE the call: a tool that closes a tab or switches browsers
  // would otherwise be audited against the target it left behind.
  const target = context.auditTarget();
  // Starts as a refusal because that is what a failure IS until dispatch is
  // attempted, and `runTool` moves it on from there. Classified where the
  // knowledge is — whether anything was sent, and whether this tool is safe to
  // repeat — rather than re-derived from a message string up here.
  const state: CallState = { outcome: "refused" };
  try {
    const result = await runTool(context, tool, args, state);
    auditRecord({
      tool: tool.schema.name,
      args,
      agent: context.clientName(),
      ctrl: context.ctrlId(),
      ...target,
      // A tool that RETURNS a failure used to be logged as a success, so the one
      // record of what the agent did in the user's browser disagreed with what
      // the agent was told. The returned flag decides it, not the fact that no
      // exception came out.
      ok: result.isError !== true,
      outcome: state.outcome,
      ms: Date.now() - startedAt,
    });
    return result;
  } catch (e) {
    auditRecord({
      tool: tool.schema.name,
      args,
      agent: context.clientName(),
      ctrl: context.ctrlId(),
      ...target,
      ok: false,
      outcome: state.outcome,
      ms: Date.now() - startedAt,
      error: String((e as Error)?.message ?? e),
    });
    throw e;
  }
}

/**
 * What `runTool` learned while it ran, for the audit line `callTool` writes.
 * A policy refusal and a click whose reply vanished are both "an error" to the
 * caller; the trail a user reads after something looks wrong has to tell them
 * apart, and only the code that ran the call knows which it was.
 */
type CallState = { outcome: ToolOutcome };

async function runTool(
  context: Context,
  tool: Tool,
  args: Record<string, unknown> | undefined,
  state: CallState,
): Promise<ToolResult> {
  // Sandbox every declared path param before the tool can act on it, and write
  // the resolved path back so the tool cannot use a different string than the
  // one that was checked.
  if (args) {
    for (const { param, mode } of tool.pathParams ?? []) {
      const value = args[param];
      if (value === undefined || value === null) continue;
      args[param] = Array.isArray(value)
        ? value.map((p) => assertPathAllowed(p, mode))
        : assertPathAllowed(value, mode);
    }
  }

  const probed = await assertPolicyAllows(context, tool, args);
  // Checked once, here, and not inside the retry loop below: a retry that follows
  // a reconnect legitimately sees a new relay id for the SAME browser, and B01
  // already pins that retry to the same instance. Re-checking it here would
  // refuse exactly the recovery B01 built.
  assertSameTarget(context, tool, probed);

  // B04 — parsed HERE, before the handler runs, and reused after it.
  //
  // It used to be parsed only at the point of attachment, which is after the
  // dispatch: `include: "consoel"` clicked the button and then returned
  // "Cannot include consoel". The agent reads an error, concludes nothing
  // happened, and retries — so a typo in an OUTPUT option quietly became a
  // double click. Validating an option that costs nothing to check is worth
  // doing before an action that cannot be taken back.
  const include = askedFor(args);

  // Everything above this line refuses without asking the browser for anything.
  // Past it, a failure has to prove it changed nothing.
  state.outcome = "failed";

  // Not safe to re-issue: it changes the page AND does not declare itself
  // idempotent. The same two hints the auto-retry below reads — a third list of
  // "things you must not repeat" would drift from the one that governs the
  // retry, and the drift would only surface as a double click.
  const unsafeToReplay =
    tool.schema.annotations?.readOnlyHint !== true &&
    tool.schema.annotations?.idempotentHint !== true;

  let result: ToolResult;
  let retried = false;
  for (let attempt = 0; ; attempt++) {
    try {
      result = await tool.handle(context, args);
      break;
    } catch (e) {
      // One auto-retry for the transient class (B4), and ONLY for a tool that
      // declares itself idempotent. The relay already reconnects on its own;
      // without this the mechanical recovery is pushed onto the model, mid-task,
      // at full context cost. Never retry a click, a form fill or a force-claim —
      // "it probably didn't happen" is not good enough for a side effect.
      //
      // This does not overlap the `no_browser` retry in `context.ts`: that one is
      // a PRE-dispatch refusal, safe for every tool, and it fires before a
      // handler ever sees an error.
      if (attempt === 0 && tool.schema.annotations?.idempotentHint === true && isRetryable(e)) {
        log.debug(
          `[call] ${tool.schema.name}: transient failure (${String(
            (e as Error)?.message ?? e,
          )}) — retrying once in ${RETRY_BACKOFF_MS}ms`,
        );
        retried = true;
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }

      // A refusal raised by the handler itself — bad arguments, a policy code —
      // still never reached the browser, whatever side of `handle` it came from.
      if (isRefusal(e)) {
        state.outcome = "refused";
        throw e;
      }

      // The REQUEST went out and the REPLY did not come back. For a read that is
      // just a failure; for a click it is the one outcome `isError` cannot say —
      // it may already have happened. The relay's own message ends "usually
      // transient — retry in a moment", and `context.ts` marks it retryable,
      // which for a side effect is advice to do it twice. Both are corrected
      // here, where the tool's own annotations are in hand.
      if (unsafeToReplay && isLostResponse(String((e as Error)?.message ?? e))) {
        state.outcome = "unknown";
        throw new ToolError(
          "NO_BROWSER",
          `${(e as Error)?.message ?? e} The request for ${tool.schema.name} had already been ` +
            `sent when the link dropped, so it MAY have taken effect. Check the page before ` +
            `repeating it — re-issuing it blind would act twice.`,
          { recover: "browser_snapshot" },
        );
      }

      // A page-acting tool that timed out has one overwhelmingly likely cause the
      // bare message never mentions: a JS modal is up, so the renderer is paused
      // and nothing injected into it can run or reply. Naming it turns a dead end
      // into a next step. Only the message is enriched — the failure still fails.
      if (tool.blockedByDialog && /timeout/i.test(String((e as Error)?.message))) {
        throw new Error(
          `${(e as Error).message}. If the page has an open alert/confirm/prompt or a ` +
            `"Leave site?" dialog, it is paused and cannot run this action. Clear it with ` +
            `browser_navigate {reload:true}, or — with browser_advanced_mode on — ` +
            `browser_handle_dialog {action:"dismiss"}, then retry.`,
          { cause: e },
        );
      }
      throw e;
    }
  }

  // What the tool itself says it achieved. Read BEFORE the optional attachments
  // below, which can only ever add a footnote: a snapshot that failed after a
  // click must not downgrade the click, and the console-delta warning reports
  // what the PAGE did, not whether the action landed.
  state.outcome = result.outcome ?? (result.isError === true ? "failed" : "success");

  // B7: a lost lease is surfaced on the NEXT result of ANY tool, not just the
  // one tool that used to consume it (`browser_list_clients`) and not only after
  // a wasted, refused drive. It is a NOTICE, not an error — this call succeeded.
  const notice = context.takeNotice();
  if (notice) {
    result.content.push({ type: "text", text: `⚠ ${notice}` });
  }

  // Say that it happened. An agent told nothing cannot report a flaky page, and
  // a silent retry turns intermittent breakage into "sometimes it's just slow".
  if (retried) {
    result.content.push({
      type: "text",
      text: "ⓘ The first attempt hit a transient connection failure; this succeeded on an automatic retry.",
    });
  }

  // C3b: attach what was asked for, in the SAME reply. Each section is its own
  // labelled block so an agent can find one without parsing prose, and each is
  // best-effort: a snapshot that fails afterwards is a footnote on a click that
  // worked, never a failure of the click.
  let freshConsole: Array<Record<string, unknown>> | undefined;
  if (include.size > 0) {
    if (include.has("snapshot")) {
      try {
        const snap = await captureAriaSnapshot(context);
        result.content.push({ type: "text", text: "--- snapshot ---" }, ...snap.content);
      } catch (e) {
        result.content.push({
          type: "text",
          text: `--- snapshot --- (unavailable: ${String((e as Error)?.message ?? e)})`,
        });
      }
    }
    if (include.has("console")) {
      // B04: guarded like the other two. This one was not, so a console read
      // that failed AFTER a successful click turned the click into an error —
      // reporting an action that demonstrably happened as one that did not.
      try {
        freshConsole = await context.takeNewConsole();
        result.content.push({
          type: "text",
          text:
            `--- console (${freshConsole.length} new) ---` +
            (freshConsole.length
              ? "\n" +
                freshConsole
                  .map((e) => `[${String(e.level ?? "log")}] ${String(e.text ?? "")}`)
                  .join("\n")
              : ""),
        });
      } catch (e) {
        result.content.push({
          type: "text",
          text: `--- console --- (unavailable: ${String((e as Error)?.message ?? e)})`,
        });
      }
    }
    if (include.has("network")) {
      try {
        // Same page size the tool itself serves. Left empty, the extension
        // applies its own default of 100 and this incidental block would be
        // twice what browser_network_requests documents.
        const net = (await context.sendSocketMessage("browser_network_requests", {
          limit: DEFAULT_PAGE_SIZE,
        })) as { requests?: Array<Record<string, unknown>> };
        const reqs = net?.requests ?? [];
        result.content.push({
          type: "text",
          text:
            `--- network (${reqs.length}) ---` +
            (reqs.length
              ? "\n" +
                reqs
                  .map(
                    (q) =>
                      `${String(q.status ?? q.error ?? "—")} ${String(q.method ?? "")} ${String(q.url ?? "")}`,
                  )
                  .join("\n")
              : ""),
        });
      } catch (e) {
        result.content.push({
          type: "text",
          text: `--- network --- (unavailable: ${String((e as Error)?.message ?? e)})`,
        });
      }
    }
  }

  // Console-delta footer: after a page-mutating action, tell the caller that the
  // page threw. Read-only tools never get it (nothing changed), and the probe
  // returns 0 on any failure, so this can only ever ADD a line.
  // `hasClients()` short-circuit: with no browser connected the two probes can
  // only ever return 0, and each still burns its 2 s cap first. That matters now
  // that a mutating tool can legitimately run with no browser at all
  // (`browser_perf_trace {action:"analyze"}` reads a file).
  if (
    tool.schema.annotations?.readOnlyHint !== true &&
    !tool.skipConsoleDelta &&
    context.hasClients()
  ) {
    // Reuse the batch `include` already fetched rather than probing twice — the
    // mark has advanced, so a second probe would report zero and contradict it.
    const errors = freshConsole ? countErrors(freshConsole) : await context.consoleErrorDelta();
    if (errors > 0) {
      result.content.push({
        type: "text",
        text:
          `⚠ ${errors} new console error${errors === 1 ? "" : "s"} since this action ` +
          `— call browser_get_console_logs for details.`,
      });
    }
    // Reported as its own line, not merged into the count above: these are the
    // failures that leave NO console error, so calling them "console errors"
    // would point the agent at the one tool that cannot show them.
    const issues = await context.issuesDelta();
    if (issues > 0) {
      result.content.push({
        type: "text",
        text:
          `⚠ ${issues} new browser issue${issues === 1 ? "" : "s"} since this action ` +
          `(blocked content or failed requests) — call browser_issues for details.`,
      });
    }
  }

  return result;
}
