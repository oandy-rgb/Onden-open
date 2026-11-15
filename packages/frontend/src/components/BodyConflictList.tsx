import { useState } from "react";
import { X } from "lucide-react";
import type { ContentNode } from "../lib/api";
import type { LiveEvent } from "../lib/liveEvent";
import type { BodyConflictChoice, BodyConflictPayload, BodyConflictRegion } from "../lib/bodyConflict";
import { useT } from "../lib/i18n";
import { dayLabel, timeLabel } from "../lib/timeLabels";
import { Pressable } from "./ui";

/** The inbox's conflicting body edits: two writers changed the same lines of
 *  a note, the later save's text was kept. Each place shows the kept text and
 *  the one left out, and can put the left-out text in instead or as well. */
export default function BodyConflictList({ conflicts, nodes, onOpenNode, onResolve, onDismiss }: {
  conflicts: readonly LiveEvent[];
  nodes: readonly ContentNode[];
  onOpenNode: (id: string) => void;
  /** Change the note; resolves false when the kept text is no longer there.
   *  Absent when this view cannot write. */
  onResolve?: (nodeId: string, region: BodyConflictRegion, choice: BodyConflictChoice) => Promise<boolean>;
  onDismiss: (eventId: number) => void;
}) {
  const t = useT();
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  if (conflicts.length === 0) return null;

  async function resolve(e: LiveEvent, index: number, region: BodyConflictRegion, choice: BodyConflictChoice) {
    if (!onResolve || !(await onResolve(e.target_id, region, choice))) return;
    const next = new Set(resolved).add(`${e.id}:${index}`);
    setResolved(next);
    const count = (e.payload as unknown as BodyConflictPayload).conflicts.length;
    if (Array.from({ length: count }, (_, i) => `${e.id}:${i}`).every((k) => next.has(k))) onDismiss(e.id);
  }

  return (
    <div className="pending-section conflict-section">
      <div className="pending-section-label">
        {t("Conflicting edits")}
        <span className="pending-section-selected">{conflicts.length}</span>
      </div>
      {conflicts.map((e) => {
        const p = e.payload as unknown as BodyConflictPayload;
        const node = nodes.find((n) => n.id === e.target_id);
        const regions = p.conflicts ?? [];
        return (
          <div key={e.id} className="conflict-item">
            <div className="conflict-item-head">
              <Pressable className="conflict-item-node" onClick={() => node && onOpenNode(node.id)} title={t("Open node")} disabled={!node}>
                {node?.title ?? t("(deleted note)")}
              </Pressable>
              <time className="conflict-item-time">{`${dayLabel(e.created_at)} ${timeLabel(e.created_at)}`}</time>
              <Pressable className="conflict-item-dismiss" onClick={() => onDismiss(e.id)}
                aria-label={t("Dismiss — keep the note as it is")} title={t("Dismiss — keep the note as it is")}>
                <X size={11} />
              </Pressable>
            </div>
            {regions.length === 0 && (
              <p className="body-conflict-note">{t("Too long to show here. Compare the versions in the note's history.")}</p>
            )}
            {regions.map((region, i) => {
              const done = resolved.has(`${e.id}:${i}`);
              return (
                <div key={i} className="body-conflict-region">
                  <div className="body-conflict-side">
                    <span className="body-conflict-label">{t("Kept")}</span>
                    <pre className="body-conflict-text">{region.incoming || t("(empty)")}</pre>
                  </div>
                  <div className="body-conflict-side body-conflict-left-out">
                    <span className="body-conflict-label">{t("Left out")}</span>
                    <pre className="body-conflict-text">{region.current || t("(empty)")}</pre>
                  </div>
                  {done ? (
                    <span className="body-conflict-done">{t("Resolved")}</span>
                  ) : onResolve && node && (
                    <div className="conflict-item-actions">
                      <Pressable className="conflict-item-revert" onClick={() => void resolve(e, i, region, "other")}>
                        {t("Use the left-out text")}
                      </Pressable>
                      {region.incoming !== "" && region.current !== "" && (
                        <Pressable className="conflict-item-revert" onClick={() => void resolve(e, i, region, "both")}>
                          {t("Keep both")}
                        </Pressable>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
