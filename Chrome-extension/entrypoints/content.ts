/**
 * MAIN-world content script that captures console output and uncaught errors
 * into a ring buffer on `window.__bmcpLogs`. `browser_get_console_logs` reads it
 * back via `chrome.scripting.executeScript({ world: "MAIN" })`.
 *
 * It runs at document_start so it patches console before the page logs anything.
 * MAIN world is required so we observe the page's real console (not the isolated
 * world's); this script therefore uses no chrome.* APIs.
 */
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    const w = window as any;
    if (w.__bmcpLogsInstalled) return;
    w.__bmcpLogsInstalled = true;
    const MAX = 500;
    /**
     * One buffer, not two. An uncaught error IS a console error — the page prints
     * it — so splitting it out would either duplicate it or make the chronological
     * console log lie. Instead the entry is ENRICHED: `text` stays byte-identical
     * to what was pushed before (the console-delta footer counts `level:"error"`
     * by `ts`, and must keep working untouched), and `kind`/`stack`/`source` are
     * added beside it so the reader can show WHERE it happened, not just that
     * something spilled. The reading tool renders the stacks in their own section.
     */
    type Entry = {
      /**
       * Per-document sequence number. NOT a timestamp: two entries routinely
       * share a millisecond, so `ts` cannot name one line unambiguously — and
       * naming one line is the whole point ("the error at msgid 42").
       */
      msgid: number;
      level: string;
      ts: number;
      text: string;
      /** Present only on thrown errors: "uncaught" | "unhandledrejection". */
      kind?: string;
      stack?: string;
      /** "file:line:col" when the engine reported one. */
      source?: string;
    };
    const buf: Entry[] = (w.__bmcpLogs = []);
    // Track how many oldest entries the ring buffer discarded, so the reader can
    // tell the agent some early logs are missing instead of silently dropping them.
    const meta: { dropped: number } = (w.__bmcpLogsMeta = { dropped: 0 });

    const fmt = (args: unknown[]): string =>
      args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");

    let seq = 0;
    const push = (
      level: string,
      text: string,
      extra?: Omit<Entry, "msgid" | "level" | "ts" | "text">,
    ) => {
      buf.push({ msgid: ++seq, level, ts: Date.now(), text, ...extra });
      if (buf.length > MAX) {
        buf.shift();
        meta.dropped++;
      }
    };

    const levels = ["log", "info", "warn", "error", "debug"] as const;
    for (const level of levels) {
      const orig = (console as any)[level]?.bind(console);
      (console as any)[level] = (...args: unknown[]) => {
        try {
          push(level, fmt(args));
        } catch {
          /* never break the page */
        }
        orig?.(...args);
      };
    }

    window.addEventListener("error", (e: ErrorEvent) => {
      const source = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined;
      push("error", `${e.message}${source ? ` (${source})` : ""}`, {
        kind: "uncaught",
        // The stack is the whole point: without it the agent knows something
        // spilled but not where, and has to guess its way back to the throw site.
        stack: (e as any).error?.stack,
        source,
      });
    });
    window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
      const reason = (e as any).reason;
      push("error", `Unhandled promise rejection: ${String(reason)}`, {
        kind: "unhandledrejection",
        // A rejection can carry anything; only an Error has a stack worth keeping.
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    });

    // ── Issues feed: what Chrome knows and the console never says ─────────────
    // CSP violations, deprecations, interventions and mixed content produce NO
    // console error in many cases, so an agent sees "the button did nothing" with
    // no path to "your CSP blocked the inline handler". These are separate from
    // __bmcpLogs on purpose: unlike an uncaught error, they were never part of
    // what the page printed, so folding them into the console history would
    // invent output the page never produced.
    type Issue = { source: "page"; kind: string; ts: number; text: string; url?: string };
    const issues: Issue[] = (w.__bmcpIssues = []);
    const issueMeta: { dropped: number } = (w.__bmcpIssuesMeta = { dropped: 0 });
    const pushIssue = (kind: string, text: string, url?: string) => {
      issues.push({ source: "page", kind, ts: Date.now(), text, url });
      if (issues.length > 200) {
        issues.shift();
        issueMeta.dropped++;
      }
    };

    // `buffered: true` replays reports that fired before this observer existed —
    // at document_start that window is small, but a deprecation warning emitted
    // during parsing would otherwise be lost.
    try {
      new (w.ReportingObserver as any)(
        (reports: any[]) => {
          for (const r of reports) {
            try {
              const b = r.body ?? {};
              const text =
                b.message ??
                b.reason ??
                (b.blockedURL ? `Blocked ${b.blockedURL}` : r.type);
              pushIssue(r.type, String(text), r.url);
            } catch {
              /* one malformed report must not stop the rest */
            }
          }
        },
        // NO "csp-violation" here, deliberately. The `securitypolicyviolation`
        // listener below fires for EVERY CSP block in the document, whereas
        // ReportingObserver only sees them when the page configures reporting
        // endpoints — so it is a strict subset, and asking for both meant one
        // blocked script arrived as TWO issues (seen on a real page 2026-08-27).
        // The listener's text is also the richer of the two: it names the
        // directive and the source location.
        { types: ["deprecation", "intervention", "crash"], buffered: true },
      ).observe();
    } catch {
      // ReportingObserver is absent or restricted in some engines/contexts. The
      // rest of the content script — console capture, dialogs — must still install.
    }

    // securitypolicyviolation fires for every CSP block, including the many that
    // ReportingObserver misses when the page sends no Report-To/Reporting-Endpoints.
    try {
      document.addEventListener("securitypolicyviolation", (e: any) => {
        const at = e.sourceFile
          ? ` at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`
          : "";
        pushIssue(
          "csp-violation",
          `CSP blocked ${e.blockedURI || "(inline)"} — violated "${e.violatedDirective}"${at}`,
          e.documentURI,
        );
      });
    } catch {
      /* never break the page */
    }

    // ── service workers: the half of a PWA the console never shows (C7) ───────
    // What this CAN see, with no debugger: a registration that failed, a worker
    // moving through installing → activated → redundant, a controller change,
    // and messages the worker posts to this page. What it CANNOT see is
    // `console.log` INSIDE the worker — that is a separate debugger target, and
    // no page-side API exposes it. Said here, and in browser_get_console_logs's
    // description, so nobody hunts for logs that will never arrive.
    //
    // These land in the console buffer rather than a third one: an agent
    // debugging "the offline page is stale" is reading the timeline of what the
    // page did, and a worker lifecycle event belongs on that timeline. Every
    // entry is tagged `serviceworker` and prefixed, so nothing here can be
    // mistaken for output the page itself printed.
    try {
      const swc: any = (navigator as any).serviceWorker;
      if (swc) {
        const sw = (text: string, level = "info") =>
          push(level, `[sw] ${text}`, { kind: "serviceworker" });

        // One listener per worker. `watchRegistration` attaches to whatever
        // worker exists now, and `updatefound` attaches to the installing one —
        // routinely the SAME object, which logged every state change twice on a
        // real page (2026-08-27).
        const watched = new WeakSet<object>();
        const watch = (worker: any, what: string) => {
          if (!worker || watched.has(worker)) return;
          watched.add(worker);
          const url = worker.scriptURL ?? "";
          sw(`${what} ${url} (${worker.state})`);
          try {
            worker.addEventListener("statechange", () => {
              // Every state stays at `info`, INCLUDING "redundant": a normal
              // worker update makes the old one redundant, and reporting that as
              // an error would trip the console-delta footer on a healthy page.
              sw(`${url || what} → ${worker.state}`);
            });
            worker.addEventListener("error", (e: any) =>
              sw(`error in ${url}: ${String(e?.message ?? e?.type ?? e)}`, "error"),
            );
          } catch {
            /* ignore */
          }
        };

        const watchRegistration = (reg: any, how: string) => {
          if (!reg) return;
          sw(`${how} scope ${reg.scope}`);
          watch(reg.installing ?? reg.waiting ?? reg.active, "worker");
          try {
            reg.addEventListener("updatefound", () => watch(reg.installing, "update"));
          } catch {
            /* ignore */
          }
        };

        // A returning visitor's worker was registered on a PREVIOUS page load, so
        // without this the common case records nothing at all.
        try {
          swc.getRegistrations?.().then(
            (regs: any[]) => {
              for (const r of regs ?? []) watchRegistration(r, "already registered:");
            },
            () => {},
          );
        } catch {
          /* ignore */
        }

        // A rejected register() is the single most useful thing here, and the
        // page frequently swallows it in a .catch that logs nothing.
        const origRegister = swc.register?.bind(swc);
        if (origRegister) {
          swc.register = (script: any, opts?: any) => {
            sw(`register(${String(script)})`);
            return origRegister(script, opts).then(
              (reg: any) => {
                watchRegistration(reg, "registered:");
                return reg;
              },
              (err: any) => {
                sw(`register(${String(script)}) FAILED: ${String(err?.message ?? err)}`, "error");
                throw err;
              },
            );
          };
        }

        swc.addEventListener?.("controllerchange", () =>
          sw(`controller is now ${swc.controller?.scriptURL ?? "(none)"}`),
        );
        swc.addEventListener?.("message", (e: any) => {
          let body: string;
          try {
            body = typeof e?.data === "string" ? e.data : JSON.stringify(e?.data);
          } catch {
            body = String(e?.data);
          }
          sw(`message: ${body ?? "(empty)"}`);
        });
      }
    } catch {
      /* never break the page */
    }

    // ── hand the buffer over before this document is destroyed (B1c) ──────────
    // The console buffer lives in this page, so a navigation destroys it — which
    // is exactly the navigation an agent debugging a login redirect needs the log
    // from.
    //
    // This script is MAIN-world and deliberately uses NO chrome.* API (it must
    // observe the page's real console), so it cannot store anything itself. The
    // ISOLATED-world bridge script does that.
    //
    // It used to `postMessage` its buffer on `pagehide`. That NEVER ARRIVED, and a
    // real-browser check on 2026-08-27 proved it: `postMessage` queues a task, and
    // the document is torn down before that task can dispatch to the other world.
    // The same post sent while the page was alive arrived fine — which is what
    // made it look like it worked.
    //
    // So the pull is now SYNCHRONOUS and driven by the bridge: `dispatchEvent` on
    // a shared DOM node runs listeners in BOTH worlds inline, so by the time the
    // bridge's dispatch returns, the attribute below is already set and it can
    // read it and forward it before the document goes away.
    try {
      document.documentElement.addEventListener("bmcp:collect", () => {
        try {
          document.documentElement.setAttribute(
            "data-bmcp-handover",
            // No url/title here on purpose: the bridge reads those from the
            // document itself, so a page cannot claim its log came from
            // somewhere else.
            JSON.stringify({ entries: buf, dropped: meta.dropped }),
          );
        } catch {
          /* a buffer that will not serialise must not block the teardown */
        }
      });
    } catch {
      /* ignore */
    }

    // ── JS dialog capture + optional auto-handling (browser_handle_dialog) ─────
    // Record every alert/confirm/prompt and, when a policy has been armed via
    // `window.__bmcpDialogPolicy`, answer it instead of showing the native dialog.
    // Default (no policy) calls the original so native behaviour is preserved.
    const dlg: Array<{ type: string; message: string; ts: number }> = (w.__bmcpDialogs = []);
    w.__bmcpDialogPolicy = w.__bmcpDialogPolicy ?? null;
    const recordDialog = (type: string, message: string) => {
      dlg.push({ type, message, ts: Date.now() });
      if (dlg.length > 50) dlg.shift();
    };
    const policy = (): { action: string; promptText?: string } | null => w.__bmcpDialogPolicy;

    const origAlert = window.alert?.bind(window);
    window.alert = (message?: any) => {
      recordDialog("alert", String(message ?? ""));
      if (policy()) return undefined;
      return origAlert?.(message);
    };

    const origConfirm = window.confirm?.bind(window);
    window.confirm = (message?: any): boolean => {
      recordDialog("confirm", String(message ?? ""));
      const p = policy();
      if (p) return p.action === "accept";
      return origConfirm ? origConfirm(message) : false;
    };

    const origPrompt = window.prompt?.bind(window);
    window.prompt = (message?: any, defaultValue?: any): string | null => {
      recordDialog("prompt", String(message ?? ""));
      const p = policy();
      if (p) return p.action === "accept" ? p.promptText ?? String(defaultValue ?? "") : null;
      return origPrompt ? origPrompt(message, defaultValue) : null;
    };
  },
});
