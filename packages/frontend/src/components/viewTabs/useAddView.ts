import { useCallback, useEffect, useMemo, useState } from "react";
import { HANDWRITING_LAYOUT } from "@onden/markdown";
import { CONTENT_LAYOUT } from "@onden/markdown/contract";
import { FileText, LayoutDashboard } from "lucide-react";
import type { FieldDef } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useCanvasImported, useModuleFilter } from "../../hooks/useModuleFilter";
import { NOTE_VIEW_MODULES, hiddenNoteViewLayouts } from "../../modules";
import { useOwnerViews } from "../../lib/ownerViews";
import { autoViewName, buildViewTabs, CANVAS_TAB, CONTENT_TAB, freeViewName, type ViewTab } from "../../lib/viewTabs";
import { reads, type ViewOwner } from "../../lib/data";
import { layoutChoices, placementChanges, viewNameParts, type LayoutChoice } from "../collections";
import { useViewTabActions } from "./useViewTabActions";
import { isWhiteboardLayout } from "../../lib/whiteboardNote";

// The one answer to 「what can be added to this page, and what happens when it
// is chosen」 (a kind the page already has: go to its tab): the 「＋」 of a page's tab row, a note's and a tag's.
// It lists `choices`, asks for the field of a choice that has `param` with the collections' LayoutChooser, and calls `add`.

export type AddViewSource = {
  /** 「內容」 when the note's tab is hidden, the whiteboard when it is on and the page has none, then every built-in view. */
  choices: LayoutChoice[];
  /** The fields a calendar, board or cards view could be placed by. */
  fields: FieldDef[];
  ownerKind: "tag" | "node";
  busy: boolean;
  /** Add the view (the field is "" when the choice takes none or is automatic)
   *  and open its tab. A refusal was reported by the writer; nothing opens. */
  add: (choice: LayoutChoice, field: string) => Promise<void>;
};

type Tabs = ReturnType<typeof useViewTabActions>;

/** The tabs of one page, as the tab row shows them. `owner` null: no page. */
export function useOwnerTabs(owner: ViewOwner | null, opts: { earnsWhiteboard: boolean; canManage: boolean; activeKey: string }) {
  const t = useT();
  const canvasImported = useCanvasImported();
  const hiddenLayouts = useHiddenLayouts(owner?.kind ?? "node");
  const { views, status } = useOwnerViews(owner);
  const { earnsWhiteboard, canManage, activeKey } = opts;
  const tabs = useMemo(() => buildViewTabs({
    views, canvasImported, canManage,
    // A page opened on its whiteboard keeps the tab while it is open.
    earnsWhiteboard: earnsWhiteboard || activeKey === CANVAS_TAB,
    // A tag has no 「內容」: its first tab is the list of its tagged notes.
    contentName: owner?.kind === "tag" ? t("List") : t("Content"), whiteboardName: t("Canvas"), hiddenLayouts,
    // A note's 「內容」 can be removed from the row (a tag's first tab, its list, cannot).
    contentHideable: owner?.kind === "node" && canManage,
  }), [views, canvasImported, canManage, earnsWhiteboard, activeKey, owner?.kind, t, hiddenLayouts]);
  return { views, status, tabs };
}

/** The note-view layouts whose tab is not shown (modules hiddenNoteViewLayouts). */
function useHiddenLayouts(ownerKind: "tag" | "node"): ReadonlySet<string> {
  const on = useModuleFilter();
  return useMemo(
    () => hiddenNoteViewLayouts(on, ownerKind),
    [on, ownerKind],
  );
}

/** Whether the note's own content is already a page surface — a handwriting note (`ink_data`) or a PDF (`pdf_url`).
 *  Those are not offered a 「手寫」 tab (two drawings on one note would be two things for the later conversion of the
 *  old kinds to merge, and a PDF's export skips them). Read only while the 「＋」 is open (`active`): a handwriting note's
 *  `ink_data` is the whole drawing, and opening a note must not fetch it twice. Unknown until the read answers:
 *  not offered meanwhile. */
