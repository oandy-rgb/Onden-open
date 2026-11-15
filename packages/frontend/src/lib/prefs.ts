// The one owner of localStorage in the frontend (depth audit D19).
//
// Every stored preference is a key in PREFS below, and each key says whose it
// is: "device" (a habit of this browser, shared by whoever signs in on it) or
// "account" (it names the signed-in account's notes, tags or tasks, so it is
// stored under accountStorageKey and another account on the same browser never
// sees it). Reads and writes never throw: a private window, blocked site data
// or a full quota leaves the default in place, and an account key before the
// page is bound to an account reads as missing.
//
// Account keys that used to be stored unscoped (`migrateUnscoped`) move their
// old value to the account on first use and delete the old key, so the first
// account to open the page keeps its pins and history and later accounts
// start empty. In the native app every account key does this once, for the
// account that adopts the old unscoped native store (lib/accountStorage).
//
// "account" here only means THIS BROWSER's copy per signed-in account: it is never
// sent to the server. A value that follows the person to other devices is an account
// pref (lib/accountPrefStore, PUT /api/me/prefs/:key), whose local copy is one of
// these keys; and a pref that only makes sense on one kind of screen is never synced
// unchanged across devices (it declares `follows: "deviceKind"` there).
//
// Only this module and the allowlist in eslint.config.js touch localStorage.

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { accountStorageKey, adoptsLegacyNativeStore } from "./accountStorage";

export type Pref =
  | { readonly key: string; readonly scope: "device" }
  | { readonly key: string; readonly scope: "account"; readonly migrateUnscoped?: boolean };

