import { accessSync, constants, mkdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { debugLog } from "./log";

/**
 * Filesystem sandbox for tool params that name a local path (`browser_upload_file`,
 * `browser_perf_trace`). Without it an agent can make the user's real, logged-in
 * browser upload `~/.ssh/id_rsa` to any site.
 *
 * Roots come from the MCP client's `roots` capability (negotiated in `server.ts`),
 * plus anything named in `AUTOMATE_BROWSER_WORKSPACE`. When a client offers none
 * we fall back to cwd + tmpdir — never to allow-all.
 */

export type PathMode = "read" | "write";

/** MCP-negotiated roots. `null` = never negotiated (or negotiated empty) ⇒ fallback. */
let negotiatedRoots: string[] | null = null;

const isWin = process.platform === "win32";

/** Case-fold only where the filesystem is case-insensitive. */
function fold(p: string): string {
  return isWin ? p.toLowerCase() : p;
}

/**
 * realpath the nearest *existing* ancestor and re-attach the missing tail, so a
 * write target that does not exist yet still has its symlinks/junctions resolved.
 */
function realpathNearest(abs: string): string {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // reached the filesystem root; nothing resolved
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** Accepts MCP `Root` objects (`file://` URIs) as well as plain paths. */
function toPath(root: string | { uri: string }): string | undefined {
  const raw = typeof root === "string" ? root : root?.uri;
  if (!raw) return undefined;
  try {
    return raw.startsWith("file:") ? fileURLToPath(raw) : raw;
  } catch {
    return undefined;
  }
}

export function setRoots(roots: ReadonlyArray<string | { uri: string }> | null | undefined): void {
  const resolved = (roots ?? [])
    .map(toPath)
    .filter((p): p is string => Boolean(p))
    .map((p) => realpathNearest(resolve(p)));
  negotiatedRoots = resolved.length > 0 ? resolved : null;
  logRootSources();
}

/**
 * Extra roots named by the user in `AUTOMATE_BROWSER_WORKSPACE`, one or more
 * directories separated by the platform's path delimiter (`;` on Windows, `:`
 * elsewhere) — the same convention as `PATH`.
 *
 * WHY: several MCP clients never send roots, so before this there was no way to
 * say "also allow my project folder" without the allow-everything env var. These
 * ADD to whatever the client negotiated; they never replace it.
 *
 * Blank segments are dropped, so an empty or whitespace-only value contributes
 * nothing. That is the security property: the variable can widen the sandbox to
 * named directories and to nothing else — never to allow-all, and never by
 * accident from an env var that happens to be set to "".
 *
 * Not cached: it is a couple of `realpath` calls next to the ones this list
 * already makes for cwd and tmpdir, and re-reading means a test (or a future
 * reload) sees the current value rather than the one at import time.
 */
function workspaceRoots(): string[] {
  return (process.env.AUTOMATE_BROWSER_WORKSPACE ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((p) => realpathNearest(resolve(p)));
}

/** The effective allow-list. tmpdir is always in it so the default trace path works. */
export function getAllowedRoots(): string[] {
  const base = negotiatedRoots ?? [process.cwd()];
  const all = [...base, ...workspaceRoots(), tmpdir()].map((p) => realpathNearest(resolve(p)));
  return [...new Set(all)];
}

/**
 * Log the effective allow-list with the origin of each root.
 *
 * A refused path names the roots it would have accepted, but not where they came
 * from — so "why is my folder not in there?" (client sent none? variable
 * misspelled? separator wrong?) was undiagnosable without this line. Called at
 * startup and again whenever the client's roots change.
 */
export function logRootSources(): void {
  const fromClient = new Set((negotiatedRoots ?? []).map(fold));
  const fromWorkspace = new Set(workspaceRoots().map(fold));
  const tmp = fold(realpathNearest(resolve(tmpdir())));

  const described = getAllowedRoots().map((root) => {
    const key = fold(root);
    const source = fromClient.has(key)
      ? "MCP client roots"
      : fromWorkspace.has(key)
        ? "AUTOMATE_BROWSER_WORKSPACE"
        : key === tmp
          ? "temp directory"
          : "working directory (no client roots)";
    return `${root} [${source}]`;
  });

  debugLog(`path sandbox: ${described.length} root(s) in force — ${described.join("; ")}`);
}

function contains(root: string, target: string): boolean {
  const rel = relative(fold(root), fold(target));
  // `rel.startsWith("..")` alone would also reject a legitimate child named `..foo`.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Preflight a `write` target: ensure its parent directory exists and is
 * writable, and that the target itself is not a directory or a read-only file.
 *
 * The point is *when* this runs, not what it checks. `browser_perf_trace` can
 * record for a minute before it writes; without this the agent discovers a bad
 * `filePath` only after all that work is thrown away. Called from the same
 * choke point as containment, so every `write` param gets it for free.
 *
 * Creating the directory is deliberate: containment has already proven the path
 * is inside an allowed root, so `{filePath: "traces/run1.json"}` should just
 * work rather than making the agent guess that `traces/` must exist first.
 */
function assertWritable(original: string, target: string): void {
  const dir = dirname(target);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    throw new Error(
      `Cannot write to "${original}": its directory "${dir}" could not be created (${code}).`,
      { cause: err },
    );
  }

  // A missing target is the normal case for a write, so ask without throwing.
  const stat = statSync(target, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    throw new Error(
      `Cannot write to "${original}": "${target}" is an existing directory, not a file.`,
    );
  }

  // A new file only needs a writable parent; an existing one must itself be writable.
  const probe = stat ? target : dir;
  try {
    // ponytail: accessSync does not evaluate ACLs on win32, so a denied directory
    // can still reach the tool — the tool's own write then fails naming the same
    // path. Upgrade to a probe-file write only if that turns out to matter.
    accessSync(probe, constants.W_OK);
  } catch {
    throw new Error(`Cannot write to "${original}": "${probe}" is not writable.`);
  }
}

/**
 * Resolve `p` and assert it is inside an allowed root. Returns the resolved,
 * symlink-free absolute path; throws an Error naming the roots if it is not.
 */
export function assertPathAllowed(p: unknown, mode: PathMode): string {
  if (typeof p !== "string" || p.trim() === "") {
    throw new Error(`Invalid file path: expected a non-empty string, got ${JSON.stringify(p)}`);
  }

  const target = realpathNearest(resolve(p));

  if (process.env.AUTOMATE_BROWSER_ALLOW_UNRESTRICTED_PATHS === "1") {
    debugLog(
      `SECURITY: path sandbox bypassed via AUTOMATE_BROWSER_ALLOW_UNRESTRICTED_PATHS=1 (${mode}: ${target})`,
    );
  } else {
    const roots = getAllowedRoots();
    if (!roots.some((root) => contains(root, target))) {
      throw new Error(
        `Path not allowed for ${mode}: "${p}" resolves to "${target}", which is outside the allowed roots. ` +
          `Allowed roots: ${roots.map((r) => `"${r}"`).join(", ")}.`,
      );
    }
  }

  // Containment decided; now make sure a write can actually land (C15b).
  if (mode === "write") assertWritable(p, target);

  return target;
}
