// ESLint flat config — backend.
//
// FOCUSED, like the frontend config's "primary purpose": the load-bearing rule
// here is the read-gate forcing function (eslint-rules/require-read-gate.js) —
// the by-construction backstop for READ authorization, the companion to the
// spine's WRITE gate. A route that serves node data on a GET must consult the
// read policy, enforced now by the editor + CI rather than only a vitest grep.
//
// We deliberately do NOT enable the full typescript-eslint rule set: this
// package's 277 files never saw a linter, and the recommended set would drown
// the signal in stylistic noise. @typescript-eslint is REGISTERED (so existing
// `// eslint-disable @typescript-eslint/...` directives resolve to a definition);
// the only rules enabled from it are the two promise rules in the type-aware
// block below (no-floating-promises, no-misused-promises). The recommended set
// can be layered in incrementally later.

import typescriptParser from "@typescript-eslint/parser";
import typescriptPlugin from "@typescript-eslint/eslint-plugin";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import requireReadGate from "./eslint-rules/require-read-gate.js";
import noRouteWrites from "./eslint-rules/no-route-writes.js";
import routeInput from "./eslint-rules/route-input.js";
import moduleEntry from "../../eslint-rules/module-entry.mjs";

const moduleEntryOptions = {
  src: fileURLToPath(new URL("./src", import.meta.url)),
  allow: JSON.parse(readFileSync(new URL("./eslint-rules/module-entry-allowlist.json", import.meta.url), "utf8")),
};

// R13/R14 (docs/research/dup-patterns-2026-10-30-be.md): the environment is read
// in config.ts, logging goes through logger.ts. The exception lists are shared
// with guards/dup-b2-infra.guard.test.ts, which keeps them exact.
const infraExceptions = JSON.parse(readFileSync(new URL("./eslint-rules/dup-b2-infra-exceptions.json", import.meta.url), "utf8"));

const MARKDOWN_OWNERS = ["src/modules/website/publishing/htmlUtils.ts"];
const MARKDOWN_PATTERN = {
  group: ["unified", "remark-*", "rehype-*", "react-markdown", "micromark*", "mdast-*"],
  message: "Markdown is parsed in @onden/markdown only: use its exports (parseGfmTree, blockAnchors, renderedWikilinks…) or add one there instead of building a parser here.",
};

export default [
  {
    files: ["src/**/*.ts"],
    // Backend has years of inline `// eslint-disable` directives predating any
    // active linter; don't flag them as unused while only the read gate runs.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      parser: typescriptParser,
      parserOptions: { ecmaVersion: 2024, sourceType: "module" },
    },
    plugins: {
      "@typescript-eslint": typescriptPlugin,
      "onden": { rules: { "require-read-gate": requireReadGate, "no-route-writes": noRouteWrites, "route-input": routeInput, "module-entry": moduleEntry } },
    },
    rules: {
      "onden/require-read-gate": "error",
      // Routes parse, call a service and answer; SQL writes live in the
      // service that owns the row (eslint-rules/no-route-writes.js).
      "onden/no-route-writes": "error",
      // Request input is read through routes/params.ts (eslint-rules/route-input.js).
      "onden/route-input": "error",
      // A module directory is imported through its entry (../../eslint-rules/module-entry.mjs).
      "onden/module-entry": ["error", moduleEntryOptions],
      // Markdown has one parser: @onden/markdown. The static-site HTML builder
      // is the one file that assembles its own unified() pipeline from the
      // package's plugin list (the ignores below); anything else that needs
      // the tree asks the package (parseGfmTree, blocks, linkTargets…).
      "no-restricted-imports": ["error", { patterns: [MARKDOWN_PATTERN] }],
      "no-restricted-properties": ["error", {
        object: "process", property: "env",
        message: "Read the environment through config.ts (config.str / config.int / config.is, isTest, isProduction).",
      }],
      "no-console": ["error"],
    },
  },
  {
    // Un-awaited promises (a dropped transaction, mutate, event or outbox write
    // is a silent lost write) need type information, so this block alone pays
    // for the TypeScript project service. Deliberately unawaited work is
    // `void p.catch(...)`-style; test files are out of scope.
    files: ["src/**/*.ts"],
    ignores: ["src/test/**/*.ts", "src/**/*.test.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["src/config.ts", "src/logger.ts", ...Object.keys(infraExceptions["process-env"])],
    rules: { "no-restricted-properties": "off" },
  },
  {
    files: ["src/logger.ts", ...Object.keys(infraExceptions.console)],
    rules: { "no-console": "off" },
  },
  {
    // The spine is the base layer: services, modules and routes call into it,
    // never the reverse. A rule the spine needs to know (space access, current
    // actor, tool scope, reserved nodes, hooks) lives in spine/.
    files: ["src/spine/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/services/**", "**/modules/**", "**/routes/**"],
          message: "spine/ must not import services/, modules/ or routes/ (dependencies point services → spine). Move the rule the spine needs into spine/.",
        }],
      }],
    },
  },
  {
    files: MARKDOWN_OWNERS,
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["src/test/**/*.ts", "src/**/*.test.ts"],
    rules: { "onden/module-entry": "off", "no-restricted-imports": "off", "no-restricted-properties": "off", "no-console": "off" },
  },
  {
    // src/test/fixtures/client-writes/*/decoders are frontend source snapshots of old
    // releases (scripts: packages/frontend/scripts/client-writes), kept verbatim.
    ignores: ["node_modules/**", "dist/**", "db/**", "eslint-rules/**", "src/test/fixtures/client-writes/*/decoders/**"],
  },
];
