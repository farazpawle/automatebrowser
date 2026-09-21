/**
 * Network-layer half of the origin deny-list (roadmap B9), via
 * `chrome.declarativeNetRequest`.
 *
 * Tool-level gating alone is not enough: `browser_eval` on an ALLOWED page can
 * still `fetch()` a denied origin, and no tool call ever names it. These rules
 * stop the request itself.
 *
 * Matching is by DOMAIN — no scheme, no port, subdomains always included —
 * because that is what `requestDomains` does. That is deliberately BROADER than
 * the server's tool gate: a network block that quietly missed half the requests
 * would be worse than no block at all.
 *
 * ONE BROWSER, SEVERAL AGENTS (B05). This used to clear the whole reserved band
 * and write the caller's list into it, so the second IDE to connect silently
 * deleted the first IDE's rules while the first IDE went on believing it was
 * protected. Each controller now owns its own entry here and the band is rebuilt
 * from the UNION of every entry, which is the one merge that cannot weaken
 * anybody: these rules only ever block, so a union blocks at least what each
 * agent asked for. Replacing or dropping another owner's list is never done —
 * when the union cannot fit, the call FAILS rather than installing part of it.
 */

/** Our dynamic rules live in this id band so we only ever clear our own. */
const RULE_ID_BASE = 91_000;
const MAX_RULES = 500;

/**
 * Where the per-owner lists live. `chrome.storage.session`, not a module Map,
 * for the reason the network log uses it: an MV3 worker eviction would otherwise
 * lose every other agent's list, and the next install would rebuild the band
 * without them. It clears on browser restart, which is correct — dynamic rules
 * survive that, and the first install of a new session should sweep rules no
 * connected agent has asked for.
 */
const SESSION_KEY = "bmcp:netpolicy";

/** Payload from a server too old to name its controller: one shared bucket. */
const LEGACY_OWNER = "legacy";

type Owned = Record<string, string[]>;

async function readOwners(): Promise<Owned> {
  try {
    const got = await chrome.storage.session.get(SESSION_KEY);
    const s = got?.[SESSION_KEY];
    return s && typeof s === "object" ? (s as Owned) : {};
  } catch {
    // No `storage` permission, or a worker torn down mid-read. Degrading to
    // "this owner only" over-blocks nothing and under-blocks only until the
    // other agents' next call, which reinstalls — see `pushNetPolicy`.
    return {};
  }
}

/**
 * Serializes read-modify-write. Two controllers pushing at once would otherwise
 * both read the same `Owned`, and the loser's entry would vanish from the union
 * it wrote — the exact clobber this module exists to prevent, one layer down.
 */
let chain: Promise<unknown> = Promise.resolve();

export async function setNetPolicy(args: {
  deny?: string[];
  owner?: string;
}): Promise<{ installed: number; mine: number; owners: number }> {
  if (!chrome.declarativeNetRequest) {
    throw new Error(
      "declarativeNetRequest permission not granted in the extension — reload the rebuilt extension.",
    );
  }
  const run = chain.catch(() => undefined).then(() => apply(args));
  chain = run.catch(() => undefined);
  return run;
}

async function apply(args: { deny?: string[]; owner?: string }): Promise<{
  installed: number;
  mine: number;
  owners: number;
}> {
  const owner = (args.owner ?? "").trim() || LEGACY_OWNER;
  const mine = [...new Set((args.deny ?? []).filter(Boolean).map((d) => d.toLowerCase()))];

  const owners = await readOwners();
  // This owner's PREVIOUS list is replaced, never added to: an operator who
  // shortens their deny-list must not keep blocking what they removed.
  if (mine.length > 0) owners[owner] = mine;
  else delete owners[owner];

  const union = [...new Set(Object.values(owners).flat())];
  if (union.length > MAX_RULES) {
    // Refuse rather than install a prefix. A partial block reported as success is
    // how an agent ends up trusting protection it does not have.
    throw new Error(
      `Cannot install ${union.length} block rules for ${Object.keys(owners).length} agents — ` +
        `the reserved band holds ${MAX_RULES}. Shorten a deny-list, or drive fewer agents ` +
        `through this browser.`,
    );
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .map((r) => r.id)
    .filter((id) => id >= RULE_ID_BASE && id < RULE_ID_BASE + MAX_RULES);
  const addRules = union.map((domain, i) => ({
    id: RULE_ID_BASE + i,
    priority: 1,
    action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
    condition: { requestDomains: [domain] },
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });

  // Written only after the rules are in, so a failed install cannot leave this
  // owner recorded as protected for the next caller's union.
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: owners });
  } catch {
    // The rules ARE installed; only the bookkeeping that survives a worker
    // eviction is lost. Never fail an install over its mirror.
  }

  // `mine` is what this caller asked for and got, as opposed to `installed`,
  // which is the union now covering every agent on this browser. The server
  // checks `mine` before it records the browser as protected.
  return { installed: addRules.length, mine: mine.length, owners: Object.keys(owners).length };
}
