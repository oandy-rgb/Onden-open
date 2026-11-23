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
import { reads, tagSchemaWriter, type ViewOwner } from "../../lib/data";
import { useTagRows } from "../../lib/appStore";
import { fieldKeyFrom, namesTakenAround, uniqueFieldKey } from "../../lib/tagFields";
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
  /** A tag's page with nothing to split a board by: gives the tag a 「狀態」 select field (to do / in progress / done)
   *  and resolves with its name; null when the writer refused (it reported why). Absent on a note's page. */
  addStatusField?: () => Promise<string | null>;
};

type Tabs = ReturnType<typeof useViewTabActions>;

/** The tabs of one page, as the tab row shows them. `owner` null: no page. */
export function useOwnerTabs(owner: ViewOwner | null, opts: { earnsWhiteboard: boolean; canManage: boolean; activeKey: string; retiredBoard?: boolean }) {
  const t = useT();
  const canvasImported = useCanvasImported();
  const hiddenLayouts = useHiddenLayouts(owner?.kind ?? "node");
  const { views, status, contentRemovable } = useOwnerViews(owner);
  const { earnsWhiteboard, canManage, activeKey, retiredBoard } = opts;
  const tabs = useMemo(() => buildViewTabs({
    views, canvasImported, canManage, earnsWhiteboard, activeKey, retiredBoard, ownerKind: owner?.kind, contentRemovable,
    // A tag has no 「內容」: its first tab is the list of its tagged notes.
    contentName: owner?.kind === "tag" ? t("List") : t("Content"), whiteboardName: t("Canvas"), hiddenLayouts,
  }), [views, canvasImported, canManage, earnsWhiteboard, activeKey, retiredBoard, owner?.kind, contentRemovable, t, hiddenLayouts]);
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
  const t = useT();
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
    // Shown only once the write was accepted: a refused one was reported by the writer, and nothing opens.
    if (picked.layout === CONTENT_LAYOUT) { if (await addContent()) onSelect(CONTENT_TAB); return; }
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

  const tags = useTagRows();
  const addStatusField = useMemo(() => {
    if (ownerKind !== "tag" || !ownerId) return undefined;
    return async () => {
      const tag = tags?.find((row) => row.id === ownerId);
      if (!tag) return null;
      // The tag's OWN list (`schema_fields`), not `fields`: that one also holds what the tags above give, and writing
      // those back would copy them here (the server refuses the names: 409 field_name_inherited).
      const own = tag.schema_fields ?? [];
      // The key is stored data and stays the same in every language; only the label is the creator's words.
      // The options have no display names (a select field's options are plain values, as typed in the tag editor).
      const key = uniqueFieldKey(fieldKeyFrom("Status"), [...own.map((f) => f.name ?? f.key ?? ""), ...namesTakenAround(tag, tags ?? [])]);
      const field: FieldDef = { name: key, label: t("Status"), type: "select", options: [t("To do"), t("In progress"), t("Done")] };
      try { await tagSchemaWriter.update(ownerId, { fields: [...own, field] }); } catch { return null; } // Reported by the tag-schema writer.
      return key;
    };
  }, [ownerKind, ownerId, tags, t]);

  return { choices, fields, ownerKind, busy: actions.busy, add, addStatusField };
}
