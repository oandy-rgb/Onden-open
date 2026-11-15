import { useState } from "react";
import type { ContentNode } from "../lib/api";
import { useOnline } from "../lib/appStore";
import { useCapabilities } from "../lib/capabilities";
import { useT } from "../lib/i18n";
import { movePlaceGroups, type PlaceChoice } from "../lib/placeGroups";
import { spaceLabel, useSpaces, type Space } from "../lib/spaces";
import { Sheet } from "./ui";
import MoveToSpaceConfirm from "./MoveToSpaceConfirm";
import { ParentCombobox } from "./ParentCombobox";
import { PlacePicker } from "./PlacePicker";
import "./ConfirmDialog.css";
import "./MoveToDialog.css";
import { displayTitle } from "../lib/noteLabel";

// "Move to…" and "Pin under another note…" from the note menu.
//   • Move to…: one picker (PlacePicker) for the whole move — a space and a
//     note in it, or its top level. A pick in the note's own space is the
//     ordinary change of parent (`onPick`). A pick in another space is a move
//     between spaces: it is previewed first (who gains and loses sight of the
//     note, MovePreviewSummary), and only the 「移動」 button moves it
//     (moveToSpace); then the parent is set with the same `onPick`.
//   • Pin under another note…: ParentCombobox "pin" (a pin is a second place
//     to show the note, never a move).
// On a phone the dialog is a ui/Sheet with a steady height: the list scrolls
// inside it and the top edge stays put while the search narrows the list.

type Props = {
  node: ContentNode;
  nodes: readonly ContentNode[];
  /** "move" (default): `parentId` null is the top level. "pin": always a
   *  note — a pin is never at the top level. */
  purpose?: "move" | "pin";
  onPick: (parentId: string | null) => void;
  onClose: () => void;
};

export default function MoveToDialog({ node, nodes, purpose = "move", onPick, onClose }: Props) {
  const t = useT();
  const name = displayTitle(node.title);
  if (purpose === "pin") {
    const title = t("Pin “{title}” under…", { title: name });
    return (
      <Sheet label={title} className="move-to-layer" cardClassName="move-to-dialog" steady onClose={onClose}>
        <div className="move-to-heading">{title}</div>
        <ParentCombobox variant="pin" node={node} nodes={nodes} onPick={onPick} onClose={onClose} />
      </Sheet>
    );
  }
  return <MovePlace node={node} nodes={nodes} onPick={onPick} onClose={onClose} />;
}

/** A pick in another space, waiting for the person to confirm it. */
type Pending = { to: Space; parentId: string | null };

function MovePlace({ node, nodes, onPick, onClose }: Omit<Props, "purpose">) {
  const t = useT();
  const online = useOnline();
  const caps = useCapabilities(online);
  const { spaces } = useSpaces(online);
  const [pending, setPending] = useState<Pending | null>(null);
  const title = t("Move “{title}” to…", { title: displayTitle(node.title) });

  const origin = spaces.find((s) => s.id === node.space_id);
  const parentTitle = (id: string | null) => {
    const parent = id ? nodes.find((n) => n.id === id) : undefined;
    return id ? displayTitle(parent?.title) : null;
  };
  const here = [origin && spaceLabel(origin), parentTitle(node.parent_id ?? null) ?? t("Top level")].filter(Boolean).join(" › ");

  function pick(choice: PlaceChoice) {
    const to = choice.spaceId && choice.spaceId !== node.space_id ? spaces.find((s) => s.id === choice.spaceId) : undefined;
    if (to) { setPending({ to, parentId: choice.parentId }); return; }
    onPick(choice.parentId);
    onClose();
  }

  if (pending) {
    return (
      <MoveToSpaceConfirm node={node} to={pending.to} parentTitle={parentTitle(pending.parentId)} title={title} backLabel={t("Back")}
        onBack={() => setPending(null)} onClose={onClose}
        onMoved={() => {
          // The note now stands at its new space's top level; a note under another
          // note takes the ordinary change of parent from there.
          if (pending.parentId) onPick(pending.parentId);
          onClose();
        }} />
    );
  }

  return (
    <Sheet label={title} className="move-to-layer" cardClassName="move-to-dialog" steady onClose={onClose}>
      <div className="move-to-heading">{title}</div>
      <PlacePicker groups={movePlaceGroups(node, nodes, spaces, caps, online)}
        current={{ spaceId: origin ? node.space_id ?? null : null, parentId: node.parent_id ?? null }} currentMark="here"
        searchLabel={t("Search places to move to…")} where={t("Now in: {where}", { where: here })}
        onPick={pick} onClose={onClose} />
    </Sheet>
  );
}
