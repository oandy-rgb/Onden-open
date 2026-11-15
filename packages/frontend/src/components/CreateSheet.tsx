import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Lock, Users } from "lucide-react";
import { useOnline, useTagRows, useAllNodes } from "../lib/appStore";
import { useCapabilities, useIsOwner } from "../lib/capabilities";
import { createKindsFor, type CreateKind } from "../lib/createKinds";
import { getNewNoteTarget, setNewNoteTarget, spaceTarget, topLevelSpace, writableSpaces, type NewNoteTarget } from "../lib/newNoteTarget";
import { newNotePlaceGroups, tagPlaceGroup, type PlaceChoice } from "../lib/placeGroups";
import { spaceLabel, useSpaces } from "../lib/spaces";
import { splitTagSections } from "../lib/tagTree";
import { useT } from "../lib/i18n";
import { classNames } from "../lib/utils";
import { openQuickCapture } from "../modules";
import { Button, TextField } from "./ui";
import { isEnterKey } from "../lib/keys";
import { useModuleFilter } from "../hooks/useModuleFilter";
import { useKbdHint } from "../hooks/useKbdHint";
import type { CreateFn } from "../hooks/useNodeCreation";
import { Popover, Sheet, type PopoverState } from "./ui";
import { PlacePicker } from "./PlacePicker";
import "./CreateSheet.css";

// The sidebar ＋: what to make (類型) and where it goes (放在), then one button.
// Phone: a bottom sheet; desktop: a popover from the ＋. Both draw the same
// body and run `create` (hooks/useNodeCreation), the one create entry.
//   • a note, and every kind but a tag, goes under a note (or the top level);
//     the choice is 「新筆記放在」 (lib/newNoteTarget), kept for the next ＋.
//     Quick capture does not use it: its place is its own setting
//     (modules/capture/captureDestination). 放在 is one
//     button that opens the place picker (PlacePicker) in the sheet's own
//     place — a view swap, not a second layer: a popover closes when a press
//     lands outside it, and a modal opened from it would be outside. The
//     picker groups by space when there is more than one writable space; a
//     chosen note is always in the shown space;
//   • a tag is named here first (names are unique under a parent, there is no
//     未命名 tag) and goes under a tag or the top level; that place is for this
//     tag only, picked in the same picker (one group, no space). Only the
//     owner has the 標籤 kind;
//   • the request scopes the kinds: a tag sheet shows only 標籤 (no 類型 row),
//     every other sheet leaves 標籤 out;
//   • a kind that only opens a screen (RSS) has no place to choose.
// What the picker offers is lib/placeGroups, from placementCandidates
// (lib/data) — the same rule as 「移動到…」: never a function, never a note for a tag.

/** What the sheet opens with. `tagParentId`: the tag a new tag starts under. */
export type CreateSheetRequest = { kind: "note" | "tag"; tagParentId?: string | null; /** Open with the place list showing (⋯ › 新筆記放在…). */ pickPlace?: boolean };

/** The sheet's two views: the form, and the place list that swaps in for it. */
type View = { picking: boolean; setPicking: (picking: boolean) => void };

