// The saved-view layouts; each is a view module of the same id
// (docs/architecture/views-as-modules.md). Filled by registerModuleEffects from
// ModuleDefinition.viewLayout — the core never lists layouts, so a new one is a
// module directory and its line in modules/index.ts. A leaf with no imports, so
// tag membership (tagHierarchy) can name the view module tags without an import
// cycle through the module registry. Read at call time, after the registry ran.

/** What the core needs to know about a layout besides its id. */
export type ViewLayoutSpec = {
  /** How a published site draws a view of this layout (publishing/siteRows);
   *  left out, as a plain list. */
  siteViewKind?: "cards" | "table";
};

export type ViewLayout = string;

const layouts = new Map<ViewLayout, ViewLayoutSpec>();

export function registerViewLayout(id: ViewLayout, spec: ViewLayoutSpec = {}): void {
  layouts.set(id, spec);
}

/** Registered layout ids, in registry order. */
export function viewLayouts(): ViewLayout[] {
  return [...layouts.keys()];
}

export function isViewLayout(id: unknown): id is ViewLayout {
  return typeof id === "string" && layouts.has(id);
}

export function siteViewKindOf(layout: string | null | undefined): "cards" | "table" | undefined {
  return layout ? layouts.get(layout)?.siteViewKind : undefined;
}

/** The whiteboard shown as a tab on the owner's page. A stored view's `layout`
 *  may be a view module's or this one; a whiteboard view has no rows to run
 *  (its cards live on the board, canvas_memberships), the record only keeps
 *  that the tab exists, its name and its place among the tabs. Not a view
 *  module, so it never makes a view module tag. */
export const WHITEBOARD_LAYOUT = "canvas";

/** Layouts a module gives a NOTE's views (the slides' 「簡報」 tab): stored on the
 *  note like the whiteboard, with no rows to run, and — unlike a view module —
 *  no module tag and not always on: `assertLayoutImported` needs the module on.
 *  Filled by registerModuleEffects from ModuleDefinition.noteViewLayout. */
const noteLayouts = new Set<ViewLayout>();

export function registerNoteViewLayout(id: ViewLayout): void {
  noteLayouts.add(id);
}

/** The layouts modules give a note's tab row (not view modules), in registry order. */
export function noteViewLayouts(): ViewLayout[] {
  return [...noteLayouts];
}

/** A layout only a note's tab row takes (the slides' 「簡報」): a tag's views refuse it. */
export function isNoteOnlyViewLayout(id: unknown): boolean {
  return typeof id === "string" && noteLayouts.has(id);
}

export function isStoredViewLayout(id: unknown): boolean {
  return id === WHITEBOARD_LAYOUT || isViewLayout(id) || (typeof id === "string" && noteLayouts.has(id));
}
