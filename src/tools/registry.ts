import * as advanced from "@/tools/advanced";
import * as clients from "@/tools/clients";
import * as common from "@/tools/common";
import * as content from "@/tools/content";
import * as custom from "@/tools/custom";
import * as dialog from "@/tools/dialog";
import { downloads } from "@/tools/downloads";
import { emulate } from "@/tools/emulate";
import { evaluate } from "@/tools/eval";
import { perfFieldData } from "@/tools/field-data";
import { issues } from "@/tools/issues";
import * as forms from "@/tools/forms";
import * as network from "@/tools/network";
import { pageTools } from "@/tools/page-tools";
import { proxy } from "@/tools/proxy";
import * as snapshot from "@/tools/snapshot";
import * as state from "@/tools/state";
import { status } from "@/tools/status";
import * as tabs from "@/tools/tabs";
import { provideSelectionLine } from "@/tools/selection-line";
import type { Tool } from "@/tools/tool";
import { waitFor } from "@/tools/wait-for";
import { debugLog } from "@/utils/log";

/** Env var that selects a profile or a comma-separated category list. */
export const TOOLS_ENV = "AUTOMATE_BROWSER_TOOLS";

/**
 * Categories mirror the sections of the generated tool reference
 * (`scripts/generate-docs.mjs`), so the docs and the profiles cannot describe
 * two different groupings. `capture` is the one name the roadmap's sketch
 * omitted — screenshot / console / eval are a group of their own, and folding
 * them into `common` would have put arbitrary-JS evaluation in every profile.
 */
export const CATEGORIES = [
  "navigation",
  "snapshot",
  "common",
  "capture",
  "content",
  // Tools the PAGE declares, not tools we bring to it. Its own category rather
  // than a corner of `content` for one reason: `content` is in `core`, and a
  // forward-looking capability that almost no site answers today must not be
  // paid for by the profile that exists to be small.
  "page-tools",
  "forms",
  "state",
  "network",
  "advanced",
  "tabs",
  "clients",
] as const;

export type ToolCategory = (typeof CATEGORIES)[number];

/**
 * Every tool this server can serve, in the order it is advertised. The order is
 * the pre-registry order exactly — `full` must stay byte-identical to the list
 * `index.ts` used to build inline, or the measured token baseline moves for a
 * reason that has nothing to do with the tools.
 */
const REGISTRY: ReadonlyArray<readonly [ToolCategory, Tool]> = [
  ["navigation", common.navigate(true)],
  ["navigation", common.goBack(true)],
  ["navigation", common.goForward(true)],
  ["snapshot", snapshot.snapshot],
  ["snapshot", snapshot.click],
  ["snapshot", snapshot.hover],
  ["snapshot", snapshot.type],
  ["snapshot", snapshot.selectOption],
  ["snapshot", snapshot.drag],
  ["common", common.pressKey],
  ["common", common.wait],
  ["common", waitFor],
  ["capture", custom.getConsoleLogs],
  ["capture", issues],
  ["capture", custom.screenshot],
  ["capture", evaluate],
  ["content", content.readPage],
  ["content", content.getHtml],
  ["content", content.find],
  ["page-tools", pageTools],
  ["forms", forms.fillForm],
  ["forms", forms.clear],
  ["forms", forms.scroll],
  ["state", state.getCookies],
  ["state", state.setCookie],
  ["state", state.storage],
  ["network", network.networkRequests],
  ["network", perfFieldData],
  ["state", dialog.handleDialog],
  ["state", downloads],
  ["state", proxy],
  ["advanced", advanced.advancedMode],
  ["advanced", advanced.uploadFile],
  ["advanced", advanced.getNetworkRequest],
  ["advanced", advanced.perfTrace],
  ["advanced", emulate],
  ["tabs", tabs.listTabs],
  ["tabs", tabs.newTab],
  ["tabs", tabs.switchTab],
  ["tabs", tabs.selectTab],
  ["tabs", tabs.closeTab],
  ["clients", clients.listClients],
  ["clients", clients.selectClient],
  ["clients", clients.forceClaim],
  ["clients", clients.releaseClient],
  ["clients", status],
];