/** The card's content (the card itself is the Sheet's or the popover's). */
function Body({ create, request, presentation, view, onClose }: { create: CreateFn; request: CreateSheetRequest; presentation: "sheet" | "popover"; view: View; onClose: () => void }) {
  const t = useT();
  const captureKeys = useKbdHint("quick-capture");
  const online = useOnline();
  const nodes = useAllNodes();
  const tags = useTagRows();
  const isOwner = useIsOwner();
  const isImported = useModuleFilter();
  // The request decides the scope: a tag sheet makes only a tag, any other
  // sheet never lists one. The owner gate stays (the sidebar offers the tag ＋
  // to the owner only, so a tag sheet is never empty).
  const tagSheet = request.kind === "tag";
  const kinds = useMemo(() => createKindsFor(isImported).filter((k) => (tagSheet ? !!k.named && isOwner : !k.named)), [isImported, isOwner, tagSheet]);
  const [kindId, setKindId] = useState<string>(() => kinds[0]?.id ?? "note");
  const kind = kinds.find((k) => k.id === kindId) ?? kinds[0];
  const { spaces } = useSpaces(online);
  const [noteTarget, setNoteTarget] = useState<NewNoteTarget | null>(getNewNoteTarget);
  const noteTargetId = noteTarget?.kind === "note" ? noteTarget.noteId : null;
  const [tagParentId, setTagParentId] = useState<string | null>(request.tagParentId ?? null);
  const [name, setName] = useState("");
  const { picking, setPicking } = view;
  const [busy, setBusy] = useState(false);

  // Places a new note / tag may go. A chosen note that is gone (trashed, now a
  // tag) reads as the top level.
  // With more than one writable space the space is its own choice and the note
  // list holds only that space's notes.
  const writable = useMemo(() => writableSpaces(spaces), [spaces]);
  const chosenNote = noteTargetId ? nodes.find((n) => n.id === noteTargetId) : undefined;
  const space = !tagSheet && writable.length > 1
    ? writable.find((s) => s.id === chosenNote?.space_id) ?? topLevelSpace(spaces, noteTarget)
    : null;
  const caps = useCapabilities(online);
  const groups = useMemo(() => {
    if (tagSheet) {
      const own = splitTagSections(tags ?? [], isImported).own.filter((tag) => !tag.schema_module);
      return tagPlaceGroup(own, caps.canEdit);
    }
    return newNotePlaceGroups(nodes, spaces, caps);
  }, [tagSheet, tags, isImported, nodes, spaces, caps]);

  // Ownership can be revoked while a tag sheet is open: nothing is left to make.
  if (!kind) return null;
  const named = !!kind.named;
  const hasPlace = named || kind.placeable;
  const placeId = named ? tagParentId : noteTargetId;
  // A chosen place that is gone (trashed, now a tag) reads as the top level.
  const current = groups.flatMap((g) => g.entries).find((e) => e.parentId === placeId) ?? null;
  const offline = !online && kind.needsServer;
  const canCreate = !busy && !offline && (!named || name.trim() !== "");

  const pickPlace = ({ spaceId, parentId }: PlaceChoice) => {
    if (named) setTagParentId(parentId);
    // 最上層 keeps the picked space: it is that space's top level, not the personal one.
    else if (parentId) pickNoteTarget({ kind: "note", noteId: parentId });
    else {
      const picked = spaceId ? writable.find((s) => s.id === spaceId) : undefined;
      pickNoteTarget(picked ? spaceTarget(picked) : null);
    }
    setPicking(false);
  };
  const pickNoteTarget = (next: NewNoteTarget | null) => { setNoteTarget(next); setNewNoteTarget(next); };
  const chooseKind = (next: CreateKind) => { setKindId(next.id); setPicking(false); };

  // A tag waits for the server's or the queue's answer: a refusal (a name taken
  // under that parent) keeps the sheet and the typed name. Other kinds report
  // their own failure and have nothing to keep.
  async function submit() {
    if (!canCreate) return;
    setBusy(true);
    try {
      if (named) {
        if (await create(kind.id, { parentId: tagParentId, name: name.trim() })) onClose();
      } else {
        const parentId = kind.placeable ? current?.parentId ?? null : null;
        await create(kind.id, space && kind.placeable && !parentId ? { parentId, spaceId: space.id } : { parentId });
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  if (picking && hasPlace) {
    return (
      <>
        <div className="create-sheet-heading">{named ? t("Put it under…") : t("Put it in…")}</div>
        <PlacePicker groups={groups} current={{ spaceId: space?.id ?? null, parentId: placeId }} currentMark="chosen"
          searchLabel={named ? t("Search tags…") : t("Search places…")}
          onPick={pickPlace} onClose={() => setPicking(false)} />
        <div className="create-sheet-actions">
          <Button onClick={() => setPicking(false)}>{t("Back")}</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="create-sheet-heading">{tagSheet ? t("New tag") : t("Create")}</div>
      {kinds.length > 1 && (
        <>
          <div className="create-sheet-label" id="create-sheet-kind-label">{t("What to create")}</div>
          <div className="create-sheet-kinds" role="radiogroup" aria-labelledby="create-sheet-kind-label">
            {kinds.map((k) => (
              <Button key={k.id} role="radio" aria-checked={k.id === kind.id}
                className={classNames("create-sheet-kind", k.id === kind.id && "is-selected")}
                disabled={!online && k.needsServer} title={!online && k.needsServer ? t("Needs a connection") : undefined}
                onClick={() => chooseKind(k)}>
                <k.Icon size={14} aria-hidden="true" />
                <span>{t(k.label)}</span>
              </Button>
            ))}
          </div>
        </>
      )}
      {named && (
        <TextField className="create-sheet-name" autoFocus value={name} disabled={busy}
          placeholder={t("New tag name…")} aria-label={t("New tag name…")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (isEnterKey(e)) { e.preventDefault(); void submit(); } }} />
      )}
      {hasPlace && (
        <Button className="create-sheet-place" disabled={busy} onClick={() => setPicking(true)}>
          <span className="create-sheet-place-label">{t("Put it in")}</span>
          <span className="create-sheet-place-name">
            {space && (space.kind === "personal" ? <Lock size={13} aria-hidden="true" /> : <Users size={13} aria-hidden="true" />)}
            {space && <>{spaceLabel(space)} › </>}
            <span className="create-sheet-place-title">{current?.title ?? t("Top level")}</span>
          </span>
          <ChevronRight size={14} aria-hidden="true" />
        </Button>
      )}
      <div className="create-sheet-actions">
        <Button onClick={onClose}>{t("Cancel")}</Button>
        <Button variant="primary" disabled={!canCreate} onClick={() => void submit()}>{t("Create")}</Button>
      </div>
      {/* The desktop topbar has no capture button; the popover (a keyboard
          device) points at the hotkey's flow. The phone has the nav's ＋. */}
      {presentation === "popover" && !tagSheet && (
        <Button variant="ghost" size="sm" className="create-sheet-capture-link" disabled={busy}
          onClick={() => { onClose(); openQuickCapture(); }}>
          {captureKeys ? t("Just one line? Quick capture {keys}", { keys: captureKeys }) : t("Just one line? Quick capture")}
        </Button>
      )}
    </>
  );
}

/** The ＋'s sheet (phone) or popover (desktop, from `popover`'s anchor). */
export default function CreateSheet({ create, request, presentation, popover, onClose }: {
  create: CreateFn;
  request: CreateSheetRequest;
  presentation: "sheet" | "popover";
  /** The ＋ it grows from; only the popover has one. */
  popover?: PopoverState<HTMLElement>;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const [picking, setPicking] = useState(request.pickPlace === true);
  const body = <Body create={create} request={request} presentation={presentation} view={{ picking, setPicking }} onClose={onClose} />;
  const cardClass = classNames("create-sheet", picking && "create-sheet-picking");
  if (presentation === "popover" && popover) {
    return <Popover popover={popover} label={t("Create")} className="create-sheet-popover"><div className={cardClass}>{body}</div></Popover>;
  }
  // The place list has a search: a steady height, so the sheet's top does not move while typing.
  return <Sheet label={t("Create")} className="create-sheet-layer" cardClassName={cardClass} steady={picking} onClose={onClose}>{body}</Sheet>;
}
