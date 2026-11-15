import { Sparkles } from "lucide-react";
import { useT } from "../lib/i18n";
import { toggleNoteAi, useNoteAiPanel } from "../lib/notePhoneAi";
import { useIsMobile } from "../hooks/useIsMobile";
import type { ContentNode } from "../lib/api";
import { Pressable } from "./ui";

// The phone's way to the AI conversation: a button in the note's top bar (the AI module's noteHeaderAction;
// not in ⋯). It opens the bottom panel over the note (components/NotePhoneAiHost); where the info panel sits
// beside the note the AI is that panel's tab and this renders nothing. Tiny on purpose: it loads with the note.

export default function NoteAiButton({ node }: { node: ContentNode; readOnly?: boolean }) {
  const t = useT();
  const phone = useIsMobile();
  const panel = useNoteAiPanel(node.id);
  if (!phone) return null;
  const open = !!panel && !panel.dismissed && panel.height !== "bar";
  return (
    <Pressable type="button" className="note-actions-more-btn note-actions-ai-btn tap-target" aria-pressed={open}
      aria-label={t("Ask AI about this note")} title={t("Ask AI about this note")} onClick={() => toggleNoteAi(node.id)}>
      <Sparkles size={18} aria-hidden="true" />
    </Pressable>
  );
}
