// The one list of specs the WebKit / iPhone / iPad scan runs (playwright.webkit-scan.config.ts, nightly workflow).
// Safari's engine breaks differently from Chromium's: this is the @critical set, the cross-engine specs, and every
// handwriting / ink spec (touch and pen input is where iPad Safari differs most). Add a spec here, nowhere else.
// Plain names (no folders, no regex): `unmatchedScanSpecs` checks each one names a real spec file.
export const WEBKIT_SCAN_SPECS: readonly string[] = [
  "approvalGate", "authGate", "crossbrowser", "dailyDriver", "editorLinkFollow", "firstRunBuildSite", "inboxGovernance",
  "inkCanvas", "inkColdStart", "inkFingerTools", "inkNote", "inkTouch", "pdfInk", "offlineHandwriting",
  "kanban-dnd", "mobileBackScroll", "mobileBottomGutter", "mobileCanvasLens", "mobileDeleteButton", "mobileListScroll",
  "mobileNotesScroll", "mobileTabsFlush", "notesTagsTab", "note-templates", "offline-capture-sync", "offlineTaskTag",
  "publishing", "smoke", "syncStatus", "table-inline-edit",
];

/** `testMatch` for the scan projects. */
export const webkitScanMatch = (specs: readonly string[] = WEBKIT_SCAN_SPECS): RegExp =>
  new RegExp(`(?:^|[\\\\/])(${specs.map((s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|")})\\.spec\\.ts$`);

/** Entries of `specs` that match no file in `fileNames` (a renamed or deleted spec would otherwise just stop running). */
export const unmatchedScanSpecs = (fileNames: readonly string[], specs: readonly string[] = WEBKIT_SCAN_SPECS): string[] =>
  specs.filter((s) => !fileNames.includes(`${s}.spec.ts`));
