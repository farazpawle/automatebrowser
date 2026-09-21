/**
 * The relay, running inside a worker thread so its heap can be measured alone.
 *
 * WHY A WORKER. `dist/relay.js` is a process entry — it self-starts on import and
 * calls `process.exit` on some paths. Importing it into the harness would work,
 * but then the harness's own WebSocket clients allocate on the SAME heap as the
 * thing being measured, and a few hundred sockets of noise is more than the leak
 * we are looking for. A worker gets its own V8 isolate, so `heapUsed` reported in
 * here is the relay's and nothing else's. `process.exit` inside a worker ends the
 * worker, not the run.
 *
 * WHY NOT `--expose-gc`. That is a V8 flag, and worker `execArgv` accepts Node
 * flags only — passing it throws ERR_WORKER_INVALID_EXEC_ARGV. Setting it on the
 * isolate from inside is the portable equivalent and keeps the launcher a plain
 * `node scripts/relay-memory.mjs` with no flags to remember.
 */
import { pathToFileURL } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");

parentPort.on("message", (msg) => {
  if (msg !== "mem") return;
  // Twice: the first pass can leave objects that only become unreachable once
  // the finalizers from that pass have run. Without it a sample reads high and
  // the run looks like a leak that a third GC would have cleared.
  gc();
  gc();
  parentPort.postMessage(process.memoryUsage().heapUsed);
});

// Started last, so the message handler is already listening when the relay
// begins binding ports and the parent can sample the moment it is up.
await import(pathToFileURL(workerData.relayPath).href);
