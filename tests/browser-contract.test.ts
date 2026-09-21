/**
 * The generated extension contract (plan 10, I02).
 *
 * `npm run contracts:check` already fails a stale artifact, in CI and in
 * `npm run check`. This file covers the three things that check cannot:
 *
 *  1. **Regeneration is deterministic.** A generator whose output wobbles turns
 *     the drift gate into a coin toss, and the first person to see it red would
 *     rightly stop believing it.
 *  2. **The artifact is standalone.** It is compiled by the extension's own
 *     toolchain, which has no zod, no Node types and none of this repo's path
 *     aliases — an import that reached back across would not fail here, it would
 *     fail in a separate CI job with no clue pointing at this file.
 *  3. **Fields that are optional stay optional.** Older servers and older
 *     extensions are on the wire together; a field quietly promoted to required
 *     breaks the pair that is one release apart, and nothing else would notice.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  readCommands,
  readContract,
  renderContract,
} from "../scripts/generate-browser-contract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** One program build, shared: each `readCommands()` runs the TypeScript checker. */
const commands = readCommands();
// `readContract`, not a raw read: it normalises line endings, so a Windows
// checkout (core.autocrlf) does not fail this on a file git considers identical.
const committed = readContract();
assert.ok(
  committed !== null,
  "the generated contract is missing — run `npm run contracts:generate`",
);

describe("generated browser contract", () => {
  it("matches what the generator produces right now", () => {
    assert.equal(
      renderContract(commands),
      committed,
      "run `npm run contracts:generate` and commit the result",
    );
  });

  it("regenerates byte-identically from a second, independent read", () => {
    // Not `renderContract(commands)` twice — that would only prove the renderer
    // is a pure function. This re-runs the whole thing, checker included, which
    // is where a non-deterministic ordering would come from.
    assert.equal(renderContract(readCommands()), renderContract(commands));
  });

  it("declares every command the server can send, and nothing else", () => {
    const declared = commands.map((c) => c.name);
    assert.ok(declared.length > 40, `only ${declared.length} commands — the read went wrong`);
    assert.deepEqual(
      declared.filter((n) => n === "hello" || n === "identify"),
      [],
      "control-plane frames are not commands; they belong to protocol.ts",
    );
    for (const name of declared) {
      assert.match(
        committed,
        new RegExp(`^  ${name}: `, "m"),
        `${name} is missing from the committed artifact`,
      );
    }
  });

  it("carries no import at all, so the extension can compile it alone", () => {
    assert.doesNotMatch(
      committed,
      /^\s*(import|export .* from|require\()/m,
      "the artifact must be standalone — no zod, no Node, no server modules",
    );
    assert.doesNotMatch(committed, /@repo\/|\bz\.infer\b|node:/);
  });

  it("agrees with the handler map the extension dispatches against", () => {
    // The extension's own `tsc` proves each handler's payload; what it cannot
    // prove is that the map it checks against is the one generated here. This is
    // a cheap string check that the artifact the extension imports is this one.
    const handlers = readFileSync(join(root, "Chrome-extension/lib/automation/index.ts"), "utf8");
    for (const { name } of commands) {
      assert.ok(
        handlers.includes(`${name}:`),
        `${name} has no handler in the extension's dispatch map`,
      );
    }
  });
});

describe("optional fields that have to stay optional", () => {
  /** The rendered payload for one command, as the artifact declares it. */
  const payloadOf = (name: string) => {
    const found = commands.find((c) => c.name === name);
    assert.ok(found, `${name} is not on the wire contract`);
    return found.payload;
  };

  /**
   * `owner` names the controller a deny-list belongs to. It is optional so that a
   * server from before per-controller policies still installs one, as a single
   * shared owner — make it required and that server's messages stop being valid.
   */
  it("browser_net_policy.owner is optional (older servers omit it)", () => {
    assert.match(payloadOf("browser_net_policy"), /owner\?:/);
    assert.match(payloadOf("browser_net_policy"), /deny: string\[\]/);
  });

  /**
   * The relay adds the tab id; a controller driving no particular tab sends none,
   * and the extension then resolves its own. Required would break every call that
   * does not name a tab.
   */
  it("the relay's tab hint is optional", () => {
    assert.match(committed, /__bmcpTabId\?: number/);
  });

  /**
   * `includeSnapshot` rides on the interaction tools. An older extension that
   * never reads it must still accept the message, and an older server that never
   * sends it must still be understood.
   */
  it("includeSnapshot stays optional wherever it appears", () => {
    const carriers = commands.filter((c) => c.payload.includes("includeSnapshot"));
    assert.ok(carriers.length >= 4, "expected the interaction tools to carry it");
    for (const c of carriers) {
      assert.match(c.payload, /includeSnapshot\?:/, `${c.name} made it required`);
    }
  });

  /**
   * Server-side switches that ride in the payload rather than in a tool schema.
   * They are absent from every message an older server sends.
   */
  it("the server-only switches are optional", () => {
    assert.match(payloadOf("browser_click"), /actionability\?:/);
    assert.match(payloadOf("browser_screenshot"), /maxWidth\?:/);
    assert.match(payloadOf("browser_screenshot"), /forceCdp\?:/);
  });

  /**
   * Two payloads are deliberately NARROWER than their tool's arguments — the
   * fields never leave the server. A future edit that widens them back would
   * hand the extension an action it has no branch for.
   */
  it("keeps the fields that never cross the wire off the wire", () => {
    const perf = payloadOf("browser_perf_trace");
    assert.doesNotMatch(perf, /analyze/, "action:'analyze' is read from a file, server-side");
    assert.doesNotMatch(perf, /filePath/, "the trace file is written by the server");
    assert.doesNotMatch(
      payloadOf("browser_get_console_logs"),
      /page/,
      "the extension holds the whole buffer; the server slices it",
    );
  });
});
