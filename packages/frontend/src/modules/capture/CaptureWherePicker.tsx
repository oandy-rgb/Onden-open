// "Where do captures go": the one picker for the capture sheet's 「放進」 line (this
// capture only) and for the setting (every capture with no place of its own).
// Both are the place picker the rest of the app uses (PlacePicker, lib/placeGroups):
// the top row is the inbox, a note below is "under that note", and today's
// journal is one button more while the journal is on. What is chosen is the
// caller's to keep or forget.

import { useMemo } from "react";
import { BookOpen } from "lucide-react";
import { useCapabilities } from "../../lib/capabilities";
import type { ContentNode } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { newNotePlaceGroups, type PlaceGroup } from "../../lib/placeGroups";
import { useSpaces } from "../../lib/spaces";
import { Button } from "../../components/ui";
import { PlacePicker } from "../../components/PlacePicker";
import type { CaptureDestination } from "./captureDestination";

type Props = {
  online: boolean;
  nodes: readonly ContentNode[];
  current: CaptureDestination;
  journalOn: boolean;
  onPick: (destination: CaptureDestination) => void;
  onClose: () => void;
};

/** The notes a capture may go under, as one list: the inbox is not a space's
 *  top level, so the spaces' groups are joined and the picker's top row is the inbox. */
function placesFor(groups: readonly PlaceGroup[]): PlaceGroup[] {
  return [{ space: null, entries: groups.flatMap((group) => group.entries) }];
}

export default function CaptureWherePicker({ online, nodes, current, journalOn, onPick, onClose }: Props) {
  const t = useT();
  const caps = useCapabilities(online);
  const { spaces } = useSpaces(online);
  const groups = useMemo(() => placesFor(newNotePlaceGroups(nodes, spaces, caps)), [nodes, spaces, caps]);
  return (
    <div className="capture-where">
      <div className="capture-where-heading">{t("Where it goes")}</div>
      {journalOn && (
        <Button className="capture-where-today" aria-pressed={current.kind === "today"} onClick={() => onPick({ kind: "today" })}>
          <BookOpen size={14} aria-hidden="true" /> {t("Today's journal")}
        </Button>
      )}
      <PlacePicker groups={groups} topLabel={t("Inbox")} searchLabel={t("Search notes…")}
        current={current.kind === "today" ? null : { spaceId: null, parentId: current.kind === "note" ? current.noteId : null }}
        currentMark="chosen"
        onPick={({ parentId }) => onPick(parentId ? { kind: "note", noteId: parentId } : { kind: "inbox" })}
        onClose={onClose} />
    </div>
  );
}
