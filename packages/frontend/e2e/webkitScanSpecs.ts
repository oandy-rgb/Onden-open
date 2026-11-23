// The one table the WebKit / iPhone / iPad scan runs from (playwright.webkit-scan.config.ts, nightly workflow): which spec runs on which project.
// Safari's engine breaks differently from Chromium's: this is the @critical set, the cross-engine specs, and every
// handwriting / ink spec (touch and pen input is where iPad Safari differs most). Add a spec here, nowhere else.
//
// Every spec names the projects whose LAYOUT it is written for, so a red in the scan means Safari differs, not that a desktop spec ran at phone size:
//   DESKTOP       – waits for desktop-only chrome (`.sidebar-tab` Inbox, `.user-chip`, `.palette-trigger`, `.app-topbar`).
//   (the iPhone and the iPad Pro 11, 834 px wide and so below the desktop breakpoint, both get the phone layout; no spec is phone-only yet.)
//   EVERY_SIZE    – sets its own viewport / touch input or finds both navigations, so it is meaningful at every project.
// Plain names (no folders, no regex): `unmatchedScanSpecs` checks each one names a real spec file;
// `invalidScanSpecs` rejects an entry that names no project or an unknown one, instead of silently running it nowhere.
export const SCAN_PROJECTS = ["webkit", "mobile-safari", "ipad"] as const;
export type ScanProject = (typeof SCAN_PROJECTS)[number];

const DESKTOP: readonly ScanProject[] = ["webkit"];
const EVERY_SIZE: readonly ScanProject[] = SCAN_PROJECTS;
// crossbrowser picks `.mobile-bottom-nav` only for project names starting with "mobile" and `.app-primary-nav` otherwise: the iPad (phone layout, name "ipad") fits neither.
const DESKTOP_AND_IPHONE: readonly ScanProject[] = ["webkit", "mobile-safari"];

export const WEBKIT_SCAN: Readonly<Record<string, readonly ScanProject[]>> = {
  approvalGate: DESKTOP, authGate: EVERY_SIZE, crossbrowser: DESKTOP_AND_IPHONE, dailyDriver: EVERY_SIZE, dailyDriverDesktop: DESKTOP,
  editorLinkFollow: EVERY_SIZE, firstRunBuildSite: EVERY_SIZE, inboxGovernance: DESKTOP,
  inkCanvas: EVERY_SIZE, inkColdStart: DESKTOP, inkFingerTools: EVERY_SIZE, inkNote: DESKTOP, inkTouch: EVERY_SIZE, pdfInk: EVERY_SIZE,
  offlineHandwriting: DESKTOP,
  "kanban-dnd": EVERY_SIZE, mobileBackScroll: EVERY_SIZE, mobileBottomGutter: EVERY_SIZE, mobileCanvasLens: EVERY_SIZE, mobileDeleteButton: EVERY_SIZE,
  mobileListScroll: EVERY_SIZE, mobileNotesScroll: EVERY_SIZE, mobileTabsFlush: EVERY_SIZE, notesTagsTab: EVERY_SIZE, "note-templates": EVERY_SIZE,
  "offline-capture-sync": DESKTOP, offlineTaskTag: DESKTOP, publishing: EVERY_SIZE, smoke: EVERY_SIZE, syncStatus: DESKTOP, "table-inline-edit": EVERY_SIZE,
};
// Kept for callers that only need the names.
export const WEBKIT_SCAN_SPECS: readonly string[] = Object.keys(WEBKIT_SCAN);

/** `testMatch` for the scan projects. */
export const webkitScanMatch = (specs: readonly string[] = WEBKIT_SCAN_SPECS): RegExp =>
  new RegExp(`(?:^|[\\\\/])(${specs.map((s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|")})\\.spec\\.ts$`);

/** Entries of `specs` that match no file in `fileNames` (a renamed or deleted spec would otherwise just stop running). */
export const unmatchedScanSpecs = (fileNames: readonly string[], specs: readonly string[] = WEBKIT_SCAN_SPECS): string[] =>
  specs.filter((s) => !fileNames.includes(`${s}.spec.ts`));

/** Entries of `table` that run on no project, or name a project the scan does not have. Empty means the table is usable. */
export const invalidScanSpecs = (table: Readonly<Record<string, readonly string[] | undefined>> = WEBKIT_SCAN): string[] =>
  Object.entries(table).flatMap(([spec, on]) =>
    !on?.length ? [`${spec}: no project declared`]
      : on.filter((p) => !(SCAN_PROJECTS as readonly string[]).includes(p)).map((p) => `${spec}: unknown project "${p}"`));

/** The specs one scan project runs. */
export const scanSpecsFor = (project: ScanProject, table: Readonly<Record<string, readonly string[]>> = WEBKIT_SCAN): string[] =>
  Object.entries(table).filter(([, on]) => on.includes(project)).map(([spec]) => spec);
