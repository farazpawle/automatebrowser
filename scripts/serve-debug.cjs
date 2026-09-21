/**
 * Dev launcher: runs the built `dist/index.js` with debug logging and keeps it
 * alive (holding stdin open so the stdio transport doesn't self-shutdown), so a
 * real browser extension can connect and we can watch the hello/identify/
 * registry events. Logs (stdout+stderr) are teed to scripts/server.log.
 *
 * Start:  node scripts/serve-debug.cjs        (use run_in_background)
 * Watch:  read scripts/server.log
 * Stop:   kill the launcher process.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const logPath = path.join(__dirname, "server.log");
fs.writeFileSync(logPath, `[serve-debug] starting dist/index.js @ ${new Date().toISOString()}\n`);
const logFd = fs.openSync(logPath, "a");

const child = spawn("node", ["dist/index.js"], {
  cwd: root,
  env: { ...process.env, AUTOMATE_BROWSER_LOG_LEVEL: "debug" },
  // stdin: pipe (kept open by this launcher) so the server stays up;
  // stdout/stderr -> log file.
  stdio: ["pipe", logFd, logFd],
});

const keepAlive = setInterval(() => {}, 1 << 30);
const stop = () => {
  try {
    child.kill();
  } catch {}
  clearInterval(keepAlive);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => {
  fs.appendFileSync(logPath, `[serve-debug] server exited code=${code}\n`);
  clearInterval(keepAlive);
  process.exit(code || 0);
});
