import { useState } from "react";
import { isInkPageAttr } from "@onden/markdown/ink";
import { X } from "lucide-react";
import type { ContentNode } from "../lib/api";
import type { LiveEvent } from "../lib/liveEvent";
import type { ConflictPayload } from "../hooks/useAttributeConflicts";
import { useT, tn } from "../lib/i18n";
import { dayLabel, timeLabel } from "../lib/timeLabels";
import { Pressable } from "./ui";

type Translate = ReturnType<typeof useT>;

/** What a drawing conflict was about, in words: its two drawings are never
 *  shown (nor downloaded) — the items both devices changed are counted. */
function inkConflictSummary(p: ConflictPayload, t: Translate): string {
  const items = p.ink_conflicts;
  if (!items) return t("The drawing changed on both devices");
  if (items.some((c) => c.kind === "format")) return t("Both devices saved a different kind of drawing");
  const count = (kind: string) => items.filter((c) => c.kind === kind).length;
  const strokes = count("stroke"), shapes = count("shape"), highlights = count("annotation");
  const parts = [
    strokes > 0 ? tn("1 stroke", "{count} strokes", strokes) : null,
    shapes > 0 ? tn("1 shape", "{count} shapes", shapes) : null,
    highlights > 0 ? tn("1 highlight", "{count} highlights", highlights) : null,
    // A page one device deleted while the other drew on it: kept, and counted as a page both changed.
    count("deletedPage") > 0 ? tn("1 page", "{count} pages", count("deletedPage")) : null,
    count("page") > 0 ? t("page settings") : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? t("The drawing changed on both devices") : t("{items} changed on both devices", { items: parts.join(t(", ")) });
}

/** The same for text boxes on a page: only how many boxes both devices changed. */
function pageTextConflictSummary(p: ConflictPayload, t: Translate): string {
  const count = p.page_text_conflicts?.length ?? 0;
  if (count === 0) return t("The text on the page changed on both devices");
  return tn("1 text box changed on both devices", "{count} text boxes changed on both devices", count);
}

/** And for the pictures on a page. */
function pageImagesConflictSummary(p: ConflictPayload, t: Translate): string {
  const count = p.page_images_conflicts?.length ?? 0;
  if (count === 0) return t("The pictures on the page changed on both devices");
  return tn("1 picture changed on both devices", "{count} pictures changed on both devices", count);
}

/** The inbox's "Recent conflicts": which field on which note lost a value to a
 *  later write, with Revert (give the lost value back, by the server) and
 *  Dismiss. A drawing shows a summary of the strokes both devices changed. */
export default function ConflictList({ conflicts, nodes, onOpenNode, onRevert, onDismiss }: {
  conflicts: readonly LiveEvent[];
  nodes: readonly ContentNode[];
  onOpenNode: (id: string) => void;
  /** Revert conflict `eventId` (lib/data propertyWriter.revertConflict); true
   *  once accepted, when the conflict is dismissed. Absent when this view
   *  cannot write. */
  onRevert?: (eventId: number, nodeId: string, key: string) => Promise<boolean>;
  onDismiss: (eventId: number) => void;
}) {
  const t = useT();
  const [reverting, setReverting] = useState<number | null>(null);
  if (conflicts.length === 0) return null;
  async function revert(eventId: number, nodeId: string, key: string) {
    if (!onRevert || reverting !== null) return;
    setReverting(eventId);
    try {
      if (await onRevert(eventId, nodeId, key)) onDismiss(eventId);
    } finally { setReverting(null); }
  }
  return (
    <div className="pending-section conflict-section">
      <div className="pending-section-label">
        {t("Recent conflicts")}
        <span className="pending-section-selected">{conflicts.length}</span>
      </div>
      {conflicts.map((e) => {
        const p = e.payload as unknown as ConflictPayload;
        const node = nodes.find((n) => n.id === e.target_id);
        const drawing = isInkPageAttr(p.key);
        const pageText = p.key === "page_text";
        const pageImages = p.key === "page_images";
        return (
          <div key={e.id} className="conflict-item">
            <div className="conflict-item-head">
              <Pressable className="conflict-item-node" onClick={() => node && onOpenNode(node.id)} title={t("Open node")} disabled={!node}>
                {node?.title ?? t("(deleted note)")}
              </Pressable>
              <span className="conflict-item-key">{pageText ? t("Text on pages") : pageImages ? t("Pictures on pages") : `#${p.key}`}</span>
              <time className="conflict-item-time">{`${dayLabel(e.created_at)} ${timeLabel(e.created_at)}`}</time>
            </div>
            <div className="conflict-item-values">
              {drawing || pageText || pageImages ? (
                <span className="conflict-item-summary">{drawing ? inkConflictSummary(p, t) : pageText ? pageTextConflictSummary(p, t) : pageImagesConflictSummary(p, t)}</span>
              ) : (
                <>
                  <span className="conflict-item-prev" title={t("Previous value (overridden)")}>
                    <s>{p.overridden_value || t("(empty)")}</s>
                  </span>
                  <span className="conflict-item-arrow">→</span>
                  <strong className="conflict-item-next" title={t("Incoming value (won by LWW)")}>
                    {p.incoming_value || t("(empty)")}
                  </strong>
                </>
              )}
            </div>
            <div className="conflict-item-actions">
              {onRevert && node && (
                <Pressable className="conflict-item-revert" disabled={reverting !== null}
                  title={drawing
                    ? t("Restore the other device's version of these items; every other stroke stays")
                    : pageText
                      ? t("Restore the other device's version of these text boxes; every other box stays")
                      : pageImages
                      ? t("Restore the other device's version of these pictures; every other picture stays")
                      : t("Restore the previous value (overriding the LWW winner)")}
                  onClick={() => void revert(e.id, node.id, p.key)}>
                  ↶ {t("Revert")}
                </Pressable>
              )}
              <Pressable className="conflict-item-dismiss" onClick={() => onDismiss(e.id)}
                aria-label={t("Dismiss — keep the current value, hide this conflict")} title={t("Dismiss — keep the current value, hide this conflict")}>
                <X size={11} />
              </Pressable>
            </div>
          </div>
        );
      })}
    </div>
  );
}
