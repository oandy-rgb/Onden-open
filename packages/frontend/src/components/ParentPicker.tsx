import type { ContentNode } from "../lib/api";
import { ParentCombobox } from "./ParentCombobox";

// The note's Parent field under the body: the shared note-tree picker
// (ParentCombobox) inline. It excludes the note, its descendants and tags.

export { parentCandidates } from "./ParentCombobox";

type Props = {
  node: ContentNode;
  /** The notes a parent can be picked from (the notes list). */
  nodes: readonly ContentNode[];
  onPick: (parentId: string | null) => void;
  onClose: () => void;
};

export default function ParentPicker(props: Props) {
  return <ParentCombobox variant="inline" {...props} />;
}
