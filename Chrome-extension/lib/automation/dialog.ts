/**
 * JS dialog handling — DEBUGGER-FREE (PARTIAL).
 *
 * The MAIN-world content script (content.ts) overrides window.alert/confirm/prompt
 * at document_start so it can (a) record every dialog the page raises and
 * (b) auto-respond per a policy. This tool ARMS that policy for FUTURE dialogs and
 * returns the recent dialog log.
 *
 * Default (no policy) = native behaviour (the real dialog still shows to the user).
 * Set `action:"accept"|"dismiss"` to auto-handle; `action:"native"` resets to the
 * default. Because the override must be installed before a dialog fires, a dialog
 * raised synchronously during initial page load may not be caught (that's the
 * PARTIAL — full reliability needs CDP `Page.javascriptDialogOpening`, Milestone 3).
 */
import * as cdp from "./cdp";
import { runFunc } from "./run-func";

function dialogControlFn(
  action: string | null,
  promptText: string | null,
): { dialogs: Array<{ type: string; message: string; ts: number }>; policy: unknown } {
  const w = window as any;
  if (action === "native") {
    w.__bmcpDialogPolicy = null;
  } else if (action === "accept" || action === "dismiss") {
    w.__bmcpDialogPolicy = { action, promptText: promptText ?? undefined };
  }
  return {
    dialogs: ((w.__bmcpDialogs as Array<{ type: string; message: string; ts: number }>) || []).slice(-50),
    policy: w.__bmcpDialogPolicy ?? null,
  };
}

export interface DialogResult {
  dialogs: Array<{ type: string; message: string; ts: number }>;
  policy: unknown;
  /** A modal blocking the renderer RIGHT NOW, if the debugger can see one. */
  open?: { type: string; message: string } | null;
  /** True when this call answered a modal that was already blocking the page. */
  cleared?: boolean;
}

export async function handleDialog(
  tabId: number,
  args: { action?: "accept" | "dismiss" | "native"; promptText?: string },
): Promise<DialogResult> {
  // A modal that is ALREADY up pauses the renderer, so the injected override
  // below can neither run nor reply — this tool used to hang on exactly the
  // situation it is called for, while the timeout message told the agent to call
  // it. `Page.handleJavaScriptDialog` runs in the browser process, not the
  // paused renderer, so it is the only thing that can answer one. It needs the
  // debugger, which stays opt-in: without it we still cannot clear a live modal,
  // but we must not hang pretending otherwise.
  const live = cdp.isAttached(tabId) ? cdp.openDialog(tabId) : undefined;
  if (live) {
    const answer = args.action === "accept" || args.action === "dismiss" ? args.action : null;
    if (!answer) {
      // Reading the log must never dismiss anything as a side effect. Report what
      // is blocking the page and return without touching the renderer.
      return {
        dialogs: [{ type: live.type, message: live.message, ts: live.ts }],
        policy: null,
        open: { type: live.type, message: live.message },
      };
    }
    await cdp.sendCommand(tabId, "Page.handleJavaScriptDialog", {
      accept: answer === "accept",
      ...(args.promptText != null ? { promptText: args.promptText } : {}),
    });
    // The renderer is running again, so the policy can now be armed for the NEXT
    // dialog. If the page immediately raises another one, keep the win we have
    // rather than failing the whole call.
    try {
      const r = await runFunc(
        tabId,
        dialogControlFn,
        [args.action ?? null, args.promptText ?? null],
        "MAIN",
      );
      return { ...r, cleared: true };
    } catch {
      return {
        dialogs: [{ type: live.type, message: live.message, ts: live.ts }],
        policy: { action: answer, promptText: args.promptText },
        cleared: true,
      };
    }
  }

  return runFunc(
    tabId,
    dialogControlFn,
    [args.action ?? null, args.promptText ?? null],
    "MAIN",
  );
}
