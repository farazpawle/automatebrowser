/**
 * One line of text, handed from the registry to `browser_status`.
 *
 * Exists to break a genuine import cycle. The registry MUST import every tool,
 * `browser_status` included, in order to serve it — so any import back from
 * `status.ts` to `registry.ts` closes a loop, and a loop at module-load time can
 * leave one side holding a half-initialised copy of the other.
 *
 * Inverting it costs one leaf module that imports nothing: the registry, which
 * knows about every tool, PUSHES its description here; `status.ts`, which knows
 * about nothing, PULLS it. Neither file references the other any more.
 */

let provider: (() => string) | undefined;

/** Called once by the registry as it loads. */
export function provideSelectionLine(fn: () => string): void {
  provider = fn;
}

/**
 * The line, or `undefined` if the registry was never loaded — which cannot
 * happen in the server (it is what builds the served tool list), but returning
 * undefined beats inventing a wrong-looking line if it ever did.
 */
export function selectionLine(): string | undefined {
  return provider?.();
}
