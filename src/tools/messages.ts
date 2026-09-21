/**
 * The wire contract for every message a TOOL sends the extension — derived from
 * the zod schema the tool already validates its arguments with, never hand-copied.
 *
 * Why derived: this map's ancestor (`SocketMessageMap`) was hand-written, and by
 * 2026-09-08 it declared 20 of the ~50 types the server actually sent. The other
 * thirty went out with a cast on the type name AND a cast on the payload — the
 * first hiding a key the map never had, the second hiding the payload that key
 * would have typed — so the contract was switched off for most of the tool layer
 * and a renamed payload field compiled cleanly and failed on a user's browser.
 * A second hand-written declaration is exactly what rotted the first
 * one, so every entry below reads its shape off the schema. A field added to a
 * tool's arguments is on the wire contract the moment it is added.
 *
 * `response` is `unknown` for a tool message on purpose: the extension answers
 * with whatever that message means, tools already assert the shape they expect at
 * the call site, and inventing a declaration here would be the same hand-copy in
 * the other direction. The few messages whose answer IS fixed (`getUrl`,
 * `getTitle`, `browser_snapshot`) keep their concrete types in `SocketMessageMap`.
 *
 * Imports are type-only, so this file adds no runtime edge and no import cycle,
 * even though every module it reads from imports `Context` back.
 */
import type { z } from "zod";

import type { SocketMessageMap } from "@repo/types/messages/ws";

import type {
  AdvancedModeArgs,
  GetNetworkRequestArgs,
  PerfTraceArgs,
  UploadFileArgs,
} from "./advanced";
import type { GoArgs, NavigateArgs, PressKeyArgs } from "./common";
import type { FindArgs, GetHtmlArgs, ReadPageArgs } from "./content";
import type { ConsoleArgs, ScreenshotArgs } from "./custom";
import type { DialogArgs } from "./dialog";
import type { DownloadsArgs } from "./downloads";
import type { EmulateArgs } from "./emulate";
import type { EvalArgs } from "./eval";
import type { ClearArgs, FillFormArgs, ScrollArgs } from "./forms";
import type { IssuesArgs } from "./issues";
import type { NetworkArgs } from "./network";
import type { PageToolsArgs } from "./page-tools";
import type { ProxyArgs } from "./proxy";
import type { ClickArgs, DragArgs, HoverArgs, SelectOptionArgs, TypeArgs } from "./snapshot";
import type { GetCookiesArgs, SetCookieArgs, StorageArgs } from "./state";
import type { NewTabArgs, SelectTabRef, TabRef } from "./tabs";
import type { WaitForArgs } from "./wait-for";

/** Whatever the extension answers. Tools assert the shape they expect at the call site. */
type Answer = unknown;

/**
 * Rides in the PAYLOAD of the five interaction messages rather than in their tool
 * schemas: `AUTOMATE_BROWSER_ACTIONABILITY=off` is a server-side switch, so
 * putting it in the schemas would cost tokens on five tools for a value no agent
 * ever sets. See `sendAction` in `./snapshot`.
 */
type Actionability = { actionability?: boolean };

/** The ceiling `browser_screenshot` attaches to an INLINE capture (see `screenshotCeiling`). */
type ScreenshotExtras = {
  maxWidth?: number;
  maxHeight?: number;
  /** Force the debugger path — a frame strip does, because the cheap capture is quota'd at 2/s. */
  forceCdp?: boolean;
};

export interface ToolMessageMap {
  // ── navigation & timing ───────────────────────────────────────────────────
  browser_navigate: { payload: z.infer<typeof NavigateArgs>; response: Answer };
  browser_go_back: { payload: z.infer<typeof GoArgs>; response: Answer };
  browser_go_forward: { payload: z.infer<typeof GoArgs>; response: Answer };
  browser_wait_for: { payload: z.infer<typeof WaitForArgs>; response: Answer };

  // ── interaction ───────────────────────────────────────────────────────────
  browser_press_key: { payload: z.infer<typeof PressKeyArgs>; response: Answer };
  browser_click: { payload: z.infer<typeof ClickArgs> & Actionability; response: Answer };
  browser_drag: { payload: z.infer<typeof DragArgs> & Actionability; response: Answer };
  browser_hover: { payload: z.infer<typeof HoverArgs> & Actionability; response: Answer };
  browser_type: { payload: z.infer<typeof TypeArgs> & Actionability; response: Answer };
  browser_select_option: {
    payload: z.infer<typeof SelectOptionArgs> & Actionability;
    response: Answer;
  };
  browser_fill_form: { payload: z.infer<typeof FillFormArgs>; response: Answer };
  browser_clear: { payload: z.infer<typeof ClearArgs>; response: Answer };
  browser_scroll: { payload: z.infer<typeof ScrollArgs>; response: Answer };
  browser_handle_dialog: { payload: z.infer<typeof DialogArgs>; response: Answer };
  browser_upload_file: { payload: z.infer<typeof UploadFileArgs>; response: Answer };

