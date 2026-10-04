/**
 * Every environment variable this server reads, in one place (plan 09, D13).
 *
 * WHY THIS FILE EXISTS. The README's Configuration table was maintained by hand
 * while the tool tables have been generated from live schemas since C22 — and the
 * hand-maintained half is the half that rots. It rotted before this file was
 * written: `AUTOMATE_BROWSER_PORT` was read in the vendored config, documented
 * nowhere, and wired to nothing at all.
 *
 * WHAT IT IS NOT. This is a DECLARATION, not a reader. Nothing here parses a
 * value or supplies a default at run time — each variable is still read where it
 * is used, by code that knows what the value means. Routing thirty reads through
 * one accessor would be a large refactor to buy a smaller property than the one
 * that actually matters, which is: the documentation cannot disagree with the
 * code, because `npm run docs:generate` writes the table from this list and exits
 * 1 when the two sets differ in either direction.
 *
 * So it is never imported by the server and never reaches the bundle. It costs
 * nothing at run time and nothing in the tool-schema token budget.
 *
 * ADDING A VARIABLE: add its entry here in the same task that adds the read, then
 * run `npm run docs:generate`. Skipping the entry fails the gate by name.
 */

export interface EnvVar {
  /** The variable, exactly as it is read. */
  name: string;
  /** One line, in the user's terms. Markdown is allowed; a `|` will be escaped. */
  purpose: string;
  /** What happens with it unset. Prose, not a value — "unset" is a real answer. */
  default: string;
  /**
   * Set by the server for its own child processes, not by a user. Kept in the
   * list so the completeness gate still sees it, kept OUT of the README table
   * because documenting it would invite someone to set it by hand.
   */
  internal?: boolean;
}

/**
 * Order is the order the README table renders in: connection and identity first,
 * then behaviour, then the safety switches, then the two integrations.
 */
