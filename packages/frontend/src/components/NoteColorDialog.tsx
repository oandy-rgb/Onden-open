import ShellDialog from "./ShellDialog";
import ColorSwatchRow from "./ColorSwatchRow";
import { noteMarkActions } from "../lib/data";
import { useT } from "../lib/i18n";
import { openModuleDialog } from "../lib/moduleDialog";
import "./ContextMenu.css";

// The colour choice for one note, for where no menu is at hand (the ⌘K
// palette's 「設定顏色」). The swatches are the context menu's.

function NoteColorDialog({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const tr = useT();
  return (
    <ShellDialog label={tr("Set color")} className="note-color-dialog" onClose={onClose}>
      <h2 className="note-color-title">{tr("Set color")}</h2>
      <ColorSwatchRow onPick={(color) => { noteMarkActions.setColor(nodeId, color); onClose(); }} />
    </ShellDialog>
  );
}

export function openNoteColorDialog(nodeId: string): void {
  openModuleDialog((close) => <NoteColorDialog nodeId={nodeId} onClose={close} />);
}
