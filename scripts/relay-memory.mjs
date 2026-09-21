/**
 * Memory profile for the RELAY (plan 09, D20 / task 21.4).
 *
 * WHY THIS EXISTS, AND WHY ONLY FOR THE RELAY. Every other process here dies with
 * its client: an MCP server exits when the IDE closes, so even a real leak in it
 * is bounded by one session. The relay is deliberately the opposite — a singleton
 * that outlives every controller, survives IDE restarts, and is meant to run for
 * days. It is the one process where slow growth is both plausible and expensive,
 * and until this script nothing watched it at all.
 *
 * WHAT IT ACTUALLY MEASURES. Connection churn, which is where a long-lived socket
 * server leaks: each wave connects browsers and controllers, lets them identify,
 * exchanges frames, takes a claim where it can, then disconnects everyone. At the
 * end of a wave the relay is back to ZERO peers, so a correct relay is back to
 * roughly the heap it started with. Growth measured at that quiescent point is
 * the signal; anything else is just the relay doing its job.
 *
 * WHAT IT DOES NOT MEASURE — the honest limits:
 *   - Not tool traffic. Forwarded tool calls are request/response and hold nothing
 *     after the reply; the per-tab console and network history an agent reads back
 *     lives in the EXTENSION, not here. The plan's D20 note said the relay retains
 *     that history — it does not, and this script does not pretend to test it.
 *   - Not native memory. `heapUsed` is the JS heap. A leak in the `ws` library's
 *     buffers would show in RSS and could hide from this.
 *   - Not a slow drip. Growth below the per-wave noise floor over a few hundred
 *     connections is invisible here and would need a much longer run.
 *
 * Usage:  npm run build && npm run memory:relay
 *         WAVES=12 PEERS=15 npm run memory:relay      # longer, more sensitive
 */
import { WebSocket } from "ws";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A dedicated, high range so this never touches the user's live relay on 9009 —
// the same isolation the connection smoke test uses.
const RANGE_START = 9740;
const RANGE_END = 9744;

const WAVES = Number(process.env.WAVES ?? 8);
const PEERS = Number(process.env.PEERS ?? 10);

/**
 * The ceiling on heap growth across the whole run.
 *
 * MEASURED, not guessed (task 21.5) — a threshold picked from nothing fails
 * randomly and then gets switched off. Four runs against the 0.2.0 build on
 * Windows, 2026-09-10:
 *
 *     160 connections (8 x 10)    +0.15 MB, +0.14 MB
 *     600 connections (20 x 15)   +0.24 MB, +0.25 MB
 *
 * Two things in that table set the number. The spread between repeats is 0.01 MB,
 * so the noise floor is small. And growth does NOT scale with connections — a
 * near-4x churn moved it by 0.1 MB, and the last five waves of the long run were
 * identical to two decimal places. That is a fixed start-up cost finishing its
 * amortisation, which is what a relay with no leak looks like.
 *
 * 2 MB is 8x the worst observed run. Loose enough to absorb a slower CI machine
 * with different GC timing, tight enough that retaining ~3.5 KB per connection —
 * roughly one registry entry with its socket and sender closure — trips it at the
 * 600-connection setting CI uses.
 */
const LIMIT_MB = Number(process.env.RELAY_MEMORY_LIMIT_MB ?? 2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);

// ── the relay, in its own isolate ────────────────────────────────────────────
const worker = new Worker(resolve(root, "scripts/lib/relay-memory-worker.mjs"), {
  workerData: { relayPath: resolve(root, "dist/relay.js") },
  env: {
    ...process.env,
    AUTOMATE_BROWSER_WS_PORT_RANGE: `${RANGE_START}-${RANGE_END}`,
    // Every wave ends at zero peers, which is exactly when the relay arms its
    // idle-exit. Left at the default it would shut down mid-run and the failure
    // would look like a connection bug.
    AUTOMATE_BROWSER_RELAY_IDLE_MS: "600000",
    // No token: with none set the relay issues no auth challenge, so the fake
    // peers below need no HMAC handshake. Nothing here tests auth.
    AUTOMATE_BROWSER_TOKEN: "",
    AUTOMATE_BROWSER_LOG_LEVEL: "error",
  },
});
worker.on("error", (err) => {
  console.error(`relay worker failed: ${err.stack ?? err}`);
  process.exit(1);
});

function heapUsed() {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("relay did not report its heap within 5s")), 5000);
    worker.once("message", (v) => {
      clearTimeout(t);
      res(v);
    });
    worker.postMessage("mem");
  });
}

// ── finding the relay ────────────────────────────────────────────────────────
function probeRelay(port, timeoutMs = 400) {
  return new Promise((res) => {
    let done = false;
    let ws;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
      res(r);
    };
    const t = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      return finish(false);
    }
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m?.type === "hello" && m.payload?.role === "relay") return finish(true);
      } catch {
        /* not our frame */
      }
    });
    ws.on("error", () => finish(false));
  });
}

async function waitForRelay(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let p = RANGE_START; p <= RANGE_END; p++) {
      if (await probeRelay(p)) return p;
    }
    await sleep(120);
  }
  return null;
}

