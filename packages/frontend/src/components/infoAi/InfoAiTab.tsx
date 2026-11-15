import type { ContentNode } from "../../lib/api";
import { NoteAiConversation } from "./NoteAiConversation";
import { useNoteAi } from "./useNoteAi";

// The conversation's place where the info panel sits beside the note: its 「AI」 tab (loaded when the tab is
// opened, never at boot). Where the Info screen would replace the note (a phone) there is no such tab: the AI
// is the bottom panel over the note instead (PhoneAiPanel). Same conversation component in both.

export default function InfoAiTab({ node, onSelectNode }: {
  node: ContentNode;
  /** Open a note from a source link. */
  onSelectNode: (id: string) => void;
}) {
  const ai = useNoteAi(node);
  return <NoteAiConversation node={node} ai={ai} onSelectNode={onSelectNode} />;
}
