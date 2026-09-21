import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { paginate } from "@/utils/paginate";

import { issueCode } from "./errors";
import type { Tool } from "./tool";

/**
 * browser_issues (C4) — the failures that leave NO console error.
 *
 * CSP blocks, deprecations, interventions, blocked or failed subresource requests
 * and 4xx/5xx responses are all things Chrome knows about and never prints. An
 * agent looking only at the console sees "the button did nothing" with no path to
 * "your CSP blocked the inline handler". Two sources are merged extension-side:
 * the MAIN-world ReportingObserver / securitypolicyviolation feed, and the
 * existing webRequest log filtered to failures. Scoped to the current document —
 * the tab's last main-frame request is the boundary.
 *
 * Debugger-free. The fully-aggregated DevTools Issues taxonomy needs `Audits.enable`
 * over CDP; that is a `browser_advanced_mode` enrichment later, not this.
 *
 * `audit:"a11y"` (D8) asks the same question of a different oracle: not what the
 * browser reported, but what axe-core finds walking the rendered tree. It folds
 * in here rather than taking a tool of its own because a 47th tool is paid for
 * by every agent on every request, and this one shares this tool's meaning
 * exactly — problems with the page that nothing else surfaces.
 */

/**
 * Failing RULES per page, when the caller names no `limit`. Rules, not
 * elements: a rule is never split across a page boundary, so its examples and
 * its fix link always arrive together.
 */
const A11Y_PAGE_SIZE = 20;

export const IssuesArgs = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max issues to return (default 100, most recent)."),
  audit: z.enum(["a11y"]).optional().describe("Run an accessibility audit (axe-core)."),
  // `.min(1)` rather than `.positive()`: identical for an integer, and it emits
  // `minimum:1` instead of `exclusiveMinimum:0` — clearer to read and cheaper in
  // a schema every request pays for.
  page: z.number().int().min(1).optional().describe("Audit page, worst first."),
});

/**
 * No `outputSchema`. It used to declare `{issues, dropped, capturedNetwork}` as
 * REQUIRED with `additionalProperties:false` — a contract the audit branch
 * cannot meet, because an audit answers with violations, not issues. The three
 * ways out were: widen it to a union that says almost nothing and costs ~60
 * tokens; force a11y findings into the issue shape (`capturedNetwork:false` on a
 * reply that never asked about the network); or drop it. Dropped, for the same
 * reason `browser_emulate` dropped its own — the tool answers in prose, the
 * `structuredContent` is still there and still typed by these interfaces, and a
 * schema every request pays for should not be one half of the tool violates.
 */

export interface A11yNode {
  ref?: string;
  target: string;
  html: string;
}
export interface A11yViolation {
  id: string;
  impact: string;
  help: string;
  helpUrl: string;
  nodes: A11yNode[];
  nodeCount: number;
}
export interface A11yResult {
  violations: A11yViolation[];
  passed: number;
  incomplete: number;
  version: string;
}

/**
 * The sentence every audit reply carries, clean or not.
 *
 * Automated rules catch on the order of a THIRD of real accessibility barriers.
 * They cannot tell whether alt text is accurate, whether a focus order makes
 * sense, or whether a custom widget is operable — only that the attributes
 * exist. An agent that reads "0 violations" as "accessible" ships an
 * inaccessible page with a passing report attached, which is worse than no
 * report. So the limit is stated on success as loudly as on failure, in the
 * same place, and is not a footnote the model can page past.
 */
const A11Y_FLOOR =
  "Automated rules catch roughly a third of real accessibility barriers — this is a floor, not a pass.";

/**
 * Render one page of findings.
 *
 * The extension hands back violations sorted worst-LAST, because `paginate`
 * serves the tail as page 1 — that is what puts the critical findings on the
 * page an agent gets without asking. Within the page they are reversed, so
 * reading order is worst-first at both scales.
 *
 * Exported for `tests/a11y-report.test.ts`: the ordering is the easiest thing
 * here to get silently backwards, and it is pure, so it is pinned without a
 * browser.
 */
