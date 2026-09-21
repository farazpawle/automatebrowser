/**
 * Page-declared tools — DEBUGGER-FREE.
 *
 * Some pages publish the things they can do, so an agent calls the action
 * directly instead of finding and clicking the controls for it. Two conventions
 * exist and this reads BOTH, in one MAIN-world pass:
 *
 *   1. **WebMCP** (W3C draft) — `document.modelContext`, with
 *      `navigator.modelContext` kept as the deprecated older name.
 *   2. **`devtoolstooldiscovery`** — the chrome-devtools-mcp convention. The page
 *      adds a listener; the READER dispatches the event and the listener answers
 *      through `event.respondWith(toolGroup)`. Nothing sits on `window` until
 *      something asks, which is why inspecting globals finds nothing here.
 *
 * VERIFIED against `scripts/fixtures/page-tools.html`, 2026-09-05, Chrome 152:
 *   - `document.modelContext` exists in the Chrome-for-Testing 152.0.7977.54
 *     build with no flags, and is ABSENT from installed stable 152.0.7977.83 —
 *     availability differs between builds of the same version number, so it is
 *     feature-detected on every call and never assumed.
 *   - `navigator.modelContext` was already gone in both; the older name is a
 *     fallback for older builds, not a substitute.
 *   - `getTools()` returns plain objects whose `inputSchema` is a JSON STRING,
 *     and which carry a `window` back-reference — the array cannot be structured-
 *     cloned as it stands, so every field is projected by hand.
 *   - `executeTool()` takes the TOOL OBJECT from `getTools()` (not its name) and
 *     its arguments as a JSON STRING, and returns the result as a JSON STRING.
 *     Passing a name, or an argument object, fails.
 *   - The discovery event needs no flag, no debugger and no permission, and
 *     answered in every build tested. It is the half that actually runs today.
 *
 * The reader NEVER throws for a page that declares nothing: that is the answer
 * on essentially every site, and it is a fact about the page, not a failure.
 */
import { runFunc } from "./run-func";

export interface PageToolInfo {
  name: string;
  title: string;
  description: string;
  /** JSON Schema for the tool's arguments, or null when the page gave none. */
  inputSchema: unknown;
  /** Which convention declared it. */
  source: "webmcp" | "dtmcp";
  /** The declaring group, for the discovery-event convention only. */
  group: string;
}

export interface PageToolsList {
  tools: PageToolInfo[];
  /** Empty when tools were found; a plain explanation when none were. */
  reason: string;
}

export interface PageToolResult {
  name: string;
  source: string;
  /** The tool's return value, JSON-encoded in the page. Null when it would not encode. */
  resultJson: string | null;
}

/**
 * The one injected function, in the page's MAIN world.
 *
 * List and call share it because they share the discovery: `call` has to find
 * the tool before it can run it, and a second copy of that walk is a second
 * chance for the two to disagree about what the page offers. Self-contained by
 * necessity — `chrome.scripting` serialises this by source.
 */