// ── fake peers ───────────────────────────────────────────────────────────────
/** A browser: says hello, identifies, answers nothing else. */
function connectBrowser(port, tabId) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const t = setTimeout(() => rej(new Error("browser handshake timed out")), 5000);
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m?.type === "hello") {
        ws.send(
          JSON.stringify({
            id: "idf",
            type: "identify",
            payload: { browser: "chrome", label: `mem-${tabId}`, tabId },
          }),
        );
        clearTimeout(t);
        res(ws);
      }
    });
    ws.on("error", rej);
  });
}

/** A controller: says hello, then pings and claims like a real IDE would. */
function connectController(port, n) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const seen = { browserId: undefined };
    const t = setTimeout(() => rej(new Error("controller handshake timed out")), 5000);
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m?.type === "hello" && m.payload?.role === "relay") {
        ws.send(
          JSON.stringify({
            id: "hello",
            type: "control.hello",
            payload: {
              role: "controller",
              name: `mem-ide-${n}`,
              pid: 1000 + n,
              instanceId: `mem-${n}`,
            },
          }),
        );
        clearTimeout(t);
        res({ ws, seen });
        return;
      }
      // Remember a browser id so the wave can exercise the claims map too.
      if (m?.type === "control.browsers" || m?.type === "agents") {
        const first = (m.payload?.browsers ?? m.payload?.controllers ?? [])[0];
        if (first?.id) seen.browserId = first.id;
      }
    });
    ws.on("error", rej);
  });
}

const closeAll = (sockets) =>
  Promise.all(
    sockets.map(
      (ws) =>
        new Promise((res) => {
          if (ws.readyState === WebSocket.CLOSED) return res();
          ws.once("close", res);
          try {
            ws.close();
          } catch {
            res();
          }
        }),
    ),
  );

/** One wave: everyone connects, talks, claims, and leaves. */
async function wave(port) {
  const browsers = await Promise.all(
    Array.from({ length: PEERS }, (_, i) => connectBrowser(port, 100 + i)),
  );
  const controllers = await Promise.all(
    Array.from({ length: PEERS }, (_, i) => connectController(port, i)),
  );
  await sleep(150); // let the roster settle and control.browsers arrive

  for (const { ws, seen } of controllers) {
    try {
      ws.send(JSON.stringify({ type: "control.ping" }));
      if (seen.browserId) {
        ws.send(
          JSON.stringify({
            id: `claim-${seen.browserId}`,
            type: "control.claim",
            payload: { browserId: seen.browserId, tabId: 100 },
          }),
        );
      }
    } catch {
      /* socket already gone; the wave still counts */
    }
  }
  await sleep(150);

  await closeAll([...browsers, ...controllers.map((c) => c.ws)]);
  // The relay tears down on the close event; give it a tick to actually run.
  await sleep(250);
}

// ── run ──────────────────────────────────────────────────────────────────────
const port = await waitForRelay();
if (!port) {
  console.error("relay never bound a port in the isolated range — did `npm run build` run?");
  process.exit(1);
}
console.log(
  `Relay memory profile — :${port}, ${WAVES} waves x ${PEERS} browsers + ${PEERS} controllers\n`,
);

// A warm-up wave BEFORE the baseline. The first connection of the process pulls
// in TLS-less socket buffers, compiles hot paths and fills caches that are one-off
// costs, not growth. Counting them makes every run look like a leak of a megabyte
// or two and would force the threshold up until it caught nothing.
await wave(port);
const baseline = await heapUsed();
console.log(`  baseline (after warm-up)   ${mb(baseline)} MB`);

const samples = [];
for (let i = 1; i <= WAVES; i++) {
  await wave(port);
  const used = await heapUsed();
  samples.push(used);
  const delta = used - baseline;
  console.log(
    `  wave ${String(i).padStart(2)}  ${mb(used)} MB   ${delta >= 0 ? "+" : "-"}${mb(Math.abs(delta))} MB from baseline`,
  );
}

const final = samples[samples.length - 1];
const growth = final - baseline;
const perWave = growth / WAVES;
const connections = WAVES * PEERS * 2;

console.log(
  [
    "",
    `  connections churned  ${connections}`,
    `  growth               ${growth >= 0 ? "+" : "-"}${mb(Math.abs(growth))} MB`,
    `  per wave             ${perWave >= 0 ? "+" : "-"}${mb(Math.abs(perWave))} MB`,
    `  limit                ${LIMIT_MB.toFixed(2)} MB`,
    "",
  ].join("\n"),
);

await worker.terminate();

if (growth > LIMIT_MB * 1024 * 1024) {
  console.error(
    `FAIL  the relay's heap grew ${mb(growth)} MB over ${connections} connections that all ` +
      `disconnected, above the ${LIMIT_MB} MB limit.\n` +
      `      Every wave ends at zero peers, so a correct relay returns to roughly its baseline. ` +
      `Look at what a connection registers and what its close handler does NOT undo: ` +
      `src/relay/relay.ts (controllers map, heartbeat interval) and src/relay/browsers.ts ` +
      `(registry entry, claims map).`,
  );
  process.exit(1);
}

console.log(`Relay memory looks flat — ${mb(growth)} MB over ${connections} connections.`);