export function renderA11y(r: A11yResult, page: number | undefined, size = A11Y_PAGE_SIZE): string {
  const p = paginate(r.violations, page, size);
  const lines: string[] = [];
  const elements = r.violations.reduce((n, v) => n + v.nodeCount, 0);

  if (r.violations.length === 0) {
    lines.push(
      `No accessibility violations found (axe-core ${r.version}, ${r.passed} rules passed).`,
    );
  } else {
    lines.push(
      `${r.violations.length} accessibility rules failed across ${elements} elements ` +
        `(axe-core ${r.version}, ${r.passed} rules passed).`,
      "",
    );
    for (const v of [...p.items].reverse()) {
      const count = v.nodeCount;
      lines.push(`[${v.impact}] ${v.id} — ${v.help} (${count} element${count === 1 ? "" : "s"})`);
      for (const n of v.nodes) {
        // The ref is the whole point of mapping back: with one, the agent can act
        // on the element through every other tool. Without it the selector is
        // still enough for a human to find it, so a missing ref never hides a
        // finding — it just costs a snapshot to make it actionable.
        lines.push(`  ${n.ref ? n.ref + "  " : ""}${n.target}`, `    ${n.html}`);
      }
      if (v.nodeCount > v.nodes.length) {
        lines.push(`  (+${v.nodeCount - v.nodes.length} more elements, same rule)`);
      }
      lines.push(`  fix: ${v.helpUrl}`);
      lines.push("");
    }
  }

  if (p.totalPages > 1 || p.clamped !== undefined) {
    const missing = p.clamped === undefined ? "" : `page ${p.clamped} does not exist, so this is `;
    const next = p.hasNext
      ? ` Less severe: browser_issues {"audit":"a11y","page":${p.page + 1}}`
      : " This is the least severe page.";
    lines.push(
      `— ${missing}page ${p.page}/${p.totalPages} of ${p.total} failing rules, ` +
        `most severe first.${next}`,
      "",
    );
  }

  // Counted, never listed. An "incomplete" is axe declining to decide — a
  // contrast check over a background image, say — so printing them alongside
  // real violations would pad the report with things that may be perfectly fine.
  if (r.incomplete > 0) {
    lines.push(`${r.incomplete} rules need human review (axe could not decide alone).`);
  }
  lines.push(A11Y_FLOOR);
  return lines.join("\n");
}

export const issues: Tool = {
  schema: {
    name: "browser_issues",
    description:
      "Problems the browser detected that produce NO console error: blocked content (CSP), " +
      "deprecated API use, browser interventions, and failed or 4xx/5xx network requests. Use this " +
      "when something on the page silently did nothing and the console is clean — it is the usual " +
      "reason. Covers the current page only.",
    inputSchema: zodToJsonSchema(IssuesArgs),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handle: async (context, params) => {
    const args = IssuesArgs.parse(params ?? {});

    // The audit is a different question with a different answer shape, so it
    // returns here rather than threading an `if` through the issue renderer
    // below. `page` is applied server-side: the extension has no reason to know
    // how the findings are sliced, and re-auditing the page per page would give
    // a different page 2 than page 1 came from.
    if (args.audit === "a11y") {
      const a = (await context.sendSocketMessage("browser_issues", args)) as A11yResult;
      return {
        // `limit` is this tool's existing "how much do you want" argument, so it
        // sets the page size here too. Ignoring it would have accepted the
        // argument and silently done something else.
        content: [{ type: "text", text: renderA11y(a, args.page, args.limit) }],
        structuredContent: { ...a, audit: "a11y" },
      };
    }

    const r = (await context.sendSocketMessage("browser_issues", args)) as {
      issues: Array<{ source: string; kind: string; ts: number; text: string; url?: string }>;
      dropped: number;
      capturedNetwork: boolean;
    };
    const lines: string[] = [];
    if (r.issues.length === 0) {
      lines.push("(no issues detected for this page)");
      // Silence here means two very different things, and conflating them sends an
      // agent down the wrong path: a clean page, or a browser that never captured.
      if (!r.capturedNetwork) {
        lines.push(
          "Note: network capture is unavailable, so blocked/failed requests are not included.",
        );
      }
    } else {
      for (const i of r.issues) {
        lines.push(`[${i.kind}] ${i.text}`);
      }
      if (r.dropped > 0) {
        lines.push("", `(${r.dropped} earlier page issues were dropped — buffer cap 200.)`);
      }
    }
    // The taxonomy code goes in the STRUCTURED half, not the text (B6 + C4). An
    // issue IS the machine-readable reason a call silently did nothing, so it
    // must name the failure the same way an error does — but the text line keeps
    // Chrome's own vocabulary (`csp-violation`), which is more specific than the
    // code and is what someone searching the web will actually find.
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        ...r,
        issues: r.issues.map((i) => {
          const code = issueCode(i.kind);
          return code ? { ...i, code } : i;
        }),
      },
    };
  },
};
