/**
 * Tool profiles (C1). Two properties are load-bearing:
 *
 *  - The always-on set survives every filter. Gate the tools an agent uses to
 *    FIND and KEEP a browser and it is stranded with no way to ask why.
 *  - A bad AUTOMATE_BROWSER_TOOLS value serves `full` and says so. A typo must
 *    never silently strand an agent with an empty tool list.
 *
 * `selectTools` is pure — it takes the spec as an argument — so nothing here
 * touches the environment or the cached process-wide selection.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CATEGORIES, PROFILE_NAMES, categoryOf, selectTools } from "@/tools/registry";

const ALWAYS_ON = ["browser_status", "browser_list_clients", "browser_select_client"];
const names = (spec?: string) => selectTools(spec).tools.map((t) => t.schema.name);

describe("profiles", () => {
  it("offers exactly the three documented profiles", () => {
    assert.deepEqual(PROFILE_NAMES.sort(), ["core", "full", "slim"]);
  });

  it("serves full by default", () => {
    const sel = selectTools();
    assert.equal(sel.label, "full");
    assert.equal(sel.fellBack, false);
    assert.equal(sel.requested, undefined);
  });

  it("orders full to include every category", () => {
    const full = new Set(names("full"));
    for (const category of CATEGORIES) {
      assert.ok(
        names("full").some((n) => categoryOf(n) === category),
        `no tool served for category ${category}`,
      );
    }
    assert.ok(full.size > 0);
  });

  it("makes each profile a subset of the one above it in size", () => {
    assert.ok(names("slim").length < names("core").length);
    assert.ok(names("core").length < names("full").length);
  });

  it("serves every slim and core tool from full, so a profile can never invent one", () => {
    const full = new Set(names("full"));
    for (const n of [...names("core"), ...names("slim")]) {
      assert.ok(full.has(n), `${n} is served by a profile but not by full`);
    }
  });

  it("is case-insensitive about the profile name", () => {
    assert.equal(selectTools("SLIM").label, "slim");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(selectTools("  core  ").label, "core");
  });
});

describe("the always-on set", () => {
  it("survives every profile", () => {
    for (const profile of PROFILE_NAMES) {
      const served = new Set(names(profile));
      for (const n of ALWAYS_ON) {
        assert.ok(served.has(n), `${n} missing from ${profile}`);
      }
    }
  });

  it("survives a category list that names none of its categories", () => {
    const served = new Set(names("navigation"));
    for (const n of ALWAYS_ON) assert.ok(served.has(n), n);
  });

  it("survives even the narrowest useful selection", () => {
    const served = new Set(names("content"));
    for (const n of ALWAYS_ON) assert.ok(served.has(n), n);
  });
});

describe("category lists", () => {
  it("serves a single category plus the always-on set, and nothing else", () => {
    const served = names("tabs");
    for (const n of served) {
      assert.ok(categoryOf(n) === "tabs" || ALWAYS_ON.includes(n), `unexpected tool ${n}`);
    }
    assert.equal(selectTools("tabs").label, "custom");
  });

  it("unions several categories", () => {
    const both = new Set(names("tabs,navigation"));
    for (const n of [...names("tabs"), ...names("navigation")]) {
      assert.ok(both.has(n), n);
    }
  });

  it("accepts every documented category name", () => {
    for (const category of CATEGORIES) {
      const sel = selectTools(category);
      assert.equal(sel.fellBack, false, category);
      assert.equal(sel.label, "custom", category);
    }
  });
});

describe("a bad value must never strand an agent", () => {
  it("falls back to full and records that it did", () => {
    const sel = selectTools("nonsense");
    assert.equal(sel.label, "full");
    assert.equal(sel.fellBack, true);
    assert.equal(sel.requested, "nonsense");
  });

  it("falls back when only some names in a list are real categories", () => {
    const sel = selectTools("tabs,notacategory");
    assert.equal(sel.fellBack, true);
    assert.equal(sel.label, "full");
  });

  it("treats an empty or whitespace value as unset, not as a typo", () => {
    for (const v of ["", "   "]) {
      const sel = selectTools(v);
      assert.equal(sel.label, "full");
      assert.equal(sel.fellBack, false, JSON.stringify(v));
    }
  });
});

describe("categoryOf", () => {
  it("returns a documented category for every served tool", () => {
    for (const n of names("full")) {
      assert.ok(
        (CATEGORIES as readonly string[]).includes(categoryOf(n) as string),
        `${n} has no category`,
      );
    }
  });

  it("returns undefined for a name that is not a tool", () => {
    assert.equal(categoryOf("browser_does_not_exist"), undefined);
  });
});

describe("schemas", () => {
  it("gives every tool a name, a description and an input schema", () => {
    for (const tool of selectTools("full").tools) {
      assert.ok(tool.schema.name.startsWith("browser_"), tool.schema.name);
      assert.ok(tool.schema.description.length > 20, tool.schema.name);
      assert.ok(tool.schema.inputSchema, tool.schema.name);
    }
  });

  it("advertises no tool twice", () => {
    const served = names("full");
    assert.equal(new Set(served).size, served.length);
  });
});
