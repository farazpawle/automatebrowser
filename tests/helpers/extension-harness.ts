/**
 * Runs CURRENT extension source inside the Node-only test process.
 *
 * The two packages do not share a toolchain: `tsconfig.test.json` has Node types
 * and no `chrome`, and the extension has `chrome` and no Node — so `tests/`
 * cannot import `Chrome-extension/` and typecheck. The tempting way round that is
 * to copy the implementation into the test, which is how a suite ends up proving
 * that its own copy still works long after the shipped file stopped.
 *
 * So: transpile the real file with the installed TypeScript compiler and execute
 * it in a `node:vm` context whose globals and imports are whatever the test says
 * they are. It type-ERASES rather than type-checks, which is the right division —
 * `Chrome-extension`'s own `npm run compile` is what checks those types, and this
 * only has to run the behaviour.
 *
 * Each load is a fresh module graph, so two loads in one file cannot share state,
 * and `dispose()` clears whatever timers the module left running.
 */
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface LoadOptions {
  /** Globals the module sees — `chrome`, typically. Added to the vm context. */
  globals?: Record<string, unknown>;
  /**
   * Stand-ins for imports, keyed by the specifier exactly as the source writes
   * it (`"./run-func"`). Anything not named here is loaded from real source.
   */
  mocks?: Record<string, Record<string, unknown>>;
}

export interface Loaded<T> {
  exports: T;
  /** Clear timers the module scheduled, so the test process can exit. */
  dispose(): void;
}

/**
 * Load one extension module by its repo-relative path
 * (`"Chrome-extension/lib/automation/net-policy.ts"`).
 */
export function loadExtensionModule<T = Record<string, unknown>>(
  relPath: string,
  options: LoadOptions = {},
): Loaded<T> {
  const timers = new Set<NodeJS.Timeout>();
  const track = <A extends unknown[]>(
    fn: (cb: () => void, ms?: number, ...rest: A) => NodeJS.Timeout,
  ) => {
    return (cb: () => void, ms?: number, ...rest: A): NodeJS.Timeout => {
      const handle = fn(cb, ms, ...rest);
      timers.add(handle);
      return handle;
    };
  };

  const sandbox: Record<string, unknown> = {
    console,
    URL,
    TextEncoder,
    TextDecoder,
    setTimeout: track(setTimeout),
    setInterval: track(setInterval),
    clearTimeout: (h: NodeJS.Timeout) => {
      timers.delete(h);
      clearTimeout(h);
    },
    clearInterval: (h: NodeJS.Timeout) => {
      timers.delete(h);
      clearInterval(h);
    },
    ...(options.globals ?? {}),
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  // Per LOAD, not per process: a cache shared across loads is exactly the state
  // leak `dispose()` and the isolation test exist to rule out.
  const loaded = new Map<string, Record<string, unknown>>();

  const load = (absPath: string): Record<string, unknown> => {
    const cached = loaded.get(absPath);
    if (cached) return cached;
    const source = readFileSync(absPath, "utf8");
    const js = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: absPath,
    }).outputText;

    const moduleExports: Record<string, unknown> = {};
    loaded.set(absPath, moduleExports);
    const require = (specifier: string): Record<string, unknown> => {
      const mock = options.mocks?.[specifier];
      if (mock) return mock;
      if (!specifier.startsWith(".")) {
        throw new Error(
          `${relPath} imports "${specifier}"; pass it in \`mocks\` — this harness ` +
            `resolves relative source only, never node_modules.`,
        );
      }
      const base = resolve(dirname(absPath), specifier);
      return load(extname(base) ? base : `${base}.ts`);
    };

    const fn = vm.runInContext(
      `(function (exports, module, require, __filename, __dirname) { ${js}\n})`,
      context,
      { filename: absPath },
    ) as (
      exports: Record<string, unknown>,
      module: { exports: Record<string, unknown> },
      require: (s: string) => Record<string, unknown>,
      filename: string,
      dirname: string,
    ) => void;
    const mod = { exports: moduleExports };
    fn(moduleExports, mod, require, absPath, dirname(absPath));
    // A module that assigned `module.exports` wholesale replaced the object we
    // cached; hand back what it actually produced.
    if (mod.exports !== moduleExports) loaded.set(absPath, mod.exports);
    return mod.exports;
  };

  return {
    exports: load(resolve(ROOT, relPath)) as T,
    dispose: () => {
      for (const handle of timers) {
        clearTimeout(handle);
        clearInterval(handle);
      }
      timers.clear();
    },
  };
}

/**
 * A `chrome` double covering the slices these suites drive. Every call is
 * recorded, so a test asserts what the module DID rather than what it returned.
 */
export interface ChromeMock {
  chrome: Record<string, unknown>;
  /** Dynamic rules currently installed, in id order. */
  rules(): Array<{ id: number; condition?: { requestDomains?: string[] } }>;
  /** Every `updateDynamicRules` argument, in order. */
  updates: Array<{ removeRuleIds?: number[]; addRules?: Array<{ id: number }> }>;
  /** Backing store for `chrome.storage.session`. */
  session: Record<string, unknown>;
}

export function chromeMock(
  options: {
    /** Rules already present, including any outside our reserved band. */
    rules?: Array<{ id: number; condition?: { requestDomains?: string[] } }>;
    /** Drop the API entirely, the way an extension predating the permission does. */
    noDeclarativeNetRequest?: boolean;
    /** Make `storage.session` throw, the way a missing permission does. */
    brokenStorage?: boolean;
  } = {},
): ChromeMock {
  let rules = [...(options.rules ?? [])];
  const updates: ChromeMock["updates"] = [];
  const session: Record<string, unknown> = {};

  const storage = {
    session: {
      get: async (key: string) => {
        if (options.brokenStorage) throw new Error("storage unavailable");
        return key in session ? { [key]: session[key] } : {};
      },
      set: async (entries: Record<string, unknown>) => {
        if (options.brokenStorage) throw new Error("storage unavailable");
        Object.assign(session, structuredClone(entries));
      },
    },
  };

  const declarativeNetRequest = {
    getDynamicRules: async () => rules.map((r) => structuredClone(r)),
    updateDynamicRules: async (arg: {
      removeRuleIds?: number[];
      addRules?: Array<{ id: number; condition?: { requestDomains?: string[] } }>;
    }) => {
      updates.push(structuredClone(arg));
      const removed = new Set(arg.removeRuleIds ?? []);
      rules = [...rules.filter((r) => !removed.has(r.id)), ...(arg.addRules ?? [])].sort(
        (a, b) => a.id - b.id,
      );
    },
  };

  return {
    chrome: {
      storage,
      ...(options.noDeclarativeNetRequest ? {} : { declarativeNetRequest }),
    },
    rules: () => rules.map((r) => structuredClone(r)),
    updates,
    session,
  };
}
