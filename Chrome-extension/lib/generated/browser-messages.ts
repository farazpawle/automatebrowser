/**
 * GENERATED FILE — do not edit. Run `npm run contracts:generate`.
 *
 * Source of truth: the server's `WireMessageMap` (`src/tools/messages.ts`), whose
 * tool payloads are themselves derived from the zod schema each tool validates
 * its arguments with. Rename an argument on the server and the handler here stops
 * compiling — which is the entire point: it used to compile and fail in a
 * user's browser.
 *
 * Standalone on purpose: no zod, no Node, no server imports. This package has its
 * own tsconfig and its own CI job, and anything reaching back across would not
 * build here.
 *
 * Types are not runtime validation. The envelope is still checked in
 * `../protocol.ts`, and arguments are still parsed and policed by the server.
 */

/** Every command the server can send. Control-plane frames live in `../protocol.ts`. */
export const BROWSER_COMMANDS = [
  "browser_wait",
  "browser_snapshot",
  "browser_snapshot_full",
  "getUrl",
  "getTitle",
  "browser_navigate",
  "browser_go_back",
  "browser_go_forward",
  "browser_wait_for",
  "browser_press_key",
  "browser_click",
  "browser_drag",
  "browser_hover",
  "browser_type",
  "browser_select_option",
  "browser_fill_form",
  "browser_clear",
  "browser_scroll",
  "browser_handle_dialog",
  "browser_upload_file",
  "browser_read_page",
  "browser_get_html",
  "browser_find",
  "browser_eval",
  "browser_screenshot",
  "browser_get_console_logs",
  "browser_issues",
  "browser_network_requests",
  "browser_get_network_request",
  "browser_perf_trace",
  "browser_advanced_mode",
  "browser_get_cookies",
  "browser_set_cookie",
  "browser_storage",
  "browser_downloads",
  "browser_emulate",
  "browser_proxy",
  "browser_page_tools",
  "browser_list_tabs",
  "browser_new_tab",
  "browser_switch_tab",
  "browser_select_tab",
  "browser_close_tab",
  "browser_net_policy",
] as const;

export type BrowserCommand = (typeof BROWSER_COMMANDS)[number];

const COMMAND_SET: ReadonlySet<string> = new Set(BROWSER_COMMANDS);

/** Runtime narrowing for an envelope's `type`, so dispatch needs no cast on the key. */
export function isBrowserCommand(type: string): type is BrowserCommand {
  return COMMAND_SET.has(type);
}

/**
 * Added by the relay (`src/relay/relay.ts`) to every command it forwards, naming
 * the tab that controller is driving. Absent when the controller drives whatever
 * tab this browser resolves on its own.
 */
export interface RelayTabHint {
  __bmcpTabId?: number;
}

