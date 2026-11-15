// ESLint flat config — frontend import boundaries as an ALLOWLIST (eslint-plugin-boundaries,
// default: "disallow"): each kind of file lists the kinds it may import, every other import is a
// violation. Not part of `npm run lint`: today's violations are counted per file in
// scripts/allowlist-baseline.json (rule fe-import-boundaries) by
// src/test/guards/allowlistBoundaries.guard.test.ts, which fails when a file gets MORE violations.
// To see them as editor-style messages: npm run lint:boundaries (exits non-zero while the baseline is not empty).
import boundaries from "eslint-plugin-boundaries";
import typescriptParser from "@typescript-eslint/parser";
import { PLATFORM_OWNERS } from "./src/test/guards/allowlist/owners.ts";

// lib/ files that own a browser capability (crypto, clipboard, prefs…): a kind of their own, so the rule can
// say they depend on nothing above lib. Owners in hooks/, settings/, components/ui and lib/data keep their folder's kind.
const PLATFORM_FILES = [...new Set(Object.values(PLATFORM_OWNERS).flatMap((o) => o.owners).filter((o) => o.startsWith("lib/") && !o.endsWith("/") && !o.startsWith("lib/data/")))]
  .map((rel) => `src/${rel}`);

export const ELEMENTS = [
  { type: "test", mode: "full", pattern: ["src/test/**", "src/**/*.test.{ts,tsx}"] },
  { type: "ui", mode: "full", pattern: "src/components/ui/**" },
  { type: "platform", mode: "full", pattern: PLATFORM_FILES },
  { type: "lib-data", mode: "full", pattern: "src/lib/data/**" },
  // The two parts of lib/ the page book (src/pagebook) may import: the ink engine, and drawing a PDF. Everything else
  // in lib/ is the app's (data, preferences, stores…). Each is "lib" for every other kind of file (LIB_KINDS below).
  { type: "lib-ink", mode: "full", pattern: "src/lib/ink/**" },
  { type: "lib-pdf", mode: "full", pattern: "src/lib/pdf/**" },
  { type: "lib", mode: "full", pattern: "src/lib/**" },
  { type: "hooks", mode: "full", pattern: "src/hooks/**" },
  { type: "components", mode: "full", pattern: "src/components/**" },
  { type: "settings", mode: "full", pattern: "src/settings/**" },
  { type: "module", mode: "full", pattern: "src/modules/*/**", capture: ["id"] },
  { type: "modules-shared", mode: "full", pattern: "src/modules/*.{ts,tsx}" },
  { type: "data", mode: "full", pattern: "src/data/**" },
  { type: "pages", mode: "full", pattern: "src/pages/**" },
  // The page book: pages stacked under one camera (backgrounds, ink, text boxes, pictures), written so it can leave
  // as a package of its own (like @onden/markdown). It reaches nothing of the app — saving, loading, translation,
  // device settings and the PDF's URL come in as props from the shell that mounts it.
  { type: "pagebook", mode: "full", pattern: "src/pagebook/**" },
  { type: "app", mode: "full", pattern: ["src/main.tsx", "src/env.d.ts", "src/AppRoot.tsx", "src/bootApp.ts", "src/browserApp/**", "src/appShell/**"] },
];

// lib/ink and lib/pdf are lib for everyone except the page book, which may name them but not the rest of lib/.
const LIB_KINDS = ["lib", "lib-ink", "lib-pdf"];
const ALL = ["ui", "platform", "lib-data", ...LIB_KINDS, "hooks", "components", "settings", "module", "modules-shared", "data", "pages", "pagebook", "app"];

export const RULES = [
  { from: "ui", allow: ["ui", "platform", ...LIB_KINDS, "hooks", "modules-shared"] },
  { from: "platform", allow: ["platform", ...LIB_KINDS] },
  { from: "lib-data", allow: ["lib-data", ...LIB_KINDS, "platform"] },
  { from: LIB_KINDS, allow: [...LIB_KINDS, "lib-data", "platform", "data", "modules-shared"] },
  { from: "hooks", allow: ["hooks", ...LIB_KINDS, "lib-data", "platform", "data", "modules-shared"] },
  { from: "components", allow: ["components", "pagebook", "ui", "hooks", ...LIB_KINDS, "lib-data", "platform", "data", "modules-shared"] },
  { from: "settings", allow: ["settings", "components", "ui", "hooks", ...LIB_KINDS, "lib-data", "platform", "data", "modules-shared"] },
  // modules-shared is the registry (modules/index, modules/types): anyone may ask it which modules exist.
  // A module reaches another module only through it, never its files.
  { from: "module", allow: [["module", { id: "${from.id}" }], "modules-shared", "components", "ui", "hooks", ...LIB_KINDS, "lib-data", "platform", "settings", "data"] },
  { from: "modules-shared", allow: ["module", "modules-shared", ...LIB_KINDS, "lib-data", "platform"] },
  { from: "data", allow: ["data", ...LIB_KINDS, "platform"] },
  // The page book may import: itself, components/ui, lib/ink and lib/pdf. React and @onden/markdown are packages, not
  // folders of this app, so no kind is needed for them. Not the app's lib/data, stores, i18n, prefs, hooks or routes.
  { from: "pagebook", allow: ["pagebook", "ui", "lib-ink", "lib-pdf"] },
  { from: "pages", allow: ALL },
  { from: "app", allow: ALL },
  { from: "test", allow: [...ALL, "test"] },
];

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: { ecmaVersion: 2024, sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    // An eslint-disable comment must not be a way around the allowlist.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off" },
    plugins: { boundaries },
    settings: {
      "boundaries/elements": ELEMENTS,
      "import/resolver": { node: { extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"] } },
    },
    rules: {
      "boundaries/element-types": ["error", { default: "disallow", rules: RULES }],
      // A new folder under src/ has to be declared as a kind above before anything imports from it.
      "boundaries/no-unknown-files": "error",
    },
  },
];
