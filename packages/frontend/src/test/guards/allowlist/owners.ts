// Who may use what — the allowlists behind allowlist.guard.test.ts. Everything not listed here is a
// violation, and since the 2026-10-31 clean-up there is no baseline to hide it in: scripts/allowlist-baseline.json
// must stay empty (strict mode, enforced by checkRule), so any violation fails the guard at once.
// An owner is a file, or a folder when it ends in "/". Add an owner only with a reason in the line, and the
// owner must be an `entry` file of the catalog (scripts/entrypoints.catalog.json); "not migrated yet" has no place. What to use instead (the text in a failure) is the
// catalog entry whose `rules` names the rule: scripts/entrypoints.catalog.json.

export interface PlatformOwner { owners: readonly string[] }

// ratchet:list PLATFORM_OWNERS
export const PLATFORM_OWNERS: Record<string, PlatformOwner> = {
  window: { owners: ["lib/", "hooks/", "components/ui/", "main.tsx"] },
  document: { owners: ["lib/", "hooks/", "components/ui/", "main.tsx"] },
  navigator: { owners: ["lib/clipboard.ts", "lib/ink/touch.ts", "lib/haptics.ts", "lib/storagePersist.ts", "lib/pushBrowser.ts", "lib/i18n.ts", "lib/shortcuts.ts", "lib/browserNetwork.ts", "lib/webLock.ts"] },
  history: { owners: ["hooks/useUrlLocation.ts", "lib/pageUrl.ts"] },
  location: { owners: ["hooks/useUrlLocation.ts", "lib/pageUrl.ts", "lib/api.ts"] },
  crypto: { owners: ["lib/uuid.ts", "lib/hex.ts"] },
  localStorage: { owners: ["lib/prefs.ts", "lib/accountStorage.ts"] },
  sessionStorage: { owners: ["lib/sessionPrefs.ts"] },
  matchMedia: { owners: ["lib/mediaQuery.ts"] },
  visualViewport: { owners: ["hooks/useVirtualKeyboard.ts"] },
  ResizeObserver: { owners: ["lib/observeSize.ts"] },
  IntersectionObserver: { owners: ["lib/noteTitleVisibility.ts", "lib/embedDom.ts"] },
  setPointerCapture: { owners: ["lib/pointerDrag.ts"] },
};

/** JSX intrinsic elements are written through components/ui; a native element there is the ui's own. */
// ratchet:list ELEMENT_OWNERS
export const ELEMENT_OWNERS: readonly string[] = ["components/ui/"];

/** Where a search / filter box may be drawn (rule fe-search-input): components/ui, whose SearchField is the one component every search box is. */
// ratchet:list SEARCH_FIELD_OWNERS
export const SEARCH_FIELD_OWNERS: readonly string[] = ["components/ui/"];

/** Stylesheets outside the app's own look: skipped by every CSS rule. */
// ratchet:list CSS_EXEMPT
export const CSS_EXEMPT: Record<string, string> = {
  "styles/tokens.css": "defines the tokens the rules ask everyone else to use",
  "styles/theme-tokens.css": "defines the tokens the rules ask everyone else to use",
  "styles/site-tokens.css": "published-site look is frozen; it does not follow app tokens",
  "styles/published-site.css": "published-site look is frozen; it does not follow app tokens",
  "styles/print-export.css": "paper for the PDF print window (fixed print colours and pt sizes on white); not the app theme, never loaded by the app",
  "components/siteFrame/": "published-site look is frozen; it does not follow app tokens",
};

/** Stylesheets that ARE data colours, not UI colours: a literal there is the data itself (rule css-color skips them). */
// ratchet:list COLOR_DATA_OWNERS
export const COLOR_DATA_OWNERS: Record<string, string> = {
  "styles/event-kinds.css": "the hue of each event kind, light and dark (lib/eventKinds.ts names the kinds)",
  "styles/syntax-highlight.css": "the code-highlighting palette, light and dark; the site's code blocks read it too",
  "modules/tasks/tasks.css": "the task status hues (overdue, today, upcoming), light and dark",
};

/** Where a layer may be pinned to the viewport (`position: fixed`): the overlay primitives. */
// ratchet:list FIXED_POSITION_OWNERS
export const FIXED_POSITION_OWNERS: readonly string[] = ["components/ui/"];

export const inOwners = (rel: string, owners: readonly string[]): boolean =>
  owners.some((o) => (o.endsWith("/") ? rel.startsWith(o) : rel === o));

/** Where a layer may be kept inside the window (`innerWidth - width`): the popover that places every floating
 *  surface, and the keyboard hook that measures how much of the window the on-screen keyboard covers. */
// ratchet:list FLOATING_PLACEMENT_OWNERS
export const FLOATING_PLACEMENT_OWNERS: readonly string[] = ["components/ui/", "hooks/useVirtualKeyboard.ts"];

/** `var(--x)` names app styles may read (rule css-legacy-token). Colours: only --ac-* (styles/tokens.css).
 *  The rest are the non-colour names the token files define, and names owned by a library. */
// ratchet:list TOKEN_PREFIX_OWNERS
export const TOKEN_PREFIX_OWNERS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /^--ac-/, reason: "the one source of colour, size, radius and font (styles/tokens.css)" },
  { pattern: /^--z-/, reason: "the layer scale (styles/tokens.css)" },
  { pattern: /^--onden-text-(xs|sm|sm2|base|md|lg|xl|2xl|3xl)$/, reason: "type-scale sizes, not colours (theme-tokens.css; the font-size PR owns their move)" },
  { pattern: /^--onden-(leading|tracking|weight|motion|ease|radius|font|control|tap|shadow|focus-ring|ui|note|sidebar|inspector)-?/, reason: "non-colour tokens of theme-tokens.css and the layout widths lib/paneWidths and settings/appearance write" },
  { pattern: /^--(font-(display|ui|sans|serif|mono)|shadow)$/, reason: "font names (theme-tokens.css and Tailwind's theme) and the shadow name; they move with the type/shadow tokens" },
  { pattern: /^--(tw|xy|puck)-/, reason: "set by Tailwind, @xyflow/react and Puck" },
  { pattern: /^--(s|website|docs)-/, reason: "the published site design's variables (@onden/site); owners' custom CSS may set --website-* and --docs-*" },
];
/** Where `--x: …` declarations do NOT count as the app defining a name: the token files and the published site. */
// ratchet:list TOKEN_DEFINITION_EXEMPT
export const TOKEN_DEFINITION_EXEMPT: readonly string[] = ["styles/tokens.css", "styles/theme-tokens.css", "styles/site-tokens.css", "components/siteFrame/"];
