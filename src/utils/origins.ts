/**
 * Origin allow/deny, read-only mode and the sensitive tier (roadmap B9).
 *
 * The extension holds `<all_urls>` + `debugger` + `cookies`, and `browser_eval`
 * runs arbitrary JS in a real, logged-in browser. Stage 1 closed the file-path
 * hole and said plainly that this one was still open — this is that item.
 *
 * EVERYTHING HERE IS OFF UNLESS CONFIGURED. With none of the four env vars set,
 * `policy()` returns undefined and not one extra byte crosses the wire, so
 * today's frictionless default is exactly today's frictionless default.
 *
 * Read `docs/` — and the README's Safety section — for what this does NOT
 * protect against. The short version: it decides WHICH ORIGINS the agent may
 * touch, never what it may do once it is on one.
 */

export const ALLOW_ENV = "AUTOMATE_BROWSER_ALLOW_ORIGINS";
export const DENY_ENV = "AUTOMATE_BROWSER_DENY_ORIGINS";
export const SENSITIVE_ENV = "AUTOMATE_BROWSER_SENSITIVE_ORIGINS";
export const READ_ONLY_ENV = "AUTOMATE_BROWSER_READ_ONLY";
export const NO_EVAL_ENV = "AUTOMATE_BROWSER_NO_EVAL";

