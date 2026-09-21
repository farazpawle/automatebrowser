/**
 * Remembers the port the server was last reached on. Trying it first on every
 * (re)connect makes connection effectively instant after the first success,
 * instead of round-robining the whole 9009-9013 range one port per tick.
 *
 * Stored WITH the host it was reached on (C13): once the relay can live on
 * another machine, a remembered port is only a hint about that machine. Pointing
 * the extension at a new host and then trying the old host's port first would
 * spend the first tick of every reconnect on an address that was never right.
 */
const KEY = "local:lastPort";

export async function loadLastPort(host: string): Promise<number | null> {
  try {
    const v = await chrome.storage.local.get(KEY);
    const p = v[KEY];
    // Legacy value: a bare number, written before hosts existed — only ever
    // loopback, so it is honoured on loopback and ignored anywhere else.
    if (typeof p === "number") return host === "127.0.0.1" ? p : null;
    const rec = p as { host?: unknown; port?: unknown } | null;
    if (rec && typeof rec === "object" && rec.host === host && typeof rec.port === "number") {
      return rec.port;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveLastPort(host: string, port: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: { host, port } });
  } catch {
    /* best-effort */
  }
}
