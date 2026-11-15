import { useRef, useState } from "react";
import type { Tag, TagMergePreview } from "../../lib/api";
import { fetchTagMergePreview } from "../../lib/api";
import { addToast } from "../../lib/appStore";
import { mergeTag, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { canMergeTagInto } from "../../lib/tagTree";

/** P2 tag merge: fold THIS tag into another. Same look-before-you-leap shape
 *  as safe-delete — `toggle()` opens the picker, `pickTarget(id)` reads the
 *  plain-language `preview`, `confirm()` merges. Nothing is sent until
 *  `confirm()`. After a merge the page opens the target tag and refreshes.
 *  `candidates` are the tags this one can be merged into (lib/tagTree canMergeTagInto: not its own sub-tags, module tags, system tags). */
export function useTagMerge({ tag, allTags, onSaved, onOpenNode }: {
  tag: Tag; allTags: Tag[]; onSaved?: () => void; onOpenNode?: (id: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [preview, setPreview] = useState<TagMergePreview | null>(null);
  const [merging, setMerging] = useState(false);
  // Which pick the preview must answer: a slower reply for an earlier pick is dropped, because
  // `confirm()` merges whatever `preview` holds (destructive).
  const pickSeq = useRef(0);
  const candidates = allTags.filter((c) => canMergeTagInto(allTags, tag.id, c.id));
  function close() {
    pickSeq.current += 1;
    setOpen(false);
    setTargetId("");
    setPreview(null);
  }
  async function pickTarget(id: string) {
    const seq = ++pickSeq.current;
    setTargetId(id);
    setPreview(null);
    if (!id) return;
    try {
      const loaded = await fetchTagMergePreview(tag.id, id);
      if (seq === pickSeq.current) setPreview(loaded);
    } catch (e) {
      if (seq !== pickSeq.current) return;
      addToast(writeErrors.requestMessage(e, t("Could not load the merge preview")), "error");
    }
  }
  async function confirm() {
    if (!preview || preview.target.id !== targetId) return; // merging is destructive
    setMerging(true);
    try {
      const result = await mergeTag(tag.id, preview.target.id);
      addToast(t("Merged #{source} into #{target} — {n} note(s) updated", {
        source: preview.source.name, target: preview.target.name, n: result.members_gained_target,
      }));
      close();
      // Land on the TARGET tag (the surviving collection) instead of letting the
      // dangling selection on the trashed source fall back to an arbitrary note.
      onOpenNode?.(preview.target.id);
      onSaved?.(); // refresh — #source is deleted now (restorable from 歷史)
    } catch (e) {
      addToast(writeErrors.requestMessage(e, t("Merge failed")), "error");
    } finally { setMerging(false); }
  }
  return { open, targetId, preview, merging, candidates, close, toggle: () => (open ? close() : setOpen(true)), pickTarget, confirm };
}

export type TagMerge = ReturnType<typeof useTagMerge>;
