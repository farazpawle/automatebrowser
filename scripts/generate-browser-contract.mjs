// Generate the extension's copy of the command wire contract from the server's
// own `WireMessageMap` (plan 10, I02), so the two halves cannot drift.
//
// The problem this closes: `src/tools/messages.ts` derives every tool payload
// from the zod schema that tool already validates with, so a renamed argument is
// a server-side type error the moment it is renamed. The extension never saw any
// of that — `HandlerMap` was `Record<string, (payload: any) => unknown>` and every
// handler took `p: any`, so the renamed field reached a handler that still read
// the old name, compiled clean on both sides, and failed on a user's browser.
//
// So this walks the server's type with the TypeScript checker and prints each
// payload as a STANDALONE structural type: no zod, no Node, no server imports, no
// path aliases. The extension is a separate package with its own tsconfig and its
// own CI job; an artifact that imported across would not compile there at all.
//
// What it deliberately does NOT emit:
//   - `hello` / `identify` — the control plane, not commands. They are handshake
//     frames the connection layer consumes before any handler exists, and they
//     already have hand-written mirrors in `Chrome-extension/lib/protocol.ts`.
//   - response types. `ToolMessageMap` types every tool response as `unknown` on
//     purpose (tools assert the shape at the call site); inventing declarations
//     here would be the same hand-copy this file exists to delete.
//
// Generated TypeScript is not runtime validation. The envelope is still checked
// at the socket boundary (`isRequestFrame` in protocol.ts) and arguments are still
// parsed and policed server-side. This only makes a MISMATCH a compile error.
//
// Usage:  npm run contracts:generate     write the artifact
//         npm run contracts:check        fail if it is missing or stale (no write)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The one source of payload shapes: schema-derived, never hand-copied. */
export const SOURCE_PATH = resolve(root, "src/tools/messages.ts");
/** The exported type this reads. */
const SOURCE_TYPE = "WireMessageMap";
/** Where the extension reads its copy from. */
export const CONTRACT_PATH = resolve(root, "Chrome-extension/lib/generated/browser-messages.ts");

/**
 * Control-plane frames, excluded above. Named here rather than inferred because
 * "is this a command" is a judgement about the protocol, not a property of the
 * type — an inferred rule would silently reclassify the next frame added.
 */
const CONTROL_PLANE = new Set(["hello", "identify"]);

/** Deeper than any real payload; a hit means a shape that does not belong on the wire. */
const MAX_DEPTH = 8;

const PRINT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.InTypeAlias |
  ts.TypeFormatFlags.UseFullyQualifiedType;

/** Build the program once; both the generator and its test go through here. */
function openProgram() {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error(`No tsconfig.json above ${root}`);
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (raw.error) {
    throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, root);
  const program = ts.createProgram([SOURCE_PATH], { ...parsed.options, noEmit: true });
  const source = program.getSourceFile(SOURCE_PATH);
  if (!source) throw new Error(`TypeScript could not load ${rel(SOURCE_PATH)}`);
  return { program, checker: program.getTypeChecker(), source };
}

function rel(p) {
  return relative(root, p).split("\\").join("/");
}

/** Locate `export type WireMessageMap = …` and hand back its resolved type. */
function findWireMap(checker, source) {
  let alias;
  source.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === SOURCE_TYPE) alias = node;
  });
  if (!alias) {
    throw new Error(`${rel(SOURCE_PATH)} no longer exports \`${SOURCE_TYPE}\``);
  }
  return { node: alias, type: checker.getTypeAtLocation(alias.name) };
}

/**
 * True when `typeToString` would print a NAME the extension cannot resolve —
 * an interface, a local alias, or an `import("…/src/…")` back into the server.
 * Everything else (primitives, literals, `boolean`, `string[]`) prints as itself
 * and is already standalone, so it is left alone rather than re-derived.
 */