function useHasPageSurface(ownerId: string | undefined, ownerKind: "tag" | "node", active: boolean): boolean {
  const [has, setHas] = useState(true);
  useEffect(() => {
    if (!active || !ownerId || ownerKind !== "node") return;
    let cancelled = false;
    setHas(true);
    void reads.notes.attributeValues(ownerId, ["ink_data", "pdf_url"] as const)
      .then((v) => { if (!cancelled) setHas(v.ink_data != null || !!v.pdf_url); })
      .catch(() => { if (!cancelled) setHas(false); });
    return () => { cancelled = true; };
  }, [ownerId, ownerKind, active]);
  return has;
}

export function useAddView(args: {
  ownerId?: string;
  /** The 「＋」 panel is open: what only the open panel needs is read now (see useHasPageSurface). */
  open?: boolean;
  tabs: readonly ViewTab[];
  actions: Tabs;
  fields: FieldDef[];
  ownerKind: "tag" | "node";
  onSelect: (key: string) => void;
}): AddViewSource {
  const { ownerId, open = false, tabs, actions, fields, ownerKind, onSelect } = args;
  const canvasImported = useCanvasImported();
  const offerWhiteboard = canvasImported && !tabs.some((tab) => tab.kind === "canvas");
  // A tag's list is always a tab, so only a note whose 「內容」 was removed is offered it back.
  const offerContent = ownerKind === "node" && !tabs.some((tab) => tab.kind === "content");
  // A kind the page already has a tab of is listed as there; choosing it opens that tab.
  const firstTabOf = useCallback((layout: string) => tabs.find((tab) => tab.kind === "view" && tab.view?.layout === layout)?.key ?? null, [tabs]);
  const hidden = useHiddenLayouts(ownerKind);
  const hasPageSurface = useHasPageSurface(ownerId, ownerKind, open);
  const choices = useMemo<LayoutChoice[]>(() => [
    ...(offerContent ? [{ layout: CONTENT_LAYOUT, title: "Content", Icon: FileText }] : []),
    ...(offerWhiteboard ? [{ layout: "canvas", title: "Canvas", Icon: LayoutDashboard }] : []),
    ...layoutChoices().map((choice) => (firstTabOf(choice.layout) ? { ...choice, present: true } : choice)),
    // A way of seeing this note drawn from its own text (「簡報」), while its module is on.
    ...NOTE_VIEW_MODULES.filter((mod) => ownerKind === "node" && !hidden.has(mod.id) && !(mod.id === HANDWRITING_LAYOUT && hasPageSurface && !firstTabOf(mod.id)))
      .map((mod) => ({ layout: mod.id, title: mod.library.title, Icon: mod.library.Icon, ...(firstTabOf(mod.id) ? { present: true } : {}) })),
  ], [offerContent, offerWhiteboard, firstTabOf, hidden, ownerKind, hasPageSurface]);
  const { create, addWhiteboard, addContent } = actions;

  const add = useCallback(async (picked: LayoutChoice, chosen: string) => {
    if (picked.layout === CONTENT_LAYOUT) { await addContent(); onSelect(CONTENT_TAB); return; }
    if (isWhiteboardLayout(picked)) { await addWhiteboard(); onSelect(CANVAS_TAB); return; }
    const existing = firstTabOf(picked.layout);
    if (existing) { onSelect(existing); return; }
    const visible = ["title", ...fields.map((f) => f.name ?? f.key ?? "").filter(Boolean), "updated_at"];
    const input: Parameters<typeof create>[0] = { name: "", layout: picked.layout, visible_fields: visible };
    if (picked.param && chosen) Object.assign(input, placementChanges(picked.param, chosen, { visible_fields: visible }));
    input.name = freeViewName(autoViewName(viewNameParts({ ...input, layout: picked.layout }, fields)), actions.takenNames);
    const id = await create(input);
    if (id) onSelect(id);
  }, [addContent, addWhiteboard, create, fields, firstTabOf, onSelect, actions.takenNames]);

  return { choices, fields, ownerKind, busy: actions.busy, add };
}