async function pageToolsPage(
  mode: "list" | "call",
  wanted: string | null,
  argsJson: string | null,
): Promise<any> {
  const parse = (v: any) => {
    try {
      return JSON.parse(String(v));
    } catch {
      return null;
    }
  };
  const entries: Array<{ info: any; run: (json: string) => Promise<any> }> = [];
  const notes: string[] = [];

  // ── 1. WebMCP ────────────────────────────────────────────────────────────
  const mc: any = (document as any).modelContext || (navigator as any).modelContext;
  if (mc && typeof mc.getTools === "function") {
    try {
      const list = (await mc.getTools()) || [];
      for (const t of list) {
        entries.push({
          info: {
            name: String(t.name ?? ""),
            title: String(t.title ?? ""),
            description: String(t.description ?? ""),
            // Chrome hands this back as a JSON string; a page's own polyfill may
            // hand back the object. Accept either, return the object.
            inputSchema:
              typeof t.inputSchema === "string" ? parse(t.inputSchema) : (t.inputSchema ?? null),
            source: "webmcp",
            group: "",
          },
          run: (json: string) => mc.executeTool(t, json),
        });
      }
    } catch (e: any) {
      notes.push("WebMCP tools could not be read: " + String(e?.message || e));
    }
  } else if (mc) {
    notes.push(
      "This build exposes a model context without getTools(), so what the page registered " +
        "cannot be read back.",
    );
  }

  // ── 2. The discovery event ───────────────────────────────────────────────
  let groups: any[] = [];
  try {
    groups = await new Promise<any[]>((resolve) => {
      const collected: any[] = [];
      const ev: any = new CustomEvent("devtoolstooldiscovery");
      ev.respondWith = (g: any) => {
        if (g && Array.isArray(g.tools)) collected.push(g);
      };
      window.dispatchEvent(ev);
      // A listener may answer asynchronously; anything synchronous is already in.
      if (collected.length) resolve(collected);
      else setTimeout(() => resolve(collected), 150);
    });
  } catch (e: any) {
    notes.push("Tool discovery failed: " + String(e?.message || e));
  }
  for (const g of groups) {
    for (const t of g.tools || []) {
      if (!t || typeof t.execute !== "function") continue;
      // A page that both registers with WebMCP and answers the discovery event
      // declares each tool twice. Listing it twice would read as two different
      // actions; the WebMCP entry, found first, wins.
      if (entries.some((e) => e.info.name === String(t.name ?? ""))) continue;
      entries.push({
        info: {
          name: String(t.name ?? ""),
          title: "",
          description: String(t.description ?? ""),
          inputSchema: t.inputSchema ?? null,
          source: "dtmcp",
          group: String(g.name ?? ""),
        },
        run: (json: string) => t.execute(parse(json) || {}),
      });
    }
  }
  // Leave the ecosystem's own handle behind, exactly as chrome-devtools-mcp does
  // after discovery. It is the escape hatch for a result that will not JSON-encode:
  // `browser_eval` can call `window.__dtmcp.executeTool(name, args)` and pick the
  // pieces it wants out of a live object.
  if (groups.length) {
    const w: any = window;
    w.__dtmcp = w.__dtmcp || {};
    w.__dtmcp.toolGroups = groups;
    w.__dtmcp.executeTool = async (n: string, a: any) => {
      for (const g of groups) {
        const t = (g.tools || []).find((x: any) => x.name === n);
        if (t) return await t.execute(a);
      }
      throw new Error("Tool " + n + " not found");
    };
  }

  if (mode === "list") {
    const reason = entries.length
      ? notes.join(" ")
      : [
          "This page declares no tools:",
          mc ? "its model context registered none," : "it exposes no model context,",
          "and nothing answered the discovery event. That is the answer on almost every site today.",
          ...notes,
        ]
          .filter(Boolean)
          .join(" ");
    return { tools: entries.map((e) => e.info), reason };
  }

  const hit = entries.find((e) => e.info.name === wanted);
  if (!hit) {
    return {
      failed: entries.length
        ? "This page declares no tool named " +
          String(wanted) +
          ". It offers: " +
          entries.map((e) => e.info.name).join(", ")
        : "This page declares no tools at all, so there is nothing named " +
          String(wanted) +
          " to call.",
    };
  }
  let value: any;
  try {
    value = await hit.run(argsJson || "{}");
  } catch (e: any) {
    return { failed: "The page's own tool threw: " + String(e?.message || e) };
  }
  // WebMCP returns its result already JSON-encoded; the discovery convention
  // returns a live object. Normalise to one encoded string, IN THE PAGE, because
  // a DOM node or a function inside that object would not survive the trip out.
  if (typeof value === "string") {
    const decoded = parse(value);
    if (decoded !== null) value = decoded;
  }
  let resultJson: string | null = null;
  try {
    const encoded = JSON.stringify(value ?? null);
    resultJson = encoded === undefined ? null : encoded;
  } catch {
    resultJson = null;
  }
  return { name: hit.info.name, source: hit.info.source, resultJson };
}

/** Everything this page offers, from both conventions. Never throws for "none". */
export async function listPageTools(tabId: number): Promise<PageToolsList> {
  return (await runFunc(tabId, pageToolsPage, ["list", null, null], "MAIN")) as PageToolsList;
}

/** Run one of them. `argsJson` is the arguments as a JSON string, already validated. */
export async function callPageTool(
  tabId: number,
  args: { name?: string; args?: string },
): Promise<PageToolResult> {
  const name = String(args.name ?? "").trim();
  if (!name) throw new Error("browser_page_tools action=call requires a tool `name`.");
  const r: any = await runFunc(tabId, pageToolsPage, ["call", name, args.args ?? "{}"], "MAIN");
  if (r?.failed) throw new Error(r.failed);
  return r as PageToolResult;
}
