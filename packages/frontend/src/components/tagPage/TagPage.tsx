import { Suspense, useEffect, useRef, useState } from "react";
import { useDismiss } from "../../hooks/useEscapeKey";
import type { ContentNode, Tag } from "../../lib/api";
import { useFieldUsage } from "../../hooks/useFieldUsage";
import { useModuleFilter } from "../../hooks/useModuleFilter";
import { useT } from "../../lib/i18n";
import { onTagFieldsRequest, takeTagFieldsRequest } from "../../lib/tagPageRequest";
import { dialogEntryOf, tagPageSectionsOf, isViewModuleTag } from "../../modules";
import { Button } from "../ui";
import TagDeleteConfirm from "../TagDeleteConfirm";
import TagDescription from "../TagDescription";
import { noteWriter } from "../../lib/data";
import FieldChips from "./FieldChips";
import FieldPopover from "./FieldPopover";
import FunctionsRow from "./FunctionsRow";
import HiddenTagNote from "./HiddenTagNote";
import MergePanel from "./MergePanel";
import MoveUnderPanel from "./MoveUnderPanel";
import TagActionsMenu from "./TagActionsMenu";
import TagBreadcrumb from "./TagBreadcrumb";
import TagHead from "./TagHead";
import TagMembers from "./TagMembers";
import { tagFieldModel } from "./fieldModel";
import { tagFunctionModel } from "./functionModel";
import { tagMembersModel } from "./membersModel";
import { useTagStructure } from "./structure/useTagStructure";
import { tagTreeModel } from "./tagTreeModel";
import { useTagHide } from "./useTagHide";
import { useTagMerge } from "./useTagMerge";
import { tagDisplayName } from "../../lib/tagFunctions";
import "../functionCatalog";
import "./strings";
// Shared with TagDeleteConfirm (the phone tag list), so it stays outside the module. Last, so these rules load after the stylesheets of the components above (as before the split).
import "../TagsPanel.css";
import "../SchemaLens.css";
import "./TagPage.css";

// A tag is a node whose page opens on its NOTES: a breadcrumb (全部標籤 ›
// its path), the title with the ⋯ menu, a line of description
// (the tag's own body, edited in place by the owner; more than three lines
// fold), the tag's FIELDS and FUNCTIONS as two rows of chips, then the members
// (their views are tabs above the page).
//   • Fields: a chip per field (type, name); pressing one opens its settings in
//     a popover (FieldPopover — the table view's column names open the same
//     one); chips drag to reorder; 「＋ 欄位」 adds one.
//   • Functions: what notes with the tag get — 「複習 ×」; the × takes it off.
//     A tag can no longer be given a new function from here (2026-11-12,
//     docs/architecture/module-library.md); one it already holds whose module
//     is off is 「還沒開」 and 「開啟」 turns it on, asking once first when it
//     spends money, reaches outside websites or publishes (ModuleImportConfirm).
//   • ⋯: move under another tag, merge, hide, delete (and export).
// There is no separate structure panel: everything that shapes the tag is on
// the page, for the owner; non-owners see the same rows without the controls
// and fill values in their notes.
// A function's module tag (#複習) has it by itself, and a tag gets it by
// extending that tag; the row says what the tag provides (computed by the
// server through extends); field editing waits for the full current settings
// from /api/tags. Function and membership writes keep separate authority.
// The tag tree is the sidebar's; the breadcrumb leads back to 全部標籤.
//
// This file only wires the page: state of one job lives in its own hook
// (structure/useTagStructure, useTagMerge, useTagHide), what is derived from
// the tags lives in the *Model.ts files, and each part of the page is a
// component of its own.

