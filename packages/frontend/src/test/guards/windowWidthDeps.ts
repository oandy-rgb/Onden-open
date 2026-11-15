// Counts the places where layout or behaviour follows the WINDOW instead of the page's own box, grouped by screen.
// Used by windowWidthDeps.guard.test.ts (the numbers may only go down) and by the plan
// docs/architecture/proposals/panes-as-pages-2026-11-16.md: two panes side by side each need to lay out from their
// own width, so every one of these is a place that must move to a container query or the pane's size class.
// `node --experimental-strip-types src/test/guards/windowWidthDeps.ts` prints the current numbers as the baseline JSON.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const KINDS = ["mediaWidth", "viewportUnit", "widthCheck", "fixedLayer"] as const;
export type Kind = (typeof KINDS)[number];
export type Counts = Record<Kind, number>;

/** Which screen a file belongs to; the first match wins. Shared pieces and the one stylesheet that mixes screens
 *  have their own groups, so a number there is a reason to split the file, not to hide it in a screen. */
export const GROUPS: readonly (readonly [string, RegExp])[] = [
  ["split-view", /^(components\/splitView\/|lib\/splitView|hooks\/useSplit)/],
  ["keyboard-insets", /^(hooks\/useVirtualKeyboard|lib\/editorKeyboard|hooks\/useEditorKeyboard)/],
  ["tasks", /^modules\/(tasks|calendar)\//],
  ["journal-today", /^modules\/daily\//],
  ["reading", /^(components\/ReadingScreen|modules\/rss\/)/],
  ["review", /^(modules\/(review|capture)\/|components\/InboxReview)/],
  ["history", /^(components\/history\/|components\/(HistoryLens|TimelineLens)|lib\/history\/)/],
  ["graph-board", /^(modules\/(graph|kanban|canvas)\/|components\/(Board|Canvas|CardNode|Card[A-Z]))/],
  ["tag-page", /^components\/(tagPage|collections|views|viewLayoutKit)\/|^components\/(SchemaLens|TagTidy|NodeLenses)/],
  ["website-slides", /^(modules\/(website|slides|gallery)\/|components\/siteFrame\/)/],
  ["settings", /^(settings\/|components\/(AccountPanel|ObsidianImport|ShellDialog))/],
  ["editor", /^(components\/(OverviewEditor|MarkdownEditor|Markdown|NoteBreadcrumb|Ink|Editor|Paragraph|ParagraphMenu|NoteActions|InlineProps|FailedWriteRecovery)|lib\/(editor|ink\/)|modules\/handwriting\/)/],
  ["info-panel", /^components\/(infoAi|infoFunctions)\/|^components\/(Info|NoteRelations|NoteTagCards|NoteEdgeOutline|NoteAi|NodeInspector|NodeAttributesPanel|PanelHeader|ExpandPane|NotePhoneAi|MemberList|NoteDecisions)/],
  ["notes-workspace", /^(components\/workspace\/|components\/(BuilderWorkspace|KnowledgeWorkspace|AppTopbar|MobileNav|Sidebar|viewTabs\/|Overview)|hooks\/(useWorkspace|useUiMode|useOverview)|lib\/paneWidths|appShell\/)/],
  ["global-css", /^styles\/global\.css$/],
  ["shared-ui", /^(components\/ui\/|components\/[A-Za-z]*(Dialog|Sheet|Menu|Palette|Picker)|styles\/|lib\/(mediaQuery|globalEvents|accountPrefStore|pageScrollRestore))/],
];
export const OTHER = "other";

export const groupOf = (file: string): string => GROUPS.find(([, re]) => re.test(file))?.[0] ?? OTHER;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? (name === "test" ? [] : walk(full)) : [full];
  });

// The one answer to "is this a phone" (lib/mediaQuery.ts, hooks/useIsMobile.ts) defines the checks; the callers are counted.
const DEFINITIONS = new Set(["lib/mediaQuery.ts", "hooks/useIsMobile.ts"]);

const css = (text: string): Counts => {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return {
    mediaWidth: (plain.match(/@media[^{]*\b(?:min-|max-)?(?:width|height)\b/g) ?? []).length,
    viewportUnit: (plain.match(/\b\d*\.?\d+(?:vw|vh|dvh|svh|lvh|vmin|vmax)\b/g) ?? []).length,
    widthCheck: 0,
    fixedLayer: (plain.match(/position:\s*fixed/g) ?? []).length,
  };
};

const ts = (text: string): Counts => {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return {
    mediaWidth: 0,
    viewportUnit: 0,
    widthCheck: (plain.match(/\b(?:useIsMobile|isMobileLayout|useMediaQuery|matchesMedia)\(|\b(?:innerWidth|innerHeight|visualViewport)\b|documentElement\.client(?:Width|Height)/g) ?? []).length,
    fixedLayer: 0,
  };
};

const zero = (): Counts => ({ mediaWidth: 0, viewportUnit: 0, widthCheck: 0, fixedLayer: 0 });

/** Every group's counts, and for each file the counts that made them (for the plan and for fixing). */
export function windowWidthDeps(): { groups: Record<string, Counts>; files: Record<string, Counts> } {
  const groups: Record<string, Counts> = {};
  const files: Record<string, Counts> = {};
  for (const full of walk(SRC_DIR).sort()) {
    const file = relative(SRC_DIR, full).split("\\").join("/");
    if (DEFINITIONS.has(file) || /\.(test|spec)\.tsx?$/.test(file)) continue;
    const counted = file.endsWith(".css") ? css(readFileSync(full, "utf8")) : /\.tsx?$/.test(file) ? ts(readFileSync(full, "utf8")) : null;
    if (!counted || KINDS.every((k) => counted[k] === 0)) continue;
    files[file] = counted;
    const group = (groups[groupOf(file)] ??= zero());
    for (const k of KINDS) group[k] += counted[k];
  }
  return { groups, files };
}

export const total = (c: Counts): number => KINDS.reduce((n, k) => n + c[k], 0);

if (process.argv[1] && process.argv[1].endsWith("windowWidthDeps.ts")) {
  const { groups } = windowWidthDeps();
  const sorted = Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)));
  console.log(JSON.stringify({
    about: "版面或行為跟著「視窗」而不是頁面自己寬度的地方，依畫面分組；只准變少（見 windowWidthDeps.guard.test.ts）",
    groups: sorted,
  }, null, 2));
}