export const PREFS = {
  // ── device: this browser's habits and layout ──────────────────────────────
  /** This browser's install id (lib/deviceId): device scope on purpose, so it neither follows the account nor changes on sign-in. */
  deviceId: { key: "onden.deviceId", scope: "device" },
  focusMode: { key: "onden.focusMode", scope: "device" },
  inspectorOpen: { key: "onden.inspectorOpen", scope: "device" },
  /** The notes list is folded away on its own (the top bar's left switch); focusMode folds both sides. */
  sidebarCollapsed: { key: "onden.sidebarCollapsed", scope: "device" },
  inspectorCollapsed: { key: "onden.inspectorCollapsed", scope: "device" },
  /** The info panel's tab the person last picked by hand (tags | headings). */
  infoPanelTab: { key: "onden.infoPanelTab", scope: "device" },
  canvasMinimap: { key: "onden.canvasMinimap", scope: "device" },
  /** Desktop side-pane widths in px (lib/paneWidths); absent = the stylesheet's width. */
  sidebarWidth: { key: "onden.sidebarWidth", scope: "device" },
  inspectorWidth: { key: "onden.inspectorWidth", scope: "device" },
  /** The reader's list column in px (lib/paneWidths useColumnWidth); absent = the stylesheet's width. */
  readerListWidth: { key: "onden.readerListWidth", scope: "device" },
  /** The 今天 page's layout on this screen: its widths, the folded journal column, the span of days and the phone's view. */
  todayTasksWidth: { key: "onden.todayTasksWidth", scope: "device" },
  todayTimelineWidth: { key: "onden.todayTimelineWidth", scope: "device" },
  todayJournalFolded: { key: "onden.todayJournalFolded", scope: "device" },
  todayRange: { key: "onden.todayRange", scope: "device" },
  todayPhoneView: { key: "onden.todayPhoneView", scope: "device" },
  noteWide: { key: "onden.noteWide", scope: "device" },
  /** The phone Notes home's last chosen tab (tags | nodes | inbox). */
  sidebarPane: { key: "onden.sidebar.pane", scope: "device" },
  /** The notes list's 「已隱藏」 group is open. */
  sidebarSort: { key: "onden.sidebar.sort", scope: "device" },
  sidebarTagSort: { key: "onden.sidebar.tagSort", scope: "device" },
  /** Retired: the command-palette hint is now the account's hintsSeen;
   *  only hooks/useHintOnce reads this, to carry a "1" over once. */
  paletteHintDismissed: { key: "onden.palette.hintDismissed", scope: "device" },
  /** Recently run command-palette action ids (actions, not notes). */
  paletteLastRun: { key: "onden.palette.lastRun", scope: "device" },
  /** Retired like paletteHintDismissed: the welcome card is now hintsSeen. */
  welcomeDismissed: { key: "onden.welcomeDismissed", scope: "device" },
  /** The build whose main screens this device fetched for offline use (lib/offlineWarmup). */
  offlineWarmBuild: { key: "onden.offlineWarmBuild", scope: "device" },
  exampleSeeded: { key: "onden.exampleSeeded", scope: "device" },
  /** The trial version's backup habit (lib/browserAppBackup): when the last backup was made (epoch ms), how many saves since, when it was first opened. */
  trialBackupAt: { key: "onden.trial.backupAt", scope: "device" },
  trialSavesSince: { key: "onden.trial.savesSince", scope: "device" },
  trialFirstSeenAt: { key: "onden.trial.firstSeenAt", scope: "device" },
  /** The trial version: this browser has kept a saved copy of the notes before (lib/browserAppDataMark, with a twin in IndexedDB). */
  trialHadNotes: { key: "onden.trial.hadNotes", scope: "device" },
  /** "off" disables the first-run example notes (set by hand or automation). */
  exampleSeedOptOut: { key: "onden.exampleSeed", scope: "device" },
  locale: { key: "onden.locale", scope: "device" },
  /** Keyboard shortcuts changed in Settings › Keyboard shortcuts (id → chord). */
  shortcutOverrides: { key: "onden.shortcuts", scope: "device" },
  /** Also the Settings registry's "home.landing" setting. */
  launchLanding: { key: "home.landing", scope: "device" },
  readingLastSection: { key: "onden.reading.lastSection", scope: "device" },
  /** The workspace History screen's last tab (changes | deleted). */
  historyTab: { key: "onden.history.tab", scope: "device" },
  /** The space the workspace History screen is narrowed to (a space id; absent = all spaces).
   *  Space ids belong to the account's workspace, so it is kept per account. */
  historySpace: { key: "onden.history.space", scope: "account" },
  /** The last `features.paragraph_anchors` this account's server sent ("1"/"0"), so a reopen that cannot reach the server keeps it (lib/blockAnchorStore). */
  blockAnchorsSeen: { key: "onden.blockAnchorsSeen", scope: "account" },
  /** Which headings each note has folded in the editor (lib/editorFoldStore). Only this device; it names the account's notes. */
  editorFolds: { key: "onden.editor.folds", scope: "account" },
  /** The info panel's 「關係」 tab shows its 子筆記 list (default open; one
   *  setting for every note). */
  infoSubNotesOpen: { key: "onden.info.subNotesOpen", scope: "device" },
  /** The desktop sidebar's 標籤 section is open (default open). */
  sidebarTagsOpen: { key: "onden.sidebar.tagsOpen", scope: "device" },
  /** The note's 子筆記 list under its text is folded (one setting for every note). */
  noteSubNotesFolded: { key: "onden.note.subNotesFolded", scope: "device" },
  // The month each calendar view shows (view id → YYYY-MM; absent = this month).
  calendarMonths: { key: "onden.calendarMonths", scope: "device" },
  apiBase: { key: "onden_api_base", scope: "device" },
  /** Which tab (零件／版面配置) the website studio's left column was last on. */
  siteStudioLeftTab: { key: "onden.siteStudio.leftTab", scope: "device" },
  /** The published site's reader dark-mode toggle. */
  siteDark: { key: "onden-site-dark", scope: "device" },
  /** The server's edge manifest, so an offline start still names and
   *  colours graph relations (lib/edgeKinds). Instance data, not a habit,
   *  but the same for every account on the server. */
  edgeManifest: { key: "onden.edgeManifest", scope: "device" },
  /** 「觸控筆模式」 (lib/ink/inputPolicy): with a drawing tool one finger only
   *  scrolls, the pen draws. "1" = on; default off. A device habit — the iPad
   *  with a Pencil and the phone differ. */
  inkStylusOnly: { key: "onden.ink.stylusOnly", scope: "device" },
  /** Whether the pen draws with the last drawing tool whatever the toolbar's
   *  tool is. "0" = the pen follows the toolbar; anything else (default) = it
   *  draws. A device habit, like the finger setting above (lib/inkInputPrefs). */
  inkPenDraws: { key: "onden.ink.penDraws", scope: "device" },
  /** This device's copy of what the person chose for ink (lib/inkPrefs): the
   *  quick colours with the colours they made or used lately, the shape the
   *  shape button last drew, and 「畫完停住自動修成形狀」. */
  inkPaletteCopy: { key: "onden.ink.paletteCopy", scope: "account" },
  inkShapeCopy: { key: "onden.ink.shapeCopy", scope: "account" },
  inkAutoShapeCopy: { key: "onden.ink.autoShapeCopy", scope: "account" },
  /** …and whether new shapes are filled, and the pen presets (tool + colour +
   *  thickness) the person saved. */
  /** This device's copy of the side-by-side pane (lib/splitViewStore). */
  splitPaneCopy: { key: "onden.splitPane", scope: "account" },
  inkShapeFillCopy: { key: "onden.ink.shapeFillCopy", scope: "account" },
  inkPresetsCopy: { key: "onden.ink.presetsCopy", scope: "account" },
  /** Retired by the tools model (the Hand tool replaced the finger toggle):
   *  read once by useInkInputPrefs' migration, then removed. */
  inkFingerMode: { key: "onden.ink.fingerMode", scope: "device" },
  /** Not a hint: read once by useInkInputPrefs' migration to decide whether
   *  fingers scroll (stylus mode), then removed. */
  inkPenSeen: { key: "onden.ink.penSeen", scope: "device" },

  /** What the font choices came to on this device ({ui, body}: a CSS font list or null = built-in),
   *  so boot paints with them before sign-in (lib/fontStacks). Derived from the account's choice and
   *  the fonts this device has; rewritten by lib/fontPrefs. */
  fontStacks: { key: "onden.fontStacks", scope: "device" },

  // ── account: names this account's data ────────────────────────────────────
  /** The tab each note or tag was last left on (node id → "canvas" or a view
   *  id; absent = 「內容」; lib/viewTabs). */
  noteViewTabs: { key: "onden.noteViewTabs", scope: "account" },
  /** The notes whose PDF is enlarged to fill the app (node id → true;
   *  hooks/useExpandedPane): a note left enlarged opens enlarged again. */
  expandedPanes: { key: "onden.expandedPanes", scope: "account" },
  quickCaptureDraft: { key: "onden.quickCaptureDraft", scope: "account" },
  quickCaptureTarget: { key: "onden.quickCaptureTarget", scope: "account" },
  /** The space quick-add task last wrote into (a space id; absent = none chosen yet).
   *  Space ids belong to the account's workspace, so it is kept per account. */
  quickAddTaskSpace: { key: "onden.quickAddTask.space", scope: "account" },
  /** This device's copy of the account's capture destination
   *  (modules/capture/captureDestination); the server keeps the account's. */
  captureDestinationCopy: { key: "onden.captureDestinationCopy", scope: "account" },
  /** Retired: the note new day notes go under is now the synced dayNoteParent
   *  (lib/data/dayNoteParentStore); its `legacy` (lib/accountPrefStore) moves a value still
   *  here into the account once, then removes it. */
  dayNoteParent: { key: "onden.dayNoteParent", scope: "account" },
  /** This device's copy of the note new day notes go under
   *  (lib/data/dayNoteParentStore): the server keeps the account's. */
  dayNoteParentCopy: { key: "onden.dayNoteParentCopy", scope: "account" },
  /** This device's copy of the focus length last chosen (minutes; 0 = no timer). */
  focusMinutesCopy: { key: "onden.focusMinutesCopy", scope: "account" },
  /** This device's copy of the focus cycle chosen (null: none; else rest minutes and long-break interval). */
  focusCycleCopy: { key: "onden.focusCycleCopy", scope: "account" },
  /** The focus run in progress on this device (round, break, the record waiting to end): lib/focus/focusStore. Never synced. */
  focusRun: { key: "onden.focusRun", scope: "account" },
  storagePref: { key: "onden-storage-pref", scope: "account" },
  lostWrites: { key: "onden.lostWrites", scope: "account" },
  frecency: { key: "onden.frecency", scope: "account", migrateUnscoped: true },
  /** Retired: pinned tags are now the synced sidebarTags; read once by
   *  hooks/useSidebarTagPrefs, then removed. */
  pinnedTagViews: { key: "onden.pinnedTagViews", scope: "account", migrateUnscoped: true },
  lastLocation: { key: "onden.lastLocation", scope: "account", migrateUnscoped: true },
  dueSoonFired: { key: "onden.dueSoon.fired", scope: "account", migrateUnscoped: true },
  expandedGroups: { key: "onden.expandedGroups", scope: "account", migrateUnscoped: true },
  /** Retired: the RSS reader's memory now follows the account (modules/rss/rssPrefs).
   *  Each old key below is read once to move its value up, then removed; the
   *  `…Copy` keys are this device's copy of what the server holds.
   *  RSS reading position: view ("all" or a feed id) → { id, open } of the
   *  article last read there. */
  rssReadingPosition: { key: "onden.rss.position", scope: "account" },
  rssReadingPositionCopy: { key: "onden.rss.positionCopy", scope: "account" },
  /** Retired, as above. RSS feeds whose unread number is turned on or off
   *  against the 「顯示未讀數字」 setting (feed id → "on" | "off"). */
  rssFeedCounts: { key: "onden.rss.feedCounts", scope: "account" },
  rssFeedCountsCopy: { key: "onden.rss.feedCountsCopy", scope: "account" },
  /** Retired, as above. When the RSS reader was last open (ISO time): the nav
   *  dot means "articles arrived after this". */
  rssLastVisit: { key: "onden.rss.lastVisit", scope: "account" },
  rssLastVisitCopy: { key: "onden.rss.lastVisitCopy", scope: "account" },
  /** Retired, as above. The Settings registry's 「顯示未讀數字」 ("true" | "false"),
   *  once a this-browser setting (the one device-scope key here that is retired). */
  rssShowCounts: { key: "onden.rss.showCounts", scope: "device" },
  rssShowCountsCopy: { key: "onden.rss.showCountsCopy", scope: "account" },
  /** This device's copies of the two time-zone preferences (lib/timeZonePrefs):
   *  whether to ask when the device's zone differs from the workspace's, and
   *  the device zone already answered. The server keeps the account's. */
  timeZoneAskCopy: { key: "onden.timeZone.askCopy", scope: "account" },
  timeZoneAnsweredCopy: { key: "onden.timeZone.answeredCopy", scope: "account" },
  /** This device's copy of the navigation layout (lib/navLayoutStore): the
   *  server keeps the account's, this lets it work offline. */
  navLayout: { key: "onden.navLayout", scope: "account" },
  /** This device's copy of the editor toolbars' layout (lib/toolbarLayoutStore):
   *  the server keeps the account's. */
  toolbarLayout: { key: "onden.toolbarLayout", scope: "account" },
  /** The paragraph tag panel's 「試試功能」: the functions this account has used on a
   *  paragraph (listed after the ones not tried yet) and whether the group is hidden. */
  paragraphFunctionsUsed: { key: "onden.paragraph.functionsUsed", scope: "account" },
  paragraphFunctionsHidden: { key: "onden.paragraph.functionsHidden", scope: "account" },
  /** This device's copy of the sidebar's pinned and hidden tags
   *  (lib/sidebarTagsStore): the server keeps the account's. */
  sidebarTags: { key: "onden.sidebarTags", scope: "account" },
  /** The one-time hints this account has seen (lib/hintsSeenStore): this
   *  device's copy; the server keeps the account's. */
  hintsSeen: { key: "onden.hintsSeen", scope: "account" },
  /** This device's copy of the built-in skills the person turned off for the
   *  AI's own picking (modules/skills/aiSkillsOffPref): the server keeps the account's. */
  aiSkillsOff: { key: "onden.aiSkillsOff", scope: "account" },
  /** This device's copy of the daily review cap (modules/review/reviewCapPref): the server keeps the account's. */
  reviewsPerDay: { key: "onden.reviewsPerDay", scope: "account" },
  /** This device's copy of how the review status page groups cards (modules/review/reviewGroupPref): the server keeps the account's. */
  reviewGroupBy: { key: "onden.reviewGroupBy", scope: "account" },
  /** How far into 「這次更新」 this account has read (lib/changesSeenStore): this
   *  device's copy; the server keeps the account's. */
  changesSeen: { key: "onden.changesSeen", scope: "account" },
  /** This device's copy of the paragraphs a block link was last copied for (lib/recentBlocksStore): the server keeps the account's. */
  recentBlocks: { key: "onden.recentBlocks", scope: "account" },
  /** This device's copy of the account's font choices (lib/fontPrefs): the server keeps the account's. */
  fontsCopy: { key: "onden.fontsCopy", scope: "account" },
  /** The note 「引用到筆記」 appends to by default (the last one chosen). */
  rssQuoteTarget: { key: "onden.rss.quoteTarget", scope: "account" },
  /** The week (its Monday, a date id) whose 「這週讀到的」 card was closed, on this device. */
  rssWeekCardClosed: { key: "onden.rss.weekCardClosed", scope: "account" },
} as const satisfies Record<string, Pref>;

