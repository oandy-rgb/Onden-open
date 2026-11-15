import type { ContentNode } from "../../lib/api";
import { useOnline } from "../../lib/appStore";
import { useCapabilities } from "../../lib/capabilities";
import { useRuntimeText } from "../../lib/aiRuntimeText";
import { useNoteChat } from "./useNoteChat";

/** One note's AI conversation, owned by whichever frame shows it (the info panel's AI tab on a wide screen, the
 *  phone's bottom panel): the frame keeps it alive while it is collapsed, so the bar can say what is going on. */
export function useNoteAi(node: ContentNode) {
  const online = useOnline();
  const canEdit = useCapabilities(online).canEdit(node);
  const runtimeText = useRuntimeText();
  const chat = useNoteChat({ nodeId: node.id, online, canEdit, reasonText: runtimeText.reason });
  return { chat, online, canEdit };
}
export type NoteAi = ReturnType<typeof useNoteAi>;