  // ── reading ───────────────────────────────────────────────────────────────
  browser_read_page: { payload: z.infer<typeof ReadPageArgs>; response: Answer };
  browser_get_html: { payload: z.infer<typeof GetHtmlArgs>; response: Answer };
  browser_find: { payload: z.infer<typeof FindArgs>; response: Answer };
  browser_eval: { payload: z.infer<typeof EvalArgs>; response: Answer };
  browser_screenshot: {
    payload: z.infer<typeof ScreenshotArgs> & ScreenshotExtras;
    response: Answer;
  };
  /** `page` never crosses the wire: the extension holds the whole buffer and the slice happens here. */
  browser_get_console_logs: {
    payload: Omit<z.infer<typeof ConsoleArgs>, "page">;
    response: Answer;
  };

  // ── diagnostics ───────────────────────────────────────────────────────────
  browser_issues: { payload: z.infer<typeof IssuesArgs>; response: Answer };
  browser_network_requests: { payload: z.infer<typeof NetworkArgs>; response: Answer };
  browser_get_network_request: {
    payload: z.infer<typeof GetNetworkRequestArgs>;
    response: Answer;
  };
  /**
   * Narrower than the tool's own arguments, because two of them never leave the
   * server. `action:"analyze"` re-reads a trace FILE and returns without touching
   * the browser at all, and `filePath` is where that file lives — the three
   * payloads this actually sends are built by hand in `./advanced`.
   *
   * Derived rather than re-declared (same reason as `browser_get_console_logs`
   * above): a new option added to the schema still arrives here, and a new action
   * still has to be answered for on both halves.
   */
  browser_perf_trace: {
    payload: Omit<z.infer<typeof PerfTraceArgs>, "action" | "filePath"> & {
      action: Exclude<z.infer<typeof PerfTraceArgs>["action"], "analyze">;
    };
    response: Answer;
  };
  browser_advanced_mode: { payload: z.infer<typeof AdvancedModeArgs>; response: Answer };

  // ── session & environment ─────────────────────────────────────────────────
  browser_get_cookies: { payload: z.infer<typeof GetCookiesArgs>; response: Answer };
  browser_set_cookie: { payload: z.infer<typeof SetCookieArgs>; response: Answer };
  browser_storage: { payload: z.infer<typeof StorageArgs>; response: Answer };
  browser_downloads: { payload: z.infer<typeof DownloadsArgs>; response: Answer };
  browser_emulate: { payload: z.infer<typeof EmulateArgs>; response: Answer };
  browser_proxy: { payload: z.infer<typeof ProxyArgs>; response: Answer };
  browser_page_tools: { payload: z.infer<typeof PageToolsArgs>; response: Answer };

  // ── tabs ──────────────────────────────────────────────────────────────────
  browser_list_tabs: { payload: Record<string, never>; response: Answer };
  browser_new_tab: { payload: z.infer<typeof NewTabArgs>; response: Answer };
  browser_switch_tab: { payload: z.infer<typeof TabRef>; response: Answer };
  browser_select_tab: { payload: z.infer<typeof SelectTabRef>; response: Answer };
  browser_close_tab: { payload: z.infer<typeof TabRef>; response: Answer };

  /**
   * Server-internal, so it has no tool and no schema to derive from: `callTool`
   * pushes the operator's origin deny-list to each browser it drives, so the
   * extension can refuse a blocked request the page makes on its own.
   *
   * `owner` names the controller the deny-list belongs to (B05). Several agents
   * share one browser, and without it the extension cannot tell "replace what I
   * asked for last time" from "throw away what somebody else is relying on".
   * Optional on the wire so an older server still installs, as one shared owner.
   */
  browser_net_policy: { payload: { deny: string[]; owner?: string }; response: Answer };
}

/**
 * Every message the server can send: the control plane and the fixed-answer reads
 * from `SocketMessageMap`, plus the schema-derived tool messages above. A key in
 * both would be a type error rather than a silent winner — which is the point of
 * an intersection here instead of a spread.
 */
export type WireMessageMap = SocketMessageMap & ToolMessageMap;
