/**
 * Paging for the two tools that return a LOG: the console dump and the network
 * request list. Both are unbounded — a chatty SPA produces hundreds of entries —
 * and both used to hand the whole thing to the model in one result.
 *
 * Page 1 is the NEWEST slice, and higher pages walk BACKWARDS in time. That is
 * the opposite of how a paged table usually reads, and it is deliberate: both
 * tools already returned "the most recent N", so an omitted `page` returns
 * exactly what the tool always returned. Making page 1 the oldest entries would
 * have silently changed what every existing caller sees on the call it already
 * makes.
 *
 * An out-of-range page is never an error. It comes back as page 1 with
 * `clamped` set to what was asked for, so the renderer can say the page did not
 * exist instead of returning an empty list the agent has to interpret.
 */

export interface Page<T> {
  /** The requested slice, in chronological order within the page. */
  items: T[];
  /** The page actually served — 1 when the request was out of range. */
  page: number;
  totalPages: number;
  /** Entries across every page, not just this one. */
  total: number;
  /** True when an OLDER page exists. */
  hasNext: boolean;
  /** The out-of-range page that was asked for, if it was clamped to page 1. */
  clamped?: number;
}

export function paginate<T>(items: T[], requested: number | undefined, size: number): Page<T> {
  const total = items.length;
  // An empty log is one empty page, not zero pages — otherwise page 1 of a
  // quiet tab would report itself as out of range.
  const totalPages = Math.max(1, Math.ceil(total / size));
  const wanted =
    typeof requested === "number" && Number.isInteger(requested) && requested >= 1 ? requested : 1;
  const clamped = wanted > totalPages ? wanted : undefined;
  const page = clamped === undefined ? wanted : 1;
  const end = total - (page - 1) * size;
  return {
    items: items.slice(Math.max(0, end - size), end),
    page,
    totalPages,
    total,
    hasNext: page < totalPages,
    clamped,
  };
}

/**
 * The line printed under a paged result. Self-correcting in the same sense as
 * the console-delta footer in `tools/call.ts`: it names the exact next call, so
 * an agent that wants more never has to guess the parameter.
 *
 * Silent when everything fitted on one page. A "page 1/1" line on the common
 * case would cost every caller tokens to be told nothing, and it would change
 * the output of a tool that had not actually paged.
 */
export function pageFooter(page: Page<unknown>, toolName: string, noun: string): string {
  if (page.totalPages <= 1 && page.clamped === undefined) return "";
  const missing =
    page.clamped === undefined ? "" : `page ${page.clamped} does not exist, so this is `;
  const next = page.hasNext
    ? ` Older: ${toolName} {"page":${page.page + 1}}`
    : " This is the oldest page.";
  return (
    `\n\n— ${missing}page ${page.page}/${page.totalPages} of ${page.total} ` +
    `${noun}, newest page first.${next}`
  );
}
