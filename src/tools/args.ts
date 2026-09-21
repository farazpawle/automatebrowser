import { z } from "zod";

import { mcpConfig } from "@repo/config/mcp.config";

/**
 * Shared tool arguments — params several tools mix into their own schema.
 */

/**
 * Per-call timeout (roadmap C17). Mixed into the tools that can actually block:
 * the navigating ones (page load) and the interacting ones (element wait +
 * post-action settle). Without it an agent waits out the server default on every
 * call and can never say "give up after 500ms".
 *
 * Deliberately NOT on `browser_wait` — that is a sleep, so a deadline on it is
 * meaningless — nor on `browser_wait_for`, whose existing `timeoutMs` already IS
 * the condition deadline; a second knob there would only be ambiguous.
 */
export const timeoutArg = {
  timeout: z
    .number()
    .int()
    .nonnegative()
    .max(120_000)
    .optional()
    .describe("Give up after this many ms; 0 = server default."),
};

/**
 * Opt-out for the actionability gate and the post-action DOM settle (B3):
 * `AUTOMATE_BROWSER_ACTIONABILITY=off`.
 *
 * Deliberately an env var and NOT a tool param. A per-call param would cost ~30
 * schema tokens on EVERY interacting tool, on every request, forever — roughly
 * 150 against the 47 of `full` budget currently spare — and this is a safety
 * default a human turns off once for an awkward page, not a choice an agent
 * should be making per click.
 */
export function actionabilityEnabled(): boolean {
  const v = (process.env.AUTOMATE_BROWSER_ACTIONABILITY ?? "").toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

/**
 * The deadline for one send: the caller's `timeout` when they gave a usable one,
 * else the tool's own default. `0` means "server default" per the param's
 * contract, which is why this tests `> 0` rather than `!= null`.
 */
export function callTimeout(
  params: Record<string, unknown> | undefined,
  fallback: number = mcpConfig.timeouts.default,
): number {
  const t = params?.timeout;
  return typeof t === "number" && t > 0 ? t : fallback;
}

/**
 * C3b — ask for the fresh state in the SAME reply instead of spending two or
 * three more round-trips on it. Attached by `callTool`, so a tool only has to
 * carry the param.
 *
 * NARROWED, and here is what was dropped and why. On all twelve interacting
 * tools this is the most expensive shape in the roadmap (C17's `timeout` cost
 * ~31 tokens x 12). It is mixed into the THREE tools where "what happened after
 * that?" is the actual question an agent asks — click, type and navigate — and
 * left off hover, drag, select_option, scroll, key presses and the rest, where
 * the answer is almost always "nothing worth a payload". Any of those can still
 * be followed by an explicit browser_snapshot / browser_get_console_logs /
 * browser_network_requests, exactly as today.
 */
export const includeArg = {
  include: z
    .string()
    .optional()
    .describe("Also return fresh state: snapshot, console, network (comma-separated)."),
};
