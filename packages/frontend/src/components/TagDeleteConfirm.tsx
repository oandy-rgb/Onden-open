import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { Tag } from "../lib/api";
import { noteWriter, reads, writeErrors } from "../lib/data";
import { addToast } from "../lib/appStore";
import { useT } from "../lib/i18n";
import { Modal, Pressable } from "./ui";
import "./ConfirmDialog.css";
import "./SchemaLens.css";

// The two-step tag delete: it reads what the delete affects (the server's
// impact report), says so in plain words, and deletes only on the confirm
// button. The tag page and the phone's tag list both open it, so the words
// and the refusal handling are the same. Offline the report is unavailable;
// the delete is still reversible and queues, so the confirm says that.

type DeletePreview = {
  members: number; sample_titles: string[];
  fields: Array<{ name: string; values_count: number }>;
  views: number; reversible: boolean;
  // The delete trashes the tag's live subtree too. Sub-tag names are global;
  // notes under the tag are the ones the caller can read, and
  // hidden_descendants (owner only) is the unreadable rest as a number.
  sub_tags?: Array<{ id: string; name: string }>;
  sub_tag_members?: number;
  descendant_items?: number;
  hidden_descendants?: number;
  unknown?: boolean;
};

const UNKNOWN_PREVIEW: DeletePreview = { members: 0, sample_titles: [], fields: [], views: 0, reversible: true, unknown: true };

export default function TagDeleteConfirm({ tag, onDeleteNode, onDone, onCancel }: {
  tag: Pick<Tag, "id" | "name">;
  /** Offline-capable node delete (nodeActions.delete): a tag is a node.
   *  Resolves true when the delete was accepted or queued, and has already
   *  announced the outcome. */
  onDeleteNode?: (id: string, title?: string) => Promise<boolean>;
  /** After an accepted delete (refresh; the tag is gone). */
  onDone?: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    let live = true;
    reads.tags.deletePreview<DeletePreview>(tag.id)
      .then((report) => { if (live) setPreview(report); })
      // Offline or the report failed: do not block a reversible, queued delete.
      .catch(() => { if (live) setPreview(UNKNOWN_PREVIEW); });
    return () => { live = false; };
  }, [tag.id]);

  async function confirmDelete() {
    setDeleting(true);
    try {
      if (onDeleteNode) {
        if (!await onDeleteNode(tag.id, tag.name)) { setDeleting(false); return; }
      } else {
        await noteWriter.remove(tag.id);
        addToast(t("Deleted #{name} — restore it from History", { name: tag.name }), "info");
      }
      onDone?.();
    } catch (e) {
      setDeleting(false);
      writeErrors.report(e, addToast);
    }
  }

  if (!preview) return null;
  return (
    <Modal label={t("Delete #{name}?", { name: tag.name })} role="alertdialog" className="confirm-dialog-backdrop" busy={deleting} onClose={onCancel}>
      <div className="confirm-dialog">
      <p className="schema-lens-delete-headline">
        {preview.unknown
          ? t("Delete #{name}?", { name: tag.name })
          : t("Deleting #{name} affects:", { name: tag.name })}
      </p>
      {preview.unknown ? (
        <p className="schema-lens-delete-note">{t("Offline — the impact report isn't available, but this is reversible.")}</p>
      ) : (
        <ul className="schema-lens-delete-list">
          <li>{t("{n} tagged note(s) lose the tag", { n: preview.members })} {t("(the notes stay)")}
            {preview.sample_titles.length > 0 && (
              <span className="schema-lens-delete-sample"> — {preview.sample_titles.join(" · ")}{preview.members > preview.sample_titles.length ? " …" : ""}</span>
            )}
          </li>
          {(preview.sub_tags?.length ?? 0) > 0 && (
            <li>{t("{n} sub-tag(s) are deleted with it", { n: preview.sub_tags!.length })}
              <span className="schema-lens-delete-sample"> — {preview.sub_tags!.slice(0, 5).map((st) => `#${st.name}`).join(" · ")}{preview.sub_tags!.length > 5 ? " …" : ""}</span>
            </li>
          )}
          {(preview.sub_tag_members ?? 0) > 0 && (
            <li>{t("{n} note(s) lose a sub-tag", { n: preview.sub_tag_members! })} {t("(the notes stay)")}</li>
          )}
          {(preview.descendant_items ?? 0) > 0 && (
            <li>{t("{n} item(s) filed under it are deleted too", { n: preview.descendant_items! })}</li>
          )}
          {(preview.hidden_descendants ?? 0) > 0 && (
            <li>{t("{n} more item(s) you can't open are deleted too", { n: preview.hidden_descendants! })}</li>
          )}
          {preview.fields.filter((f) => f.values_count > 0).map((f) => (
            <li key={f.name}>{t("\"{field}\" values on {n} note(s) stay as plain properties", { field: f.name, n: f.values_count })}</li>
          ))}
          {preview.views > 0 && <li>{t("{n} saved view(s) disappear", { n: preview.views })}</li>}
        </ul>
      )}
      <p className="schema-lens-delete-note">{t("Reversible — restore it any time from History.")}</p>
      <div className="schema-lens-delete-actions">
        <Pressable className="schema-lens-action" onClick={onCancel}>{t("Cancel")}</Pressable>
        <Pressable className="schema-lens-action schema-lens-delete-go" disabled={deleting} onClick={() => void confirmDelete()}>
          <Trash2 size={13} /> {t("Delete #{name}", { name: tag.name })}
        </Pressable>
      </div>
      </div>
    </Modal>
  );
}
