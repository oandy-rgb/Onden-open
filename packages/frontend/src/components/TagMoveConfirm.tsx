import { useState } from "react";
import type { Tag } from "../lib/api";
import { addToast } from "../lib/appStore";
import { noteWriter, writeErrors } from "../lib/data";
import { useT } from "../lib/i18n";
import { Modal, Pressable } from "./ui";
import "./ConfirmDialog.css";
import "./SchemaLens.css";

// The confirm before a tag is dragged under another tag. A tag has one parent,
// so the move takes it out of its old place; the words say that. The move is
// the tag node's own parent change (the same write as a note moving), so the
// server's refusals (a cycle, a name already used under the new parent) come
// back as the usual failure message and the dialog stays for another try.

export default function TagMoveConfirm({ tag, parent, onDone, onCancel }: {
  tag: Pick<Tag, "id" | "name">;
  parent: Pick<Tag, "id" | "name">;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [moving, setMoving] = useState(false);
  async function move() {
    setMoving(true);
    try {
      await noteWriter.patch(tag.id, { parent_id: parent.id });
      onDone();
    } catch (error) {
      writeErrors.report(error, addToast);
      setMoving(false);
    }
  }
  return (
    <Modal label={t("Move #{name}", { name: tag.name })} role="alertdialog" className="confirm-dialog-backdrop" busy={moving} onClose={onCancel}>
      <div className="confirm-dialog">
      <p className="schema-lens-delete-headline">{t("Move #{name} under #{parent}?", { name: tag.name, parent: parent.name })}</p>
      <p className="schema-lens-delete-note">{t("A tag has one parent, so #{name} leaves its old place. Its notes and sub-tags stay with it.", { name: tag.name })}</p>
      <div className="schema-lens-delete-actions">
        <Pressable className="schema-lens-action" onClick={onCancel}>{t("Cancel")}</Pressable>
        <Pressable className="schema-lens-action" disabled={moving} onClick={() => void move()}>{t("Move")}</Pressable>
      </div>
      </div>
    </Modal>
  );
}