export type TagPageProps = {
  /** The class_tag — the data.tags entry whose id matches the focused node. */
  tag: Tag;
  online: boolean;
  /** Refresh app data so the saved schema propagates to instances/inspector. */
  onSaved?: () => void;
  /** Tana supertag-page: the tag page leads with its INSTANCES. */
  nodes?: ContentNode[];
  onOpenNode?: (id: string) => void;
  /** Every workspace tag — the merge target picker offers all OTHER tags. */
  allTags?: Tag[];
  /** Offline-capable node delete (nodeActions.delete) — a tag IS a node, so
   *  deleting it must queue offline like any other delete, not raw-api fail. */
  /** Resolves true when the delete was accepted or queued. The handler reports
   *  its own success and failure notices. */
  onDeleteNode?: (id: string, title?: string) => Promise<boolean>;
  /** The viewer may edit this tag's structure — the workspace owner
   *  (lib/capabilities canEdit of a class_tag): its functions, fields,
   *  parent and description. Presentation only; the server checks current
   *  authority. */
  canManage?: boolean;
  /** 「全部標籤」 in the breadcrumb: the Tags page. */
  onOpenTagsOverview?: () => void;
};

export default function SchemaLens(props: TagPageProps) {
  return <TagPage key={props.tag.id} {...props} />;
}

