// ESLint flat config — frontend.
//
// Primary purpose right now is enforcing the "no inline style={{}}" rule
// (per joplin-dev/readme/dev/spec/desktop_styling.md). Static styles must
// move to per-component CSS files; genuinely dynamic per-instance values
// (computed positions, runtime-driven colors) use CSS custom properties
// passed via style={{ "--x": ... }} — which is allowed by the regex.
//
// References:
//   - joplin-dev/.eslintrc.js (rule set inspiration; we drop their globals)
//   - joplin-dev/readme/dev/spec/desktop_styling.md (RSCSS + no-inline)

import js from "@eslint/js";
import typescriptParser from "@typescript-eslint/parser";
import typescriptPlugin from "@typescript-eslint/eslint-plugin";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import restrictInlineStyle from "./eslint-rules/restrict-inline-style.js";
import writesThroughData from "./eslint-rules/writes-through-data.js";
import readsThroughData from "./eslint-rules/reads-through-data.js";
import timeThroughLabels from "./eslint-rules/time-through-labels.js";
import modalsThroughUiModal from "./eslint-rules/modals-through-ui-modal.js";
import moduleEntry from "../../eslint-rules/module-entry.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const moduleEntryOptions = {
  src: fileURLToPath(new URL("./src", import.meta.url)),
  allow: JSON.parse(readFileSync(new URL("./eslint-rules/module-entry-allowlist.json", import.meta.url), "utf8")),
};

// Boot and auth plumbing that may import the api() transport directly
// (reads-through-data, depth audit D11): a file that must run before the data
// layer loads, or is the session itself. Add one only with a comment saying
// why. Empty today: boot and login already live in lib/data and lib/api, and
// the public site pages (src/pages/site/*.astro) are server-rendered, not linted.
const READS_ALLOWLIST = [];

// Files that may touch localStorage besides lib/prefs (depth audit D19). Add
// one only with a comment saying why. src/pages/index.astro's inline theme
// script also reads it before any module loads (not linted: .astro).
const STORAGE_ALLOWLIST = [
  // The account scope itself (lib/prefs builds account keys on it), and the
  // last verified account it reads before sign-in for an offline cold start.
  "src/lib/accountStorage.ts",
];

// `no-restricted-syntax` selectors for every file under src (see the block that
// applies them: flat config replaces a rule's options, never merges them).
const SRC_SYNTAX_RULES = [
  {
    selector:
      "CallExpression[callee.name='fetch'] > TemplateLiteral CallExpression[callee.name='getApiBase']",
    message:
      "Do not bare-fetch a backend path — use apiFetch()/api() from lib/api.ts so the session cookie is sent cross-origin (a raw fetch 401s when frontend and backend are on different origins).",
  },
  {
    // Owner rule: the UI never shows JSON (AGENTS.md › 前端 UI 規則). Only
    // catches the direct shape; a helper that returns the string is the
    // reviewer's to catch.
    selector: "JSXElement > JSXExpressionContainer CallExpression[callee.object.name='JSON'][callee.property.name='stringify']",
    message:
      "Do not render JSON.stringify output: say it in a plain sentence (AGENTS.md › 前端 UI 規則).",
  },
  {
    selector: "CallExpression[callee.name='fetch'] > CallExpression[callee.name='apiUrl']",
    message:
      "Do not bare-fetch apiUrl() — use apiFetch()/api() from lib/api.ts so the session cookie is sent cross-origin.",
  },
];

const QUEUE_WRITE_IN_CATCH = {
  selector: "CatchClause CallExpression[callee.name='queueWrite']",
  message:
    "Do not queueWrite() inside a catch — route the write through sendOrQueue() (writeQueue.ts) so a 4xx terminal reject is never queued and silently dropped. (MEDIUM gap #5)",
};

// Files that own the on-device database (see the restricted-imports blocks).
const LOCAL_DB_OWNERS = [
  "src/lib/data/**",
  "src/lib/localDb.ts", "src/lib/localDbWorker.ts", "src/lib/localDbPersist.ts", "src/lib/localDbSchema.ts",
  "src/lib/pendingNoteProjection.ts",
];
// The one file outside packages/markdown that builds a Markdown pipeline.
const MARKDOWN_OWNERS = ["src/components/MarkdownRenderer.tsx"];