/** A Settings-registry value (settings/useOption): its key is the setting's
 *  storageKey or id, a device preference. */
export function settingPref(storageKey: string): Pref {
  return { key: storageKey, scope: "device" };
}

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** The key this pref is stored under now; null for an account key before the
 *  page is bound to an account. Matches `StorageEvent.key` for cross-tab sync. */
export function prefKey(pref: Pref): string | null {
  if (pref.scope === "device") return pref.key;
  try { return accountStorageKey(pref.key); } catch { return null; }
}

/** Resolve the key and move an old unscoped value onto the account once. */
function resolve(pref: Pref): { store: Storage; key: string } | null {
  const store = storage();
  const key = prefKey(pref);
  if (!store || key === null) return null;
  if (pref.scope === "account" && (pref.migrateUnscoped || adoptsLegacyNativeStore()) && key !== pref.key) {
    try {
      const legacy = store.getItem(pref.key);
      if (legacy !== null) {
        if (store.getItem(key) === null) store.setItem(key, legacy);
        store.removeItem(pref.key);
      }
    } catch { /* storage full or blocked: the old value stays where it was */ }
  }
  return { store, key };
}

/** True when this pref can be read now (storage reachable and, for an
 *  account key, the page bound to an account). */
export function prefsAvailable(pref: Pref): boolean {
  const at = resolve(pref);
  if (!at) return false;
  try { at.store.getItem(at.key); return true; } catch { return false; }
}