/**
 * The category a tool was registered under. `call.ts` uses it to exempt the
 * ownership/diagnostic tools from the B9 safety gates — the same reason
 * `ALWAYS_ON` exists: gate the tools an agent uses to FIND and KEEP a browser
 * and it is stranded with no way to ask why.
 */
export function categoryOf(name: string): ToolCategory | undefined {
  return REGISTRY.find(([, t]) => t.schema.name === name)?.[0];
}

/**
 * Diagnostics can never be filtered away: without these an agent on a trimmed
 * profile has no way to find out *why* it cannot see or drive a browser.
 */
const ALWAYS_ON: readonly string[] = [
  "browser_status",
  "browser_list_clients",
  "browser_select_client",
];

type ProfileSpec = {
  categories: readonly ToolCategory[];
  /** Individual tools pulled in on top of `categories`. */
  tools?: readonly string[];
};

const PROFILES: Record<string, ProfileSpec> = {
  full: { categories: CATEGORIES },
  core: {
    categories: ["navigation", "snapshot", "content", "common"],
    tools: ["browser_screenshot"],
  },
  slim: {
    categories: [],
    tools: ["browser_navigate", "browser_snapshot", "browser_eval", "browser_screenshot"],
  },
};

export const PROFILE_NAMES = Object.keys(PROFILES);

export type ToolSelection = {
  tools: Tool[];
  /** What was actually served — a profile name, or `custom` for a category list. */
  label: string;
  /** The raw env value, when one was set. */
  requested?: string;
  /** True when `requested` was unusable and `full` was served instead. */
  fellBack: boolean;
};

/** Tools matching a spec, in registry order, unioned with the always-on set. */
function build(spec: ProfileSpec, label: string, requested?: string): ToolSelection {
  const cats = new Set<string>(spec.categories);
  const names = new Set<string>([...(spec.tools ?? []), ...ALWAYS_ON]);
  return {
    tools: REGISTRY.filter(
      ([category, tool]) => cats.has(category) || names.has(tool.schema.name),
    ).map(([, tool]) => tool),
    label,
    requested,
    fellBack: false,
  };
}

/**
 * Resolve a `AUTOMATE_BROWSER_TOOLS` value. Accepts a profile name (`full`,
 * `core`, `slim`) or a comma-separated category list (`navigation,tabs`).
 * Anything else warns and serves `full` — a typo must never silently strand an
 * agent with a partial or empty tool list.
 */
export function selectTools(spec?: string): ToolSelection {
  const raw = spec?.trim();
  if (!raw) return build(PROFILES.full, "full");

  const value = raw.toLowerCase();
  const profile = PROFILES[value];
  if (profile) return build(profile, value, raw);

  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const unknown = parts.filter((p) => !(CATEGORIES as readonly string[]).includes(p));
  if (parts.length > 0 && unknown.length === 0) {
    return build({ categories: parts as ToolCategory[] }, "custom", raw);
  }

  debugLog(
    `[registry] ${TOOLS_ENV}="${raw}" is not a profile (${PROFILE_NAMES.join(", ")}) ` +
      `or a category list (${CATEGORIES.join(", ")})` +
      (unknown.length > 0 ? `; unrecognised: ${unknown.join(", ")}` : "") +
      ` — serving the full tool set.`,
  );
  return { ...build(PROFILES.full, "full", raw), fellBack: true };
}

let cached: ToolSelection | undefined;

/** The selection this process serves, resolved once from the environment. */
export function activeSelection(): ToolSelection {
  cached ??= selectTools(process.env[TOOLS_ENV]);
  return cached;
}

/** One line for `browser_status`: what is served, and how to change it. */
export function describeSelection(): string {
  const s = activeSelection();
  const total = REGISTRY.length;
  const which = s.label === "custom" ? `categories "${s.requested}"` : `"${s.label}" profile`;
  const warn = s.fellBack
    ? ` (⚠ ${TOOLS_ENV}="${s.requested}" was not recognised — full set served)`
    : "";
  return (
    `tools: ${s.tools.length} of ${total} — ${which}${warn}. ` +
    `Set ${TOOLS_ENV} to ${PROFILE_NAMES.join(" | ")} or a category list to change it.`
  );
}

// Hand the line to `browser_status` without it having to import this module —
// see `selection-line.ts` for why the dependency runs this way round.
provideSelectionLine(describeSelection);