export const ENV_VARS: readonly EnvVar[] = [
  {
    name: "AUTOMATE_BROWSER_CLIENT_NAME",
    purpose: "Human name for this IDE in the relay roster",
    default: "`mcp-<pid>` (CLI: `cli`)",
  },
  {
    name: "AUTOMATE_BROWSER_TOKEN",
    purpose: "Optional auth token (set the same value in the extension popup)",
    default: "unset",
  },
  {
    name: "AUTOMATE_BROWSER_TOOLS",
    purpose: "Tool profile (`full`, `core`, `slim`) or a comma-separated category list",
    default: "`full`",
  },
  {
    name: "AUTOMATE_BROWSER_CONNECT_WAIT_MS",
    purpose: "How long a tool waits for a browser to appear",
    default: "`30000`",
  },
  {
    name: "AUTOMATE_BROWSER_LEASE_TTL_MS",
    purpose: "Soft-claim lease duration",
    default: "`60000`",
  },
  {
    name: "AUTOMATE_BROWSER_INSTANCE_ID",
    purpose: "Identity used to replace this agent's own previous roster entry when it restarts",
    default: "derived from parent process + folder",
  },
  {
    name: "AUTOMATE_BROWSER_CONTROLLER_STALE_MS",
    purpose: "Drop an agent that has sent nothing for this long",
    default: "`45000`",
  },
  {
    name: "AUTOMATE_BROWSER_WS_PORT_RANGE",
    purpose: "Port scan range (e.g. `9109-9116` to isolate)",
    default: "`9009-9013`",
  },
  {
    name: "AUTOMATE_BROWSER_RELAY_IDLE_MS",
    purpose: "Idle time before the relay exits",
    default: "`300000`",
  },
  {
    name: "AUTOMATE_BROWSER_RELAY_HOST",
    purpose:
      "Bind the relay past loopback so a browser on **another machine** can connect. Refuses to start without `AUTOMATE_BROWSER_TOKEN`",
    default: "`127.0.0.1`",
  },
  {
    name: "AUTOMATE_BROWSER_RELAY_FOREGROUND",
    purpose: "`1` also tees the relay's log to stderr instead of the file only",
    default: "unset",
  },
  {
    name: "AUTOMATE_BROWSER_RELAY_VERSION",
    purpose:
      "The controller's version, passed to the relay it spawns so a mismatch can be reported",
    default: "the spawning controller's version",
    internal: true,
  },
  {
    name: "AUTOMATE_BROWSER_SNAPSHOT_EACH_ACTION",
    purpose: "Bundle a snapshot after every interaction",
    default: "unset",
  },
  {
    name: "AUTOMATE_BROWSER_STRUCTURED",
    purpose:
      "`1` also sends each result's `structuredContent` and lists output schemas, for scripts. " +
      "Leave off for agents: Claude Code then shows only that data and hides the written reply",
    default: "unset (written reply only)",
  },
  {
    name: "AUTOMATE_BROWSER_DELTA_FOOTER",
    purpose: "`off` disables the console-error footer below",
    default: "on",
  },
  {
    name: "AUTOMATE_BROWSER_DELTA_FOOTER_MS",
    purpose: "Hard ceiling on the footer's console probe",
    default: "`2000`",
  },
  {
    name: "AUTOMATE_BROWSER_NAV_CONFIRM_MS",
    purpose:
      "How long a navigation that reported no movement is re-checked before it is called a failure",
    default: "`2000`",
  },
  {
    name: "AUTOMATE_BROWSER_SCREENSHOT_MAX_WIDTH",
    purpose:
      "Widest an **inline** screenshot may come back. A `filePath` capture is never downscaled; `0` = off",
    default: "`1536`",
  },
  {
    name: "AUTOMATE_BROWSER_SCREENSHOT_MAX_HEIGHT",
    purpose: "Tallest an **inline** screenshot may come back, aspect ratio preserved; `0` = off",
    default: "`4096`",
  },
  {
    name: "AUTOMATE_BROWSER_ACTIONABILITY",
    purpose: "`off` disables the pre-action checks and post-action settle below",
    default: "on",
  },
  {
    name: "AUTOMATE_BROWSER_WS_MAX_PAYLOAD_BYTES",
    purpose:
      "Max WebSocket frame size. A whole Chrome trace is never under 1 MiB, and an oversized frame closes the socket rather than truncating",
    default: "`67108864` (64 MiB)",
  },
  {
    name: "AUTOMATE_BROWSER_WS_RATE_MAX",
    purpose: "Frames one socket may send per window before it is closed",
    default: "`120`",
  },
  {
    name: "AUTOMATE_BROWSER_WS_RATE_WINDOW_MS",
    purpose: "The window that ceiling is counted over",
    default: "`1000`",
  },
  {
    name: "AUTOMATE_BROWSER_EXTENSION_ORIGINS",
    purpose: "Comma-separated browser-extension origins allowed to open a socket",
    default: "any `chrome-extension://` origin",
  },
  {
    name: "AUTOMATE_BROWSER_LOG_LEVEL",
    purpose: "`debug`, `info`, `warn` or `error`. Diagnostics go to stderr, never stdout",
    default: "`info`",
  },
  {
    name: "AUTOMATE_BROWSER_WORKSPACE",
    purpose:
      "Extra folders the file-path sandbox accepts, `;`-separated on Windows and `:`-separated elsewhere. Adds to the roots your client sends; never replaces them",
    default: "unset (client roots, or the working directory when it sends none)",
  },
  {
    name: "AUTOMATE_BROWSER_ALLOW_UNRESTRICTED_PATHS",
    purpose: "`1` disables the file-path sandbox below",
    default: "unset",
  },
  {
    name: "AUTOMATE_BROWSER_ALLOW_ORIGINS",
    purpose: "Comma-separated origin patterns; when set, **only** these may be driven",
    default: "unset (unrestricted)",
  },
  {
    name: "AUTOMATE_BROWSER_DENY_ORIGINS",
    purpose: "Origins that may never be driven, also blocked at the network layer",
    default: "unset",
  },
  {
    name: "AUTOMATE_BROWSER_SENSITIVE_ORIGINS",
    purpose: "Origins that stay readable but can never be acted on",
    default: "unset",
  },
  {
    name: "AUTOMATE_BROWSER_READ_ONLY",
    purpose: "`1` refuses every page-changing tool, everywhere",
    default: "unset",
  },
  {
    name: "AUTOMATE_BROWSER_NO_EVAL",
    purpose:
      "`1` refuses every tool that runs JavaScript you wrote — `browser_eval` and `browser_navigate`'s `initScript`",
    default: "unset",
  },
  {
    name: "AUTOMATE_BROWSER_AUDIT",
    purpose: "`off` stops the action audit log below",
    default: "on",
  },
  {
    name: "AUTOMATE_BROWSER_AUDIT_FILE",
    purpose: "Where the audit trail is written",
    default: "`~/.automate-browser/automate-browser-audit.log`",
  },
  {
    name: "AUTOMATE_BROWSER_NO_UPDATE_CHECK",
    purpose: "Any value stops the daily check for a newer release below",
    default: "unset (check runs)",
  },
  {
    name: "AUTOMATE_BROWSER_CRUX_KEY",
    purpose: "Google Chrome UX Report API key; `browser_perf_field_data` is inert without it",
    default: "unset",
  },
];
