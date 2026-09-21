import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { StatusInfo } from "@/context";
import { selectionLine } from "@/tools/selection-line";
import { auditTail, describeAudit } from "@/utils/audit";
import { isLoopbackHost } from "@/utils/host";
import { describePolicy } from "@/utils/origins";

import { renderClient } from "./clients";
import type { Tool } from "./tool";

const StatusOutput = z.object({
  relayPort: z.number().optional(),
  relayVersion: z.string().optional(),
  serverVersion: z.string(),
  ctrlId: z.string().optional(),
  clientName: z.string(),
  browsers: z.array(z.record(z.unknown())),
  controllers: z.array(z.record(z.unknown())),
  legacyPorts: z.array(z.number()),
  notice: z.string().optional(),
});

/**
 * One line saying whether the link is up, coming back, or finished — and, when
 * it is coming back, whether waiting is worth it (I01).
 *
 * The state is an UPPERCASE head rather than a field in `outputSchema`, so an
 * agent can branch on `link: RETRYING` without parsing the sentence after it.
 * That is the same shape as the relay's notice codes, and it is here because a
 * five-value enum in the output schema cost 28 tokens of a budget that had 22
 * left — paid on every request, forever, to restate what this line already says.
 *
 * Every branch answers the same two questions an agent actually has: is this
 * going to fix itself, and should I wait or act. A state with no answer to those
 * is a state that should not be reported separately.
 */
export function describeRecovery(r: StatusInfo["recovery"]): string {
  const since = r.attempts === 1 ? "1 failed attempt" : `${r.attempts} failed attempts`;
  const why = r.lastError ? ` Last failure: ${r.lastError}` : "";
  switch (r.state) {
    case "connected":
      return "link: CONNECTED";
    case "waiting":
      // Connected and useless is its own state, and the most confusing one to
      // hit without being told which half is missing.
      return (
        "link: WAITING — connected to the relay, but no browser has joined it yet. " +
        "Nothing can be driven until one does."
      );
    case "retrying": {
      const next =
        r.nextRetryInMs === undefined
          ? "another attempt is queued"
          : `next attempt in ${(r.nextRetryInMs / 1000).toFixed(1)}s`;
      return `link: RETRYING — ${since}, ${next}. It will keep trying on its own.${why}`;
    }
    case "stopped":
      // The one state where waiting is the wrong answer, so it says so outright.
      return (
        "link: STOPPED — this server is shutting down and will NOT reconnect. " +
        "Nothing is being retried."
      );
    case "connecting":
    default:
      return r.attempts > 0
        ? `link: CONNECTING — ${since} so far.${why}`
        : "link: CONNECTING to the relay";
  }
}

/**
 * browser_status — one-call diagnostics for the shared relay. Answers "why can't
 * I see/drive the browser I expect?": which relay (port + version) this agent is
 * on, this agent's name/id, every connected browser (with its live tab and who
 * is driving it), every other connected agent, and warnings (e.g. a legacy
 * `npx @automatebrowser/mcp` server squatting the port range and hiding browsers).
 */
export const status: Tool = {
  schema: {
    name: "browser_status",
    description:
      "Diagnostics for the AutomateBrowser relay. Reports the relay port + version, THIS agent's " +
      "name and id, every connected browser (browser, label, current tab, and who is driving " +
      "it), every other connected agent, and any warnings (such as an older AutomateBrowser server " +
      "holding the port range and hiding browsers). Use this first when a browser you expect is " +
      "missing, a tool says a browser is being driven by someone else, or the connection seems off.",
    inputSchema: zodToJsonSchema(z.object({}).strict()),
    outputSchema: zodToJsonSchema(StatusOutput),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context) => {
    const s = context.status();
    const { recovery, ...rest } = s;
    const lines: string[] = [];

    if (s.notice) lines.push(s.notice, "");

    const relay =
      s.relayPort != null
        ? `relay ws://127.0.0.1:${s.relayPort}${s.relayVersion ? ` (v${s.relayVersion})` : ""}`
        : "relay: not connected";
    lines.push(relay);
    // I01 — the line that used to read "not connected yet (starting / retrying)"
    // covered four different situations with one shrug, including the one where
    // nothing is coming back at all. Say which, and whether to wait.
    lines.push(describeRecovery(recovery));
    lines.push(`you: "${s.clientName}"${s.ctrlId ? ` [id=${s.ctrlId.slice(0, 8)}]` : ""}`);
    // Pulled from a leaf module the registry pushes to, rather than imported
    // from the registry directly: the registry must import THIS tool to serve
    // it, so importing it back would close a load-time cycle.
    const selection = selectionLine();
    if (selection) lines.push(selection);
    // Only when a B9 policy is configured — an unrestricted server says nothing,
    // so the line's presence IS the signal that something is being refused.
    const safety = describePolicy();
    if (safety) lines.push(safety);
    // B10: where the action trail is, and the last few things this agent did.
    // Deliberately NOT a parameter — `browser_status` takes no arguments today
    // and a `tail` knob would cost schema tokens on every request to buy a
    // number that five lines already answers.
    lines.push(describeAudit());

    lines.push("", `Browsers (${s.browsers.length}):`);
    if (s.browsers.length === 0) {
      lines.push(
        "  (none) — open a browser with the AutomateBrowser extension on a normal http(s) tab.",
      );
    } else {
      for (const b of s.browsers) lines.push(renderClient(b, s.ctrlId));
    }

    const otherAgents = s.controllers.filter((p) => !p.self);
    lines.push("", `Other agents connected (${otherAgents.length}):`);
    if (otherAgents.length === 0) lines.push("  (none)");
    else for (const p of otherAgents) lines.push(`  - ${p.name}`);

    // The relay is a singleton: whichever build wins the port race owns it until
    // it idles out, so a second IDE on a different build silently drives a relay
    // that is not its own. Same shape as the legacy-port warning below.
    if (s.relayVersion && s.relayVersion !== s.serverVersion) {
      lines.push(
        "",
        `⚠ Version mismatch: this server is v${s.serverVersion}, but the relay it is ` +
          `connected to is v${s.relayVersion}. The relay is shared and single-instance — an IDE ` +
          "running a different AutomateBrowser build started it first and owns the port. Tools that " +
          "changed between those versions may behave unexpectedly. Point every IDE at the same build, " +
          "then close them all and reopen (the relay exits once no server is left) so a matching one starts.",
      );
    }

    const recent = auditTail(5);
    if (recent.length > 0) {
      lines.push("", `Recent actions (newest last, full trail in the audit file):`, ...recent);
    }

    // C13: a relay bound past loopback accepts connections from other machines.
    // That is opt-in and token-gated, but it is not a state anyone should have to
    // read a log file to discover.
    if (s.relayHost && !isLoopbackHost(s.relayHost)) {
      lines.push(
        "",
        `⚠ This relay is bound to ${s.relayHost}, so it is reachable from OTHER MACHINES on the ` +
          "network, not just this one. A shared secret (AUTOMATE_BROWSER_TOKEN) is required to " +
          "connect — every browser and agent must prove it. Unset AUTOMATE_BROWSER_RELAY_HOST and " +
          "restart the relay to go back to this machine only.",
      );
    }

    if (s.legacyPorts.length > 0) {
      lines.push(
        "",
        `⚠ An older AutomateBrowser server is running on port(s) ${s.legacyPorts.join(", ")}. ` +
          "It can capture browsers this relay never sees (e.g. a browser shows in one IDE but " +
          "not another). Remove the old `npx @automatebrowser/mcp` config from that IDE and restart it, " +
          "so every IDE launches the same local build.",
      );
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: { ...rest },
    };
  },
};
