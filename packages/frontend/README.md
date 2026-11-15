# Onden Frontend

Astro + React UI for the Onden knowledge management substrate.

## Local

```bash
npm install
npm run dev
```

The browser reads `PUBLIC_API_BASE_URL`, defaulting to
`http://localhost:8787`.

## Workspace modes

The `BuilderApp` shell switches between several full-window modes:

- **Notes** — Knowledge graph + per-node Overview editor (default)
- **Tags** — Tag designer (schema, policy, behaviour, import)
- **Tasks** — Workspace-wide list of `node_tasks`
- **Website** — Home-page studio for the published site (Puck on desktop, a list editor on phones) and publish preview
- **Timeline** — Per-node version + cross-node event feed
- **Canvas** — Free-form whiteboard (Obsidian Canvas / Heptabase style)

Side rails: `OverviewSidebar` (left), `InspectorPanel` (right), command palette
(`Cmd/Ctrl+K`).

## Editor — Path C (markdown-primary, opt-in block)

`MarkdownEditor` is built on CodeMirror 6 + react-markdown with the
Obsidian-shape feature set:

- `^block-id` — opt-in block ID (popup via `^` + space)
- `[[note]]`, `[[note/words]]` — wikilink + a link to one paragraph of a note (the paragraph is a server-side anchor; the text carries no id; the old `[[note#^id]]` still reads)
- `key:: value`, `[key:: value]` — inline attribute (Dataview convention)
- `#tag`, `#key=value` — hashtag + compact attribute
- `---\n…\n---` YAML frontmatter — file-level attributes
- Slash menu (`/`) — block / heading / list / callout / query inserts

Each surface flows into `node_attributes` server-side via the body-save
pipeline. Render-time plugins (`remarkBlockId`, `remarkInlineAttrs`,
`stripFrontmatter`) hide marker syntax from the read view.

## Key components

- `BuilderApp.tsx` — top-level shell + mode switcher
- `KnowledgeWorkspace.tsx` — graph + CardNode renderer
- `CanvasMode.tsx` — ReactFlow whiteboard with grouped cards
- `OverviewEditor.tsx` — single-node editor (title + body + attrs)
- `NodeAttributesPanel.tsx` — schema-driven attribute rows + dispatcher cells
- `TagsMode.tsx`, `TagsPanel.tsx` — class-tag designer (schema / policy / behaviour)
- `TimelineView.tsx` + `EventLogPanel.tsx` — version history + audit feed
- `SandboxWorkspace.tsx`, `SandboxPanel.tsx` — CoW sandbox + pending review
- `modules/website/studio/`, `modules/website/phone/` — the home-page studio; `components/siteFrame/` + `pages/site/` — the published pages (Astro SSR)
- `MarkdownRenderer.tsx` — Obsidian-shape render with `published` style variant

## Tests

```bash
npx vitest run
```

Vitest discovers `src/**/*.{test,spec}.{ts,tsx}` in jsdom, including component,
hook, data writer and local storage tests. These frontend tests do not require
the backend's PostgreSQL `DATABASE_URL`. Real browser interaction is covered by
the separate [Playwright harness and isolated full-stack suite](e2e/README.md).

Tests run in a random order: files and the tests inside each file are
shuffled (`sequence.shuffle` in `vitest.config.ts`), so a test may not rely on
what an earlier one left behind. The seed is printed at the top of every run
(`Running tests with seed "1760850000000"`). To rerun a failing order:

```bash
npx vitest run --sequence.seed=1760850000000            # the whole run
npx vitest run --sequence.seed=1760850000000 src/test/X.test.tsx  # one file, same in-file order
npx vitest run --sequence.shuffle=false                  # declaration order, for comparison
```

`src/test/setup.ts` resets after every test: real timers, restored spies and
stubbed globals/env, cleared localStorage and sessionStorage, deleted
IndexedDB databases, nodes or attributes a test added to `<html>` or
`<head>`, and the body's own style and class. Testing Library unmounts what
`render()` mounted; a dialog that mounts its own root (`openModuleDialog`,
`confirmDialog`) is closed by the test that opened it. It imports no app module, so module-level stores are
reset by the tests that use them through the store's own reset hook
(`resetAppState`, `resetSpacesForTest`, …). Create spies in `beforeEach`,
not at module scope or in `beforeAll`: they are restored after each test.
Unhandled errors and rejections fail the run (vitest's default).

For the same type preparation as CI, run
`ASTRO_TELEMETRY_DISABLED=1 npx astro sync` before `npx tsc --noEmit`; also run
`npm run lint` and `npm run build`. Actual counts and results are recorded with
their source revision in the
[acceptance execution record](../../docs/archive/browser-acceptance-2026-09-21.md).

## Styles

CSS lives in `src/styles/` (shared) + per-component `.css` files. The
`styles/global.css` file is the historical bucket; after a multi-pass
refactor it sits at ~4,300 lines (down from 12,448) carrying only the
real shared foundation. Per-component CSS files import via
`import "./Component.css"` at the top of their `.tsx`.

ESLint rule `react/forbid-component-props` blocks new inline `style={{ … }}`
on most components; CSS custom properties (`style={{ "--var": value }}`)
remain the legal escape hatch for dynamic per-instance values.