function TagPage({ tag, online, onSaved, nodes = [], onOpenNode, allTags = [], onDeleteNode, canManage = false, onOpenTagsOverview }: TagPageProps) {
  const isImported = useModuleFilter();
  const t = useT();
  // The one ability panel open on this page (a review session), by id.
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  const structure = useTagStructure({
    tag, online, onSaved,
    onFunctionRemoved: (id) => setOpenPanel((open) => open === id ? null : open),
  });
  // P2 safe-delete: the confirm (components/TagDeleteConfirm) states the
  // blast radius in plain language before anything happens.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  // Back and Esc close the open panel under the tag's rows (a function's, or 「移到…」), the newest first.
  useDismiss(() => setMoveOpen(false), moveOpen);
  useDismiss(() => setOpenPanel(null), openPanel !== null);
  const merge = useTagMerge({ tag, allTags, onSaved, onOpenNode });
  const hide = useTagHide(tag, canManage);
  // P2 migration preview: per-field usage counts so the field popover can show
  // "{n} in use" and pause before removing a populated field. `null` =
  // usage UNKNOWN (still loading, or the fetch failed) — the badge is the
  // safety signal before destructive edits, so a failed fetch must read as
  // "unknown", never as "unused".
  const fieldUsage = useFieldUsage(tag.id);

  // A view module's tag (#表格, #月曆…) has no fields or functions of its own:
  // its page only gathers the tags that use the view (V4), so it has no
  // structure to edit.
  const canEditStructure = canManage && !isViewModuleTag(tag);
  // A note's 「編輯 #X 的欄位 →」 opens the page with the fields row in focus (lib/tagPageRequest).
  const fieldsRow = useRef<HTMLDivElement>(null);
  const [wantsFields] = useState(() => takeTagFieldsRequest(tag.id) && canEditStructure);
  const focusFields = () => {
    fieldsRow.current?.scrollIntoView?.({ block: "nearest" });
    fieldsRow.current?.querySelector<HTMLElement>("button")?.focus();
  };
  useEffect(() => { if (wantsFields) focusFields(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, as the page opens
  useEffect(() => onTagFieldsRequest(tag.id, () => { if (canEditStructure) focusFields(); }), [tag.id, canEditStructure]);

  const tree = tagTreeModel(tag, allTags);
  const fns = tagFunctionModel(tag, isImported);
  const fieldModel = tagFieldModel(tag, structure.draft.fields, tree, nodes, canManage);
  const { extenderIds, childTagIds, instances } = tagMembersModel(tag, allTags, tree, nodes);
  const OpenPanel = fns.abilities.find((fn) => fn.id === openPanel)?.panel?.Component;
  const tagNode = nodes.find((node) => node.id === tag.id);
  // A module's own tag (#技能) carries the module's add dialog.
  const dialogEntry = tag.schema_module && isImported(tag.schema_module) ? dialogEntryOf(tag.schema_module) : undefined;

  /** 「開啟」 on a function the tag already has whose module is off. */
  const importFunction = (id: string) => void structure.turnOnFunction(id);

  /** The description is the tag's own body, saved like a note body. */
  async function saveDescription(markdown: string, base: string) {
    try {
      await noteWriter.patch(tag.id, { markdown }, { baseMarkdown: base });
      await onSaved?.();
    } catch { /* the writer reported it */ }
  }

  return (
    <div className="schema-lens tag-page">
      <div className="tag-page-main">
      <TagBreadcrumb tagName={tagDisplayName(tag)} ancestors={tree.ancestors} onOpenNode={onOpenNode} onOpenTagsOverview={onOpenTagsOverview} />
      <TagHead tag={tag} parentPath={tree.parentPath} savingLabel={structure.savingNotice}>
        <TagActionsMenu tag={tag} hide={hide} mergeDisabled={!online || merge.candidates.length === 0}
          onMove={canEditStructure && !tag.schema_module ? () => setMoveOpen(true) : undefined}
          onMerge={merge.toggle} onDelete={() => setDeleteOpen(true)} />
      </TagHead>
      {structure.importerElement}

      <HiddenTagNote hide={hide} />

      <TagDescription markdown={tagNode?.markdown ?? tag.markdown ?? ""} canEdit={canManage && !!tagNode} onSave={saveDescription} />

      <div ref={fieldsRow}>
        <FieldChips tag={tag} draft={structure.draft} fieldModel={fieldModel} tree={tree} canManage={canEditStructure} />
      </div>
      <FunctionsRow tag={tag} online={online} canManage={canEditStructure} fns={fns} tree={tree}
        openPanel={openPanel} busy={structure.changeDisabled || structure.functionBusy !== null}
        onTogglePanel={(id) => setOpenPanel((open) => open === id ? null : id)}
        onRemove={(id) => void structure.removeFunction(id)} onTurnOn={importFunction} onSaved={onSaved} />
      {structure.message && <p role="status" className="tag-ability-message">{structure.message}</p>}
      {!online && canEditStructure && <p className="schema-lens-hint">{t("Connect to change functions.")}</p>}

      <MergePanel tagName={tag.name} merge={merge} pathOf={tree.pathOf} />
      {moveOpen && <MoveUnderPanel tag={tag} tree={tree} disabled={structure.changeDisabled} onMove={structure.moveUnder} onClose={() => setMoveOpen(false)} />}
      {deleteOpen && <TagDeleteConfirm tag={tag} onDeleteNode={onDeleteNode} onDone={onSaved} onCancel={() => setDeleteOpen(false)} />}

      {dialogEntry && (
        <p className="tag-page-module-action">
          <Button size="sm" disabled={!online} onClick={() => dialogEntry.open({ onOpenNode: (id) => onOpenNode?.(id) })}>
            <dialogEntry.Icon size={14} aria-hidden="true" />{t(dialogEntry.label)}
          </Button>
        </p>
      )}

      {tagPageSectionsOf(isImported).map(({ moduleId, Section }) => (
        <Suspense key={moduleId} fallback={null}>
          <Section tag={tag} online={online} canManage={canManage} onOpenNode={(id) => onOpenNode?.(id)} />
        </Suspense>
      ))}

      {OpenPanel && (
        <div className="tag-module-review">
          <Suspense fallback={<p>{t("Loading…")}</p>}>
            <OpenPanel tagId={tag.id} tagName={tag.name} online={online} onOpenNode={(id) => onOpenNode?.(id)} onChanged={onSaved} />
          </Suspense>
        </div>
      )}

      <TagMembers tag={tag} instances={instances}
        childTags={childTagIds.flatMap((id) => tree.tagById.get(id) ?? [])}
        extenderTags={extenderIds.flatMap((id) => tree.tagById.get(id) ?? [])}
        fieldModel={fieldModel} onOpenNode={onOpenNode} />

      </div>

      <FieldPopover tag={tag} draft={structure.draft} fieldModel={fieldModel} fieldUsage={fieldUsage} canManage={canEditStructure} />
    </div>
  );
}
