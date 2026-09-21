import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * The repo's first linter (plan 09, D14). Two of the seven steps in the project's
 * definition of done — lint and format — could not be performed at all before it.
 *
 * Four layers, narrowest last:
 *
 *   1. Core JS rules everywhere, so `scripts/` — which gates CI — is covered too.
 *   2. typescript-eslint's `recommended` on TypeScript. Deliberately NOT
 *      `recommendedTypeChecked`: that set's `no-unsafe-*` rules fire on every
 *      `JSON.parse` and on every value crossing the WebSocket, which on this tree
 *      is several hundred errors that could only be answered with disable
 *      comments — and silencing a lint error that way is against the project
 *      rules. The four rules the plan actually asked for are enabled explicitly.
 *   3. Type-aware rules on `src/` and `tests/`, since `no-floating-promises`
 *      cannot work without a type checker.
 *   4. `scripts/` overrides, for the two things that are true there and nowhere
 *      else: it drives a browser, and it cleans up best-effort.
 *
 * Formatting is Prettier's job, not this file's. typescript-eslint's recommended
 * set carries no stylistic rules, so the two never disagree and there is no
 * `eslint-config-prettier` to keep in sync.
 */
export default tseslint.config(
  {
    // Build output, vendored copies, reference material and tooling artifacts.
    // `BKP/` alone is ~3.5k files of other people's extensions, and
    // `.local-backups/` holds whole snapshots of this tree — linting either
    // reports the same problem several times over, in files nobody can fix.
    ignores: [
      "dist/",
      "BKP/",
      ".local-backups/",
      ".commandcode/",
      ".gitnexus/",
      "node_modules/",
      // The extension is a separate package with its own toolchain and its own
      // CI job; it needs its own config, not this one reaching across.
      "Chrome-extension/",
      "coverage/",
      "assets/",
      "designs/",
    ],
  },

  js.configs.recommended,

  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: { globals: { ...globals.node } },
  },

  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ["**/*.ts"] })),

  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        // tsconfig.test.json is the one project covering BOTH src/ and tests/;
        // the base config's rootDir is src/ and cannot see the suite.
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          // `describe`/`it` from node:test return a promise BY DESIGN and are
          // meant to be called bare — the runner awaits them. Without this the
          // rule reports 174 errors across the suite whose only honest fix would
          // be 174 `void` operators. Naming the safe calls once is the fix; a
          // disable comment per file would be the silence.
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["describe", "it", "test", "before", "after", "beforeEach", "afterEach"],
            },
          ],
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
    },
  },

  {
    files: ["scripts/**/*.{js,mjs,cjs}"],
    languageOptions: {
      // These scripts drive a real browser: the bodies passed to
      // `page.evaluate()` are browser code living inside a Node file, so both
      // sets of globals are genuinely in scope. `chrome` is not in
      // `globals.browser` — it is an extension API — so it is named here.
      globals: { ...globals.node, ...globals.browser, chrome: "readonly" },
    },
    rules: {
      // `try { ws.close(); } catch {}` is the project's idiom for best-effort
      // teardown, where a failure is genuinely nothing to act on. The empty
      // block is the intent, not an omission.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
