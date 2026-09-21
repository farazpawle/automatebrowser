/**
 * Where logs that must OUTLIVE THE DAY are written.
 *
 * Both long-lived logs used to sit in `os.tmpdir()`, and that quietly destroyed
 * the thing each one exists for:
 *   - the relay traffic log (`src/relay/log-file.ts`) records `browser connected`
 *     / `browser removed` with timestamps — the only durable evidence of the
 *     extension dropping and not coming back;
 *   - the action audit log (`src/utils/audit.ts`) answers "what did the agent
 *     touch?", and README promises that is answerable *after* something looks
 *     wrong, with a 1 MB rotation keeping one predecessor.
 *
 * Neither survives a swept temp directory. Measured on this machine 2026-09-02:
 * NOTHING in `%TEMP%` was older than 24 hours, and the relay log held a single
 * line written minutes earlier — so the one occurrence of the open "extension
 * went away and did not return" defect had its evidence deleted before anyone
 * looked. This is not Windows-specific: systemd-tmpfiles ages /tmp out too.
 *
 * Home, not temp. Falls back to temp only if home cannot be created, because a
 * log in the wrong place still beats no log at all.
 */
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Resolved once: the directory never changes within a process. */
const dir = ((): string => {
  const preferred = join(homedir(), ".automate-browser");
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    return tmpdir();
  }
})();

/** Absolute path for `name` inside the durable log directory. */
export function logPath(name: string): string {
  return join(dir, name);
}