export interface BrowserCommandMap {
  browser_wait: {
    time: number;
  };
  browser_snapshot: {
    verbose?: boolean | undefined;
  };
  browser_snapshot_full: {
    verbose?: boolean | undefined;
  };
  getUrl: {
    [key: string]: never;
  };
  getTitle: {
    [key: string]: never;
  };
  browser_navigate: {
    url?: string | undefined;
    includeSnapshot?: boolean | undefined;
    reload?: boolean | undefined;
    ignoreCache?: boolean | undefined;
    initScript?: string | undefined;
    handleBeforeUnload?: "accept" | "dismiss" | undefined;
    include?: string | undefined;
    timeout?: number | undefined;
    waitUntil?: "none" | "auto" | "load" | "networkidle" | undefined;
    settleMs?: number | undefined;
  };
  browser_go_back: {
    timeout?: number | undefined;
    waitUntil?: "none" | "auto" | "load" | "networkidle" | undefined;
    settleMs?: number | undefined;
  };
  browser_go_forward: {
    timeout?: number | undefined;
    waitUntil?: "none" | "auto" | "load" | "networkidle" | undefined;
    settleMs?: number | undefined;
  };
  browser_wait_for: {
    selector?: string | undefined;
    text?: string | undefined;
    urlPattern?: string | undefined;
    state?: "visible" | "hidden" | "attached" | "detached" | undefined;
    timeoutMs?: number | undefined;
  };
  browser_press_key: {
    key: string;
    timeout?: number | undefined;
    waitUntil?: "none" | "auto" | "load" | "networkidle" | undefined;
    settleMs?: number | undefined;
  };
  browser_click: {
    includeSnapshot?: boolean | undefined;
    include?: string | undefined;
    timeout?: number | undefined;
    waitUntil?: "none" | "auto" | "load" | "networkidle" | undefined;
    settleMs?: number | undefined;
    element?: string | undefined;
    ref?: string | undefined;
    x?: number | undefined;
    y?: number | undefined;
    dblClick?: boolean | undefined;
    actionability?: boolean | undefined;
  };
  browser_drag: {
    startElement: string;
    startRef: string;
    endElement: string;
    endRef: string;
    includeSnapshot?: boolean | undefined;
    timeout?: number | undefined;
    actionability?: boolean | undefined;
  };
  browser_hover: {
    element: string;
    ref: string;
    includeSnapshot?: boolean | undefined;
    timeout?: number | undefined;
    actionability?: boolean | undefined;
  };
  browser_type: {
    text: string;
    element: string;
    ref: string;
    submit: boolean;
    includeSnapshot?: boolean | undefined;
    include?: string | undefined;
    timeout?: number | undefined;
    waitUntil?: "none" | "auto" | "load" | "networkidle" | undefined;
    settleMs?: number | undefined;
    actionability?: boolean | undefined;
  };
  browser_select_option: {
    values: string[];
    element: string;
    ref: string;
    includeSnapshot?: boolean | undefined;
    timeout?: number | undefined;
    actionability?: boolean | undefined;
  };
  browser_fill_form: {
    fields: Array<{ value: string; ref: string }>;
    timeout?: number | undefined;
  };
  browser_clear: {
    ref: string;
    timeout?: number | undefined;
  };
  browser_scroll: {
    timeout?: number | undefined;
    ref?: string | undefined;
    to?: "top" | "bottom" | undefined;
    dx?: number | undefined;
    dy?: number | undefined;
  };
  browser_handle_dialog: {
    action?: "accept" | "dismiss" | "native" | undefined;
    promptText?: string | undefined;
  };
  browser_upload_file: {
    ref: string;
    filePaths: string[];
    keepEnabled?: boolean | undefined;
  };
  browser_read_page: {
    format?: "text" | "markdown" | undefined;
    maxLength?: number | undefined;
  };
  browser_get_html: {
    ref?: string | undefined;
    maxLength?: number | undefined;
  };
  browser_find: {
    selector?: string | undefined;
    text?: string | undefined;
    role?: string | undefined;
    max?: number | undefined;
  };
  browser_eval: {
    function?: string | undefined;
    timeout?: number | undefined;
    expression?: string | undefined;
    args?: string[] | undefined;
    filePath?: string | undefined;
    dialogAction?: "accept" | "dismiss" | undefined;
  };
  browser_screenshot: {
    ref?: string | undefined;
    keepEnabled?: boolean | undefined;
    format?: "png" | "jpeg" | "webp" | undefined;
    filePath?: string | undefined;
    quality?: number | undefined;
    fullPage?: boolean | undefined;
    frames?: number | undefined;
    intervalMs?: number | undefined;
    maxWidth?: number | undefined;
    maxHeight?: number | undefined;
    forceCdp?: boolean | undefined;
  };
  browser_get_console_logs: {
    includePreserved?: boolean | undefined;
  };
  browser_issues: {
    page?: number | undefined;
    limit?: number | undefined;
    audit?: "a11y" | undefined;
  };
  browser_network_requests: {
    includePreserved?: boolean | undefined;
    page?: number | undefined;
    limit?: number | undefined;
    resourceTypes?: string[] | undefined;
  };
  browser_get_network_request: {
    url?: string | undefined;
    keepEnabled?: boolean | undefined;
    maxLength?: number | undefined;
    requestId?: string | undefined;
    revealValues?: boolean | undefined;
  };
  browser_perf_trace: {
    reload?: boolean | undefined;
    categories?: string[] | undefined;
    autoStop?: boolean | undefined;
    durationMs?: number | undefined;
    action: "start" | "stop" | "memory";
  };
  browser_advanced_mode: {
    enable?: boolean | undefined;
  };
  browser_get_cookies: {
    name?: string | undefined;
    revealValues?: boolean | undefined;
  };
  browser_set_cookie: {
    name: string;
    value: string;
    path?: string | undefined;
    secure?: boolean | undefined;
    httpOnly?: boolean | undefined;
    expirationDate?: number | undefined;
    sameSite?: "strict" | "no_restriction" | "lax" | undefined;
  };
  browser_storage: {
    action: "set" | "get" | "remove" | "clear";
    value?: string | undefined;
    key?: string | undefined;
    revealValues?: boolean | undefined;
    area?: "local" | "session" | undefined;
  };
  browser_downloads: {
    timeout?: number | undefined;
    limit?: number | undefined;
    wait?: boolean | undefined;
  };
  browser_emulate: {
    clear?: string[] | undefined;
    geolocation?: number[] | undefined;
    headers?: undefined | { [key: string]: string };
    colorScheme?: "light" | "dark" | undefined;
    viewport?: number[] | undefined;
    mobile?: boolean | undefined;
    userAgent?: string | undefined;
    network?: "offline" | "slow-3g" | "fast-3g" | "slow-4g" | undefined;
    cpuThrottling?: number | undefined;
  };
  browser_proxy: {
    clear?: boolean | undefined;
    mode?: "direct" | "system" | "auto_detect" | "fixed_servers" | "pac_script" | undefined;
    server?: string | undefined;
    pacUrl?: string | undefined;
    bypass?: string[] | undefined;
  };
  browser_page_tools: {
    action: "list" | "call";
    name?: string | undefined;
    args?: string | undefined;
  };
  browser_list_tabs: {
    [key: string]: never;
  };
  browser_new_tab: {
    active: boolean;
    url?: string | undefined;
    incognito?: boolean | undefined;
  };
  browser_switch_tab: {
    tabId?: number | undefined;
    index?: number | undefined;
  };
  browser_select_tab: {
    url?: string | undefined;
    tabId?: number | undefined;
    index?: number | undefined;
    title?: string | undefined;
  };
  browser_close_tab: {
    tabId?: number | undefined;
    index?: number | undefined;
  };
  browser_net_policy: {
    deny: string[];
    owner?: string | undefined;
  };
}

/** What a handler for `K` actually receives: the payload plus the relay's tab hint. */
export type CommandPayload<K extends BrowserCommand> = BrowserCommandMap[K] & RelayTabHint;
