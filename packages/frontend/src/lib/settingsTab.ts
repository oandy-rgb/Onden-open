// Which settings page is open. The registry that fills each page is settings/registry.tsx.
// The pages follow the rules in docs/agents/decisions-ui.md (設定改版): one page per
// "thing", the few settings people change rarely, the current value shown on each row.
export type TabId =
  | "account"
  | "appearance"
  | "notes"
  | "capture"
  | "handwriting"
  | "navigation"
  | "notifications"
  | "shortcuts"
  | "modules"
  | "spaces"
  | "ai"
  | "language"
  | "time"
  | "data"
  | "about";

/** A tab, or one feature's own page (`module:<id>`, opened from the 功能 page;
 *  it is not a row of the settings list). */
export type SettingsTab = TabId | `module:${string}`;

/** Pages that no longer exist, and where what was on them is now. Old deep links
 *  and "go to settings" buttons keep working through `resolveSettingsTab`. */
const MOVED_TABS = {
  // 寫作 was a drawer: the toolbar went to Notes, the pen to 手寫,
  // shortcuts to 快捷鍵, quick capture to 快速記錄.
  writing: "notes",
  // 打開時 became a card row on the navigation bar page.
  launch: "navigation",
  // 功能 › 快速記錄 and 手寫 are not features (they cannot be turned off): they are pages of Settings next to 筆記.
  "module:capture": "capture",
  "module:handwriting": "handwriting",
} as const satisfies Record<string, TabId>;

/** Ids an old link may still carry (see MOVED_TABS). */
export type MovedTabId = keyof typeof MOVED_TABS;

const TAB_IDS: ReadonlySet<string> = new Set<TabId>([
  "account", "appearance", "notes", "capture", "handwriting", "navigation", "notifications", "shortcuts",
  "modules", "spaces", "ai", "language", "time", "data", "about",
]);

/** The current page for any id a link may carry: a current tab, a feature page,
 *  or a page that moved. Anything else is null. */
export function resolveSettingsTab(id: string): SettingsTab | null {
  if (TAB_IDS.has(id)) return id as TabId;
  const moved = (MOVED_TABS as Record<string, TabId>)[id];
  if (moved) return moved;
  return id.startsWith("module:") ? id as SettingsTab : null;
}
