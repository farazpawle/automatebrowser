/**
 * Shape of the environment-variable declaration (D13).
 *
 * `npm run docs:generate` already proves the declaration and `src/` name the same
 * SET of variables, in both directions. A set cannot see a duplicate: two entries
 * for one name collapse into one member, the gate stays green, and README renders
 * the row twice. Nor can it see an entry with an empty purpose — that renders as a
 * blank table cell and reads as an oversight rather than a fact.
 *
 * So this covers what a set comparison structurally cannot, and nothing else.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ENV_VARS } from "@/utils/env-vars";

describe("ENV_VARS", () => {
  it("names each variable exactly once", () => {
    const names = ENV_VARS.map((v) => v.name);
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual(duplicates, [], "a duplicate renders as two identical README rows");
  });

  it("uses the project's prefix for every name", () => {
    for (const v of ENV_VARS) {
      assert.match(v.name, /^AUTOMATE_BROWSER_[A-Z0-9_]+$/);
    }
  });

  it("gives every variable a purpose and a stated default", () => {
    // "unset" is a default. An empty string is a blank cell in a published table.
    for (const v of ENV_VARS) {
      assert.ok(v.purpose.trim().length > 0, `${v.name} has no purpose`);
      assert.ok(v.default.trim().length > 0, `${v.name} has no stated default`);
    }
  });

  it("keeps the internal ones out of the rendered table", () => {
    const internal = ENV_VARS.filter((v) => v.internal);
    assert.ok(internal.length > 0, "the marker is unused — has the internal var gone?");
    for (const v of internal) {
      assert.ok(!ENV_VARS.filter((x) => !x.internal).includes(v));
    }
  });
});