export function getPref(pref: Pref): string | null {
  const at = resolve(pref);
  if (!at) return null;
  try { return at.store.getItem(at.key); } catch { return null; }
}

/** Store a value; false when storage is unavailable (it then lasts only for
 *  this page). */
export function setPref(pref: Pref, value: string): boolean {
  const at = resolve(pref);
  if (!at) return false;
  try { at.store.setItem(at.key, value); return true; } catch { return false; }
}

/** Forget a value; false when storage is unavailable. */
export function removePref(pref: Pref): boolean {
  const at = resolve(pref);
  if (!at) return false;
  try { at.store.removeItem(at.key); return true; } catch { return false; }
}

/** The parsed JSON value, or null when missing or unreadable. Callers check
 *  the shape: anything may have been stored by an older version. */
export function getPrefJson(pref: Pref): unknown {
  const raw = getPref(pref);
  if (raw === null) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

export function setPrefJson(pref: Pref, value: unknown): boolean {
  return setPref(pref, JSON.stringify(value));
}

/** A boolean preference kept as "1"/"0". A missing or unreadable value is
 *  `defaultValue`; every change is written through. */
export function usePersistedFlag(pref: Pref, defaultValue: boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [value, setValue] = useState<boolean>(() => {
    const raw = getPref(pref);
    return raw === "1" ? true : raw === "0" ? false : defaultValue;
  });
  useEffect(() => { setPref(pref, value ? "1" : "0"); }, [pref, value]);
  return [value, setValue];
}

/** One of a fixed set of string options. A missing value, or one this version
 *  doesn't know, is `defaultValue`; every change is written through. */
export function usePersistedChoice<T extends string>(
  pref: Pref, choices: readonly T[], defaultValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const raw = getPref(pref);
    return (choices as readonly string[]).includes(raw ?? "") ? raw as T : defaultValue;
  });
  useEffect(() => { setPref(pref, value); }, [pref, value]);
  return [value, setValue];
}
