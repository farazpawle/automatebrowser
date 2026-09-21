/**
 * Not a test — the smallest module that proves the extension harness cleans up.
 *
 * A real extension module schedules work on load (the network log's persist
 * timer, the keepalive alarm). If the harness leaked those, every suite that
 * loaded one would hold the test process open, and the failure would look like a
 * hang in whatever ran last rather than a harness bug.
 */
let ticks = 0;

setInterval(() => {
  ticks += 1;
}, 5);

export function count(): number {
  return ticks;
}
