import { NodeResizer, useStore, type NodeProps } from "@xyflow/react";
import { useContext } from "react";
import { useFieldDraft } from "../hooks/useFieldDraft";
import { GraphCallbacksContext } from "./graphCallbacks";
import type { SectionHeading } from "../lib/sectionHeadings";
import { t } from "../lib/i18n";
import { addToast } from "../lib/appStore";
import { writeErrors } from "../lib/data";
import { Trash2 } from "lucide-react";
import "./SectionNode.css";
import { isEnterKey } from "../lib/keys";
import { Pressable, TextField } from "./ui";

export function SectionNode({ data, selected }: NodeProps) {
  const { onSectionResized, onSectionTitleChange, onSectionRemove } = useContext(GraphCallbacksContext);
  const sectionId = data.sectionId as string;
  const color = (data.color as string | undefined) ?? "#6366f1";
  const cardCount = (data.cardCount as number | undefined) ?? 0;
  // The name typed so far: saved on Enter / leaving the box, and also when the board closes or the page is hidden
  // with it unsaved, always to the group it was typed on (useFieldDraft). A refused name stays in the box.
  const draft = useFieldDraft<{ rename: typeof onSectionTitleChange; sectionId: string }>({
    target: { rename: onSectionTitleChange, sectionId }, targetKey: sectionId, committed: data.title as string,
    commit: async ({ rename, sectionId: group }, text) => {
      try { await rename(group, text); } catch (error) { writeErrors.report(error, addToast); throw error; }
    },
  });
  const title = draft.text;
  const status = draft.status === "saving" ? "saving" : draft.status === "rejected" ? "rejected" : "idle";

  // Cards still collapse at low zoom. The heading remains readable and
  // editable, so changing zoom cannot unmount an unfinished title input.
  const zoom = useStore(s => s.transform[2]);
  const lodMode = zoom < 0.35;
  const heading = data.heading as SectionHeading | undefined;
  const headingScale = heading?.scale ?? 1 / zoom;
  const headingTop = heading?.top ?? -50 / zoom;

  return (
    <div
      className={`section-node${lodMode ? " section-node--lod" : ""}`}
      style={{
        "--section-color": color,
        "--section-heading-left": `${heading?.left ?? 8 / zoom}px`,
        "--section-heading-top": `${headingTop}px`,
        "--section-heading-width": `${heading?.width ?? 220}px`,
        "--section-heading-scale": headingScale,
        "--section-leader-top": `${headingTop + 44 * headingScale}px`,
        "--section-leader-height": `${Math.max(0, -headingTop - 44 * headingScale)}px`,
      } as React.CSSProperties}
    >
      <span className="section-node-leader" aria-hidden="true" />
      <NodeResizer
        isVisible={!!selected && !lodMode}
        minWidth={160}
        minHeight={100}
        lineStyle={{ border: `1.5px dashed color-mix(in srgb, ${color} 50%, transparent)` }}
        handleStyle={{ width: 8, height: 8, borderRadius: 2, background: color, opacity: 0.7 }}
        onResizeEnd={(_, bounds) => onSectionResized(sectionId, bounds)}
      />
      <div className="section-node-heading" onDoubleClick={e => e.stopPropagation()}>
        <TextField
          className="section-node-title nodrag nopan"
          value={title}
          onChange={(e) => draft.edit(e.target.value)}
          readOnly={status === "saving"}
          aria-invalid={status === "rejected"}
          // Persist on blur / Enter — the input was local-only state before, so
          // a renamed section reverted on the next load. Only write when the
          // title actually changed from the saved value.
          onBlur={() => void draft.flush()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (isEnterKey(e)) (e.target as HTMLInputElement).blur();
          }}
          aria-label={t("Group name")}
          title={title}
          placeholder={t("Group name")}
        />
        {status === "saving" ? <span className="section-node-count" role="status">{t("Saving…")}</span>
          : status === "rejected" ? <Pressable type="button" className="section-node-retry nodrag nopan"
            title={t("Group name not saved")} onClick={() => void draft.retry()}>{t("Retry saving")}</Pressable>
            : <span className="section-node-count" title={t("{n} cards in group", { n: cardCount })}>{cardCount}</span>}
        {selected && !lodMode && <Pressable type="button" className="section-node-remove nodrag nopan"
          aria-label={t("Delete group frame")} title={t("Delete group frame (the cards stay)")} onClick={() => onSectionRemove(sectionId)}>
          <Trash2 size={14} aria-hidden="true" />
        </Pressable>}
      </div>
    </div>
  );
}
