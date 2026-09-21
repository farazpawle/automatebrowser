/**
 * Downloads (roadmap B8) — DEBUGGER-FREE, `chrome.downloads` only.
 *
 * Without this a click that triggers a download is a dead end: the agent cannot
 * confirm it happened, and cannot find the file it produced. The answer is the
 * PATH — file contents are the file sandbox's job, never this handler's.
 *
 * The wait mode listens on `chrome.downloads.onChanged` rather than polling, so
 * it returns the moment the last transfer settles instead of on the next tick.
 */

export interface DownloadView {
  id: number;
  /** Absolute path on disk once the transfer starts. This is the answer. */
  filename: string;
  url: string;
  mime: string;
  bytes: number;
  totalBytes: number;
  /** in_progress | complete | interrupted */
  state: string;
  error?: string;
  startTime: string;
}

function toView(d: chrome.downloads.DownloadItem): DownloadView {
  return {
    id: d.id,
    filename: d.filename ?? "",
    url: d.url ?? "",
    mime: d.mime ?? "",
    bytes: d.bytesReceived ?? 0,
    totalBytes: d.totalBytes ?? 0,
    state: String(d.state),
    ...(d.error ? { error: String(d.error) } : {}),
    startTime: d.startTime ?? "",
  };
}

/** Resolves true when nothing is transferring any more, false on timeout. */
function waitForIdle(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (ok: boolean) => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    const onChanged = async (delta: chrome.downloads.DownloadDelta) => {
      // Only a state transition can end the wait; byte-progress deltas cannot.
      if (!delta.state || delta.state.current === "in_progress") return;
      if ((await chrome.downloads.search({ state: "in_progress" })).length === 0) {
        settle(true);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

export async function listDownloads(args: {
  limit?: number;
  wait?: boolean;
  timeout?: number;
}): Promise<{ downloads: DownloadView[]; waited?: boolean }> {
  if (!chrome.downloads) {
    throw new Error(
      "downloads permission not granted in the extension — reload the rebuilt extension.",
    );
  }
  let waited: boolean | undefined;
  if (args.wait) {
    const timeoutMs = Math.min(Math.max(args.timeout ?? 30, 1), 300) * 1000;
    waited =
      (await chrome.downloads.search({ state: "in_progress" })).length === 0 ||
      (await waitForIdle(timeoutMs));
  }
  const items = await chrome.downloads.search({
    limit: Math.min(Math.max(args.limit ?? 10, 1), 100),
    orderBy: ["-startTime"],
  });
  return { downloads: items.map(toView), ...(waited === undefined ? {} : { waited }) };
}
