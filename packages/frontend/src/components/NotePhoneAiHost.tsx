import { Suspense } from "react";
import type { ContentNode } from "../lib/api";
import { lazyWithReload } from "../lib/lazyWithReload";
import { useNoteAiPanel } from "../lib/notePhoneAi";

// Mounts the phone's AI panel for the open note, and only once it was opened for this note in this visit: the
// panel's code (components/infoAi) is loaded then, never with the note. Another note shows nothing of it.
const PhoneAiPanel = lazyWithReload(() => import("./infoAi").then((m) => ({ default: m.PhoneAiPanel })));

export default function NotePhoneAiHost({ node, onSelectNode }: { node: ContentNode; onSelectNode: (id: string) => void }) {
  const panel = useNoteAiPanel(node.id);
  if (!panel) return null;
  return <Suspense fallback={null}><PhoneAiPanel key={node.id} node={node} onSelectNode={onSelectNode} /></Suspense>;
}