const LOCAL_DB_PATTERN = {
  group: ["**/localDb"],
  message: "lib/localDb is the data layer's: use lib/data (dataSync, localCopy or a writer) instead.",
};
// Depth audit D12: the shared data (Bootstrap) changes only through lib/data —
// a writer or an operation that owns the rule for it.
const SET_DATA_PATTERN = {
  group: ["**/appStore"],
  importNames: ["setData"],
  message: "appStore's setData is lib/data's: change shared data through a writer or a lib/data operation (e.g. noteStructure, collectionWriter.adoptCollections).",
};
const MARKDOWN_PATTERN = {
  group: ["unified", "remark-*", "rehype-*", "react-markdown", "micromark*", "mdast-*"],
  message: "Markdown is parsed in @onden/markdown only: use its exports (parseGfmTree, blockAnchors, renderedWikilinks…) or add one there instead of building a parser here.",
};

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        FormData: "readonly",
        File: "readonly",
        Blob: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLDivElement: "readonly",
        HTMLButtonElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLSelectElement: "readonly",
        Element: "readonly",
        Event: "readonly",
        MouseEvent: "readonly",
        KeyboardEvent: "readonly",
        PointerEvent: "readonly",
        TouchEvent: "readonly",
        DragEvent: "readonly",
        ClipboardEvent: "readonly",
        FocusEvent: "readonly",
        ResizeObserver: "readonly",
        IntersectionObserver: "readonly",
        MutationObserver: "readonly",
        AbortController: "readonly",
        crypto: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        indexedDB: "readonly",
        IDBDatabase: "readonly",
        IDBTransaction: "readonly",
        IDBObjectStore: "readonly",
        location: "readonly",
        history: "readonly",
        performance: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        Image: "readonly",
        FileReader: "readonly",
        Worker: "readonly",
        SharedWorker: "readonly",
        ServiceWorker: "readonly",
        process: "readonly",
        Buffer: "readonly",
        global: "readonly",
        globalThis: "readonly",
        React: "readonly",
        JSX: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": typescriptPlugin,
      "react": reactPlugin,
      "react-hooks": reactHooksPlugin,
      "onden": { rules: { "restrict-inline-style": restrictInlineStyle, "writes-through-data": writesThroughData, "reads-through-data": readsThroughData, "time-through-labels": timeThroughLabels, "modals-through-ui-modal": modalsThroughUiModal, "module-entry": moduleEntry } },
    },
    settings: {
      react: { version: "19" },
    },
    rules: {
      ...typescriptPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,

      // Onden-specific style discipline: allow `style={{...}}` ONLY when
      // every property key starts with `--` (CSS custom properties — the
      // documented escape hatch for genuinely dynamic per-instance values).
      // Implementation lives in eslint-rules/restrict-inline-style.js.
      "onden/restrict-inline-style": "error",
      // A module directory is imported through its entry (../../eslint-rules/module-entry.mjs).
      "onden/module-entry": ["error", moduleEntryOptions],

      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-undef": "off",
    },
  },
  {
    // Cross-origin auth forcing function: a bare `fetch()` to a backend path
    // (the `${getApiBase()}/api/...` or `apiUrl(...)` shape) omits
    // `credentials: "include"`, so the session cookie is NOT sent when the
    // frontend and backend live on different origins → every such call 401s
    // after login. Route backend calls through `apiFetch()` (raw Response) or
    // `api<T>()` (parsed+throwing) from lib/api.ts, which set credentials.
    // api.ts itself is the one legitimate place that wraps the raw fetch.
    //
    // Flat config does not merge a rule's options across blocks: the last
    // matching block replaces the whole list. So every `no-restricted-syntax`
    // list lives in this one block, and the lib/data block below spreads
    // SRC_SYNTAX_RULES before adding its own selector (eslint-rules.test.ts
    // proves both lists are what ESLint resolves).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/api.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...SRC_SYNTAX_RULES],
    },
  },
  {
    // Forcing function for MEDIUM gap #5 (autosave reject-vs-transient):
    // queueing a write inside a `catch` hand-rolls the terminal-vs-transient
    // decision and gets it wrong — a 4xx (validation/permission) reject ends
    // up queued, the reconnect drain silently drops it, and the bootstrap then
    // clobbers the optimistic local copy after the user was told "saved".
    // The single chokepoint that gets this right is `sendOrQueue`
    // (writeQueue.ts), which RETHROWS 4xx and queues only transient. Forbid
    // `queueWrite(` inside any catch in the data layer so the decision is
    // unforgeable.
    files: ["src/lib/data/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...SRC_SYNTAX_RULES, QUEUE_WRITE_IN_CATCH],
    },
  },
  {
    // Writes go through the data layer (eslint-rules/writes-through-data.js).
    // Exempt: the data layer itself (the sync engine included) and the transport.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/data/**", "src/lib/api.ts"],
    rules: {
      "onden/writes-through-data": "error",
    },
  },
  {
    // Reads go through the data layer too (depth audit D11,
    // eslint-rules/reads-through-data.js): only lib/data and the transport
    // itself import api()/apiFetch(). A module's reads are lib/data/reads too
    // (reads.modules.*), so offline fallback, error classification and caching
    // have one owner. READS_ALLOWLIST (above) is boot and auth plumbing that
    // runs before or beside the data layer.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/data/**", "src/lib/api.ts", ...READS_ALLOWLIST],
    rules: {
      "onden/reads-through-data": "error",
    },
  },
  {
    // Restricted imports. Flat config replaces a rule's options instead of
    // merging them, so each file gets exactly one list, picked from the three
    // blocks below by who is exempt from what:
    //   - everything under src: the on-device database + the Markdown parser;
    //   - the data layer and localDb implementation: only the Markdown parser;
    //   - MarkdownRenderer.tsx: only the on-device database.
    // The on-device database and the shared store's data are the data layer's
    // (depth audit D6, D12): reads and writes of the local copy go through
    // lib/data (dataSync, localCopy, the writers), so a change of storage or
    // sync rules has one owner. Exempt: lib/data itself and the localDb
    // implementation (its worker, persistence, schema and the pending-text
    // projection it applies).
    // Markdown has one parser: @onden/markdown (render pipeline, parseGfmTree,
    // blocks, link targets…). unified/remark-*/rehype-*/micromark*/mdast-* are
    // imported only inside packages/markdown and by the renderer itself, so a
    // note never has two answers to "what is a link/task/heading here?".
    // Backend: the same rule in packages/backend/eslint.config.js.
    files: ["src/**/*.{ts,tsx}"],
    ignores: LOCAL_DB_OWNERS.concat(MARKDOWN_OWNERS),
    rules: { "no-restricted-imports": ["error", { patterns: [LOCAL_DB_PATTERN, SET_DATA_PATTERN, MARKDOWN_PATTERN] }] },
  },
  {
    files: LOCAL_DB_OWNERS,
    ignores: MARKDOWN_OWNERS,
    rules: { "no-restricted-imports": ["error", { patterns: [MARKDOWN_PATTERN] }] },
  },
  {
    files: MARKDOWN_OWNERS,
    ignores: LOCAL_DB_OWNERS,
    rules: { "no-restricted-imports": ["error", { patterns: [LOCAL_DB_PATTERN, SET_DATA_PATTERN] }] },
  },
  {
    // Dates and times have one formatter (depth audit D46,
    // eslint-rules/time-through-labels.js): lib/timeLabels in the app UI's
    // language and the workspace's zone, formatSiteDate on the published site.
    // lib/localDate reads calendar fields in a zone (not a label).
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/timeLabels.ts", "src/lib/localDate.ts", "src/components/templates/siteLocale.ts",
      "src/test/**", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}",
    ],
    rules: {
      "onden/time-through-labels": "error",
    },
  },
  {
    // Every modal is a ui/Modal (depth audit D99,
    // eslint-rules/modals-through-ui-modal.js): one owner for the top layer,
    // Esc, focus, stacking and the page's shortcuts while a modal is open.
    // components/ui is that owner.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/**", "src/test/**", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      "onden/modals-through-ui-modal": "error",
    },
  },
  {
    // localStorage has one owner (depth audit D19): lib/prefs, whose key
    // registry says whether a value belongs to the device or the signed-in
    // account and never throws. STORAGE_ALLOWLIST is the exception list.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/prefs.ts", ...STORAGE_ALLOWLIST, "src/test/**", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      "no-restricted-globals": ["error", {
        name: "localStorage",
        message: "Use lib/prefs (getPref/setPref/usePersistedFlag with a PREFS key) instead of localStorage.",
      }],
      "no-restricted-properties": ["error",
        ...["window", "globalThis", "self"].map((object) => ({
          object,
          property: "localStorage",
          message: "Use lib/prefs (getPref/setPref/usePersistedFlag with a PREFS key) instead of localStorage.",
        })),
      ],
    },
  },
  {
    files: ["src/test/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      // Tests fake or inspect the on-device database directly.
      "no-restricted-imports": "off",
      "onden/restrict-inline-style": "off",
      "onden/writes-through-data": "off",
      "onden/reads-through-data": "off",
      "onden/module-entry": "off",
    },
  },
  {
    files: ["src/components/templates/**/*.tsx"],
    // Templates render arbitrary Puck props which legitimately include
    // user-provided style overrides — exempt this directory only.
    rules: {
      "onden/restrict-inline-style": "off",
    },
  },
  {
    // Build/dev scripts are plain Node ESM (.mjs) — give them Node globals so
    // `process`/`console`/`fetch`/`Buffer`/etc. aren't flagged no-undef.
    files: ["scripts/**/*.{mjs,js}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
        globalThis: "readonly",
      },
    },
  },
  {
    // e2e specs are TypeScript run by Playwright in Node — parse them as TS
    // so a bare `eslint .` matches the npm-script baseline instead of
    // drowning in no-undef noise (review feedback 2026-06-12).
    files: ["e2e/**/*.ts"],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: { ecmaVersion: 2024, sourceType: "module" },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        require: "readonly",
        window: "readonly",
        document: "readonly",
        setTimeout: "readonly",
        URLSearchParams: "readonly",
        URL: "readonly",
        KeyboardEvent: "readonly",
        PointerEvent: "readonly",
        InputEvent: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        TouchEvent: "readonly",
        getComputedStyle: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "off",
      "no-undef": "off",
    },
  },
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-cap/**",       // capacitor build output
      "dist-published/**", // published-site bundle
      "dist-*/**",         // any other build output
      ".astro/**",
      "android/**",
      "src-tauri/**",
      // vendored/minified runtime assets — not ours to lint
      "public/pdf.worker.min.mjs",
      "public/sw.js",
      // playwright suite has its own node_modules + runner script
      "e2e/node_modules/**",
    ],
  },
];