function needsExpansion(checker, type) {
  if (type.isIntersection()) return true;
  if (type.isUnion()) return type.types.some((t) => needsExpansion(checker, t));
  if (checker.isArrayType(type)) {
    const [element] = checker.getTypeArguments(type);
    return element ? needsExpansion(checker, element) : false;
  }
  return !!(type.flags & ts.TypeFlags.Object);
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Print a type as standalone structural TypeScript. */
function renderType(checker, node, type, depth) {
  if (depth > MAX_DEPTH) {
    throw new Error(
      `payload nests deeper than ${MAX_DEPTH} levels — that is a shape, not a wire message`,
    );
  }
  if (!needsExpansion(checker, type)) {
    return checker.typeToString(type, node, PRINT_FLAGS);
  }
  if (type.isUnion()) {
    return type.types.map((t) => renderType(checker, node, t, depth + 1)).join(" | ");
  }
  if (checker.isArrayType(type)) {
    const [element] = checker.getTypeArguments(type);
    const inner = renderType(checker, node, element, depth + 1);
    // `{ … }[]` is legal but reads badly; `Array<…>` keeps the brace pairing clear.
    return IDENTIFIER.test(inner) ? `${inner}[]` : `Array<${inner}>`;
  }
  // Objects and intersections alike: the checker merges an intersection's members
  // into one property list, which is exactly the shape that goes on the wire.
  const members = [];
  for (const info of checker.getIndexInfosOfType(type)) {
    const key = checker.typeToString(info.keyType, node, PRINT_FLAGS);
    members.push(`[key: ${key}]: ${renderType(checker, node, info.type, depth + 1)}`);
  }
  for (const symbol of type.getProperties()) {
    const name = symbol.getName();
    const optional = !!(symbol.flags & ts.SymbolFlags.Optional);
    const valueType = checker.getTypeOfSymbolAtLocation(symbol, node);
    const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
    members.push(
      `${key}${optional ? "?" : ""}: ${renderType(checker, node, valueType, depth + 1)}`,
    );
  }
  if (members.length === 0) return "Record<string, never>";
  return `{ ${members.join("; ")} }`;
}

/**
 * Every command the server can send, in the order the source declares them, with
 * its payload rendered standalone.
 */
export function readCommands() {
  const { checker, source } = openProgram();
  const { node, type } = findWireMap(checker, source);
  const commands = [];
  for (const symbol of type.getProperties()) {
    const name = symbol.getName();
    if (CONTROL_PLANE.has(name)) continue;
    const entry = checker.getTypeOfSymbolAtLocation(symbol, node);
    const payload = entry.getProperty("payload");
    if (!payload) throw new Error(`\`${name}\` in ${SOURCE_TYPE} declares no payload`);
    const payloadType = checker.getTypeOfSymbolAtLocation(payload, node);
    try {
      commands.push({ name, payload: renderType(checker, node, payloadType, 0) });
    } catch (err) {
      throw new Error(`${name}: ${err.message}`, { cause: err });
    }
  }
  if (commands.length === 0) {
    throw new Error(`${SOURCE_TYPE} resolved to no commands — refusing to write an empty contract`);
  }
  return commands;
}

/**
 * Split an object body at its OWN separators only. A plain `split("; ")` also cuts
 * inside `Array<{ value: string; ref: string }>`, which is how the first run of
 * this emitted a nested type across two lines with the braces unbalanced.
 */
function splitMembers(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "[" || c === "(" || c === "<") depth++;
    else if (c === "}" || c === "]" || c === ")" || c === ">") depth--;
    else if (c === ";" && depth === 0) {
      out.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = body.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** One property line per member, so a diff shows the field that changed. */
function formatPayload(payload, indent) {
  if (!payload.startsWith("{ ")) return payload;
  const pad = " ".repeat(indent + 2);
  const members = splitMembers(payload.slice(1, -1));
  return `{\n${members.map((m) => `${pad}${m};`).join("\n")}\n${" ".repeat(indent)}}`;
}

export function renderContract(commands = readCommands()) {
  const names = commands.map((c) => `  "${c.name}",`).join("\n");
  const entries = commands.map((c) => `  ${c.name}: ${formatPayload(c.payload, 2)};`).join("\n");
  return `/**
 * GENERATED FILE — do not edit. Run \`npm run contracts:generate\`.
 *
 * Source of truth: the server's \`WireMessageMap\` (\`${rel(SOURCE_PATH)}\`), whose
 * tool payloads are themselves derived from the zod schema each tool validates
 * its arguments with. Rename an argument on the server and the handler here stops
 * compiling — which is the entire point: it used to compile and fail in a
 * user's browser.
 *
 * Standalone on purpose: no zod, no Node, no server imports. This package has its
 * own tsconfig and its own CI job, and anything reaching back across would not
 * build here.
 *
 * Types are not runtime validation. The envelope is still checked in
 * \`../protocol.ts\`, and arguments are still parsed and policed by the server.
 */

/** Every command the server can send. Control-plane frames live in \`../protocol.ts\`. */
export const BROWSER_COMMANDS = [
${names}
] as const;

export type BrowserCommand = (typeof BROWSER_COMMANDS)[number];

const COMMAND_SET: ReadonlySet<string> = new Set(BROWSER_COMMANDS);

/** Runtime narrowing for an envelope's \`type\`, so dispatch needs no cast on the key. */
export function isBrowserCommand(type: string): type is BrowserCommand {
  return COMMAND_SET.has(type);
}

/**
 * Added by the relay (\`src/relay/relay.ts\`) to every command it forwards, naming
 * the tab that controller is driving. Absent when the controller drives whatever
 * tab this browser resolves on its own.
 */
export interface RelayTabHint {
  __bmcpTabId?: number;
}

export interface BrowserCommandMap {
${entries}
}

/** What a handler for \`K\` actually receives: the payload plus the relay's tab hint. */
export type CommandPayload<K extends BrowserCommand> = BrowserCommandMap[K] & RelayTabHint;
`;
}

/**
 * Read the committed artifact with line endings normalised to LF, or null when
 * it does not exist yet.
 *
 * `core.autocrlf` is true on Windows and this repo pins no `.gitattributes`, so
 * git materialises the file with CRLF while `renderContract()` renders LF — and
 * a byte-exact comparison calls that drift. The committed bytes were always
 * identical (git normalises to LF in the index); only the working tree differed,
 * which is why Linux CI never saw it. Normalising here rather than at each
 * comparison is deliberate: `--check`, the write path and
 * `tests/browser-contract.test.ts` all ask the same question. A real content
 * change still differs after normalising, so the gate loses nothing.
 */
export function readContract() {
  if (!existsSync(CONTRACT_PATH)) return null;
  return readFileSync(CONTRACT_PATH, "utf8").replace(/\r\n/g, "\n");
}

function main() {
  const check = process.argv.includes("--check");
  const expected = renderContract();
  const actual = readContract();

  if (check) {
    // A check that repairs what it finds reports success on a broken tree and
    // leaves the drift for someone else's push. So this only ever reads.
    if (actual === null) {
      console.error(`Missing ${rel(CONTRACT_PATH)} — run \`npm run contracts:generate\`.`);
      process.exit(1);
    }
    if (actual !== expected) {
      console.error(
        `${rel(CONTRACT_PATH)} is stale — run \`npm run contracts:generate\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`${rel(CONTRACT_PATH)} is up to date.`);
    return;
  }

  if (actual === expected) {
    console.log(`${rel(CONTRACT_PATH)} already up to date.`);
    return;
  }
  mkdirSync(dirname(CONTRACT_PATH), { recursive: true });
  writeFileSync(CONTRACT_PATH, expected);
  console.log(`Wrote ${rel(CONTRACT_PATH)}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
