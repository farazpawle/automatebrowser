/**
 * Not a test — a module whose import the harness cannot resolve, so the refusal
 * is proved against a real load rather than asserted about in a comment.
 *
 * The harness resolves relative source only. A bare specifier has to be named in
 * `mocks`, because silently reaching into `node_modules` would let an extension
 * module run against the ROOT package's copy of a dependency, which is not the
 * copy the extension ships.
 */
import { EOL } from "node:os";

export const lineEnding = EOL;