export interface OriginPolicy {
  /** When non-empty, ONLY these origins may be driven. */
  allow: string[];
  /** Never driveable. Wins over `allow`, and is also pushed to the network layer. */
  deny: string[];
  /** Readable, never mutated — "look, don't touch". */
  sensitive: string[];
  /** Every mutating tool is refused, everywhere. */
  readOnly: boolean;
  /** No tool may run JavaScript the agent wrote. See `evalRefusal`. */
  noEval: boolean;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function truthy(name: string): boolean {
  const v = (process.env[name] ?? "").toLowerCase();
  return v === "1" || v === "on" || v === "true" || v === "yes";
}

let cached: OriginPolicy | null | undefined;

/** The policy this process enforces, or `undefined` when nothing is configured. */
export function policy(): OriginPolicy | undefined {
  if (cached === undefined) {
    const p: OriginPolicy = {
      allow: list(ALLOW_ENV),
      deny: list(DENY_ENV),
      sensitive: list(SENSITIVE_ENV),
      readOnly: truthy(READ_ONLY_ENV),
      noEval: truthy(NO_EVAL_ENV),
    };
    cached =
      p.allow.length || p.deny.length || p.sensitive.length || p.readOnly || p.noEval ? p : null;
  }
  return cached ?? undefined;
}

/** Tests only — the env is read once per process in real use. */
export function resetPolicyCache(): void {
  cached = undefined;
}

/**
 * A pattern is an origin with `*` wildcards: `https://*.example.com`,
 * `http://localhost:*`, or a bare host (`example.com`) meaning any scheme.
 *
 * Matched by scanning, not by a compiled RegExp: the value is always an ORIGIN
 * (scheme + host + optional port, never a path), so there is nothing for a
 * greedy `*` to over-reach into — and a hand-built RegExp source is one missed
 * escape away from a pattern that matches more than the operator wrote.
 */
function globMatch(pattern: string, value: string): boolean {
  const parts = pattern.toLowerCase().split("*");
  const v = value.toLowerCase();
  if (parts.length === 1) return parts[0] === v;
  const head = parts[0];
  const tail = parts[parts.length - 1];
  if (!v.startsWith(head) || !v.endsWith(tail)) return false;
  let i = head.length;
  for (const seg of parts.slice(1, -1)) {
    const at = v.indexOf(seg, i);
    if (at < 0) return false;
    i = at + seg.length;
  }
  return i <= v.length - tail.length;
}

/** `https://example.com:8443` for any http(s) URL; undefined for anything else. */
export function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return undefined;
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

export function matchesAny(origin: string, patterns: string[]): boolean {
  return patterns.some((p) => globMatch(p.includes("://") ? p : `*://${p}`, origin));
}

/**
 * Hostnames for the network-layer half. `chrome.declarativeNetRequest` matches
 * by DOMAIN — no scheme, no port, subdomains always included — so this is
 * deliberately BROADER than the tool gate. A network block that silently missed
 * half the requests would be worse than none.
 */
export function denyDomains(patterns: string[]): string[] {
  const out = new Set<string>();
  for (const p of patterns) {
    const host = (p.includes("://") ? p.split("://")[1] : p).split("/")[0];
    const bare = host.split(":")[0].replace(/^\*\./, "").replace(/^\*$/, "");
    if (bare && !bare.includes("*")) out.add(bare.toLowerCase());
  }
  return [...out];
}

/**
 * D16 — every way an agent gets JavaScript IT WROTE into the page. `true` means
 * the whole tool is that; a parameter name means only that argument is, so the
 * tool keeps working without it.
 *
 * Audited across the whole registry rather than assumed: nothing else takes
 * source. The two near-misses are deliberate exclusions. `browser_page_tools`
 * calls code the PAGE declared about itself — the page's own script, which runs
 * whether an agent invokes it or not. `browser_proxy {mode:"pac_script"}` points
 * at a PAC URL rather than carrying source, and a PAC file runs in Chrome's
 * proxy resolver, which sees hostnames and no page at all.
 */
const EVAL_PATHS: Record<string, true | string> = {
  browser_eval: true,
  browser_navigate: "initScript",
};

/**
 * Why this call is refused under `NO_EVAL_ENV`, or undefined to let it through.
 *
 * Keyed on the PARAMETER and not merely the tool, because a switch with a hole
 * in it is worse than no switch: forbidding `browser_eval` while leaving
 * `browser_navigate {initScript}` open would bar the door and leave the window.
 * By the same token it refuses only the argument, so a plain navigation is still
 * a plain navigation.
 */
export function evalRefusal(tool: string, args?: Record<string, unknown>): string | undefined {
  const path = EVAL_PATHS[tool];
  if (!path) return undefined;
  const set = `${NO_EVAL_ENV} is set in this server's environment, by whoever configured it`;
  if (path === true) {
    return (
      `running JavaScript you wrote is off: ${set}. Clicking, typing, reading and ` +
      `screenshots are unaffected; use those to check the page instead.`
    );
  }
  if (!String(args?.[path] ?? "").trim()) return undefined;
  return (
    `\`${path}\` runs JavaScript you wrote before the page's own, and ${set}. ` +
    `Drop \`${path}\` and the rest of this call is allowed.`
  );
}

export type Verdict = { ok: true } | { ok: false; message: string };

/**
 * Why a page-changing call is refused under `READ_ONLY_ENV`, or undefined.
 *
 * Split out of `judge` for exactly the reason `evalRefusal` is separate: the
 * answer does not depend on WHERE the tab is, so the call path can settle it
 * before paying for an origin probe — and, more importantly, before the two
 * shortcuts that skip the probe entirely (no browser connected yet; a probe that
 * threw with only a deny-list configured). Both of those used to return past the
 * read-only rule, because the rule lived only inside `judge` and `judge` was
 * never reached. A switch with a hole in it is worse than no switch.
 *
 * `judge` still applies it, so a verdict is correct when it is asked for alone —
 * but it asks THIS function, so there is one sentence and not two.
 */
export function readOnlyRefusal(p: OriginPolicy, mutating: boolean): string | undefined {
  if (!p.readOnly || !mutating) return undefined;
  return `read-only mode is on (${READ_ONLY_ENV}); this tool changes the page. Unset it to allow mutating tools.`;
}

/**
 * Judge one call. `url` is where the tool will act — its destination when it
 * takes one, otherwise the tab it is already on.
 *
 * A non-http(s) URL (`chrome://`, `about:blank`, a file) has no origin to judge.
 * With an allow-list set that is a refusal, not a pass: "I could not tell where
 * this was going" must never resolve to "go ahead".
 */
export function judge(p: OriginPolicy, url: string | undefined, mutating: boolean): Verdict {
  const readOnly = readOnlyRefusal(p, mutating);
  if (readOnly) return { ok: false, message: readOnly };

  const origin = url ? originOf(url) : undefined;
  if (!origin) {
    if (p.allow.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        `${url ? `"${url}"` : "the target"} has no http(s) origin to check against ` +
        `${ALLOW_ENV}="${p.allow.join(",")}". Navigate to an allowed origin first.`,
    };
  }

  if (matchesAny(origin, p.deny)) {
    return {
      ok: false,
      message: `${origin} is denied by ${DENY_ENV}="${p.deny.join(",")}".`,
    };
  }
  if (p.allow.length > 0 && !matchesAny(origin, p.allow)) {
    return {
      ok: false,
      message: `${origin} is not in ${ALLOW_ENV}="${p.allow.join(",")}".`,
    };
  }
  if (mutating && matchesAny(origin, p.sensitive)) {
    return {
      ok: false,
      message:
        `${origin} is listed in ${SENSITIVE_ENV}="${p.sensitive.join(",")}" — ` +
        `readable, but not driveable. Remove it from that list to act on it.`,
    };
  }
  return { ok: true };
}

/** One line for `browser_status`, or undefined when nothing is configured. */
export function describePolicy(): string | undefined {
  const p = policy();
  if (!p) return undefined;
  const parts = [
    p.readOnly ? "read-only" : undefined,
    p.noEval ? "no-eval" : undefined,
    p.allow.length ? `allow=${p.allow.join(" ")}` : undefined,
    p.deny.length ? `deny=${p.deny.join(" ")}` : undefined,
    p.sensitive.length ? `sensitive=${p.sensitive.join(" ")}` : undefined,
  ].filter(Boolean);
  return `safety: ${parts.join(" · ")}`;
}
