import { useMemo } from "react";
import { getNode } from "../../lib/appStore";
import { useCapabilities } from "../../lib/capabilities";
import type { EditableEmbed } from "../../lib/embedDom";
import EmbedEditSheet from "../../components/EmbedEditSheet";

// Edit one review card's paragraph (or the whole note, for a note card) in
// place. It is the editor's own embed sheet: the text is the card's range,
// and each save goes back into the source note as one of its normal saves
// (drafts.saveBody), merged onto newer text — a review screen has no second
// editor and no second way to save.

type Props = {
  /** The note the card is in. */
  nodeId: string;
  /** The note's name, for the sheet's title when the note is not in the app's list. */
  noteTitle: string;
  /** The paragraph's id in that note; null for a whole-note card. */
  blockRef: string | null;
  online: boolean;
  onClose: () => void;
  onOpenSource: (nodeId: string) => void;
};

export default function ReviewEditSheet({ nodeId, noteTitle, blockRef, online, onClose, onOpenSource }: Props) {
  const capabilities = useCapabilities(online);
  const node = getNode(nodeId);
  const embed = useMemo((): EditableEmbed => {
    const source = node ?? { id: nodeId, title: noteTitle, slug: "" };
    const ref = { body: "", target: source.title, blockId: blockRef, heading: null, label: null, inkRegion: null };
    return blockRef
      ? { kind: "block", ref, label: source.title, node: source, blockId: blockRef }
      : { kind: "note", ref, label: source.title, node: source, heading: null };
  }, [node, nodeId, noteTitle, blockRef]);
  return (
    <EmbedEditSheet
      embed={embed} hostNodeId={null}
      canEdit={capabilities.canEdit({ node_type: "content", space_id: node?.space_id ?? null })}
      onOpenSource={(id) => onOpenSource(id)}
      onClose={onClose}
    />
  );
}
