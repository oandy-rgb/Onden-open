// The inbox page (收件匣): first what waits for a decision (DecideSection), then the
// captures nobody has filed yet, newest first. Each
// can be moved under a note (that files it: the inbox tag comes off), given a
// tag (the note's own tag row, ＋ Tag), turned into a task, or deleted. Nothing here asks a question the person
// did not start; an empty inbox is the good state.

import { useState } from "react";
import { FolderInput, Inbox, ListChecks, Trash2 } from "lucide-react";
import { ellipsize, plainInline, stripLineMarker } from "@onden/markdown";
import { parseTaskInput } from "@onden/markdown/task-parse";
import type { ContentNode } from "../../lib/api";
import { selectOverviewNodes, useAppSelector, useTagRows, useAllNodes } from "../../lib/appStore";
import { nodeActions, taskWriter, tagWriter } from "../../lib/data";
import { getLocale, useT } from "../../lib/i18n";
import { dayAndClock } from "../../lib/localDate";
import { agoLabel } from "../../lib/timeLabels";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useTasksEnabled } from "../../hooks/useModuleFilter";
import { Button, Pressable } from "../../components/ui";
import MoveToDialog from "../../components/MoveToDialog";
import TitleTagRow from "../../components/TitleTagRow";
import type { ModuleScreenProps } from "../types";
import { inboxTagId, pendingCaptures } from "./inbox";
import { openQuickCapture } from "./openQuickCapture";
import { displayTitle } from "../../lib/noteLabel";
import DecideSection from "./DecideSection";
import "./InboxScreen.css";
import EmptyState from "../../components/EmptyState";

/** The words under the title: the body without its first line (that is the title), kept short. */
function excerpt(node: ContentNode): string {
  const rest = (node.markdown ?? "").trim().split("\n").slice(1).map(stripLineMarker).map((line) => plainInline(line)).join(" ").replace(/\s+/g, " ").trim();
  return ellipsize(rest, 140);
}

export default function InboxScreen({ onOpenNode, inTab = false }: ModuleScreenProps) {
  const t = useT();
  const phone = useIsMobile();
  const nodes = useAllNodes();
  const overviewNodes = useAppSelector(selectOverviewNodes);
  const tags = useTagRows() ?? [];
  const tasksOn = useTasksEnabled();
  const tagId = inboxTagId(tags);
  const waiting = pendingCaptures(nodes, tags);
  const [moving, setMoving] = useState<ContentNode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /** Runs one change to a capture; the writers report their own failures. */
  async function run(node: ContentNode, job: () => Promise<unknown>) {
    if (busy) return;
    setBusy(node.id);
    try { await job(); } catch { /* reported by the writer */ } finally { setBusy(null); }
  }

  /** Filed: taken out of the inbox (the creation time stays, and so does the capture flag). */
  const file = (node: ContentNode) => tagId ? tagWriter.remove(node.id, tagId) : Promise.resolve();

  // A task on the capture's own note: the words give its title and its day, and
  // the capture is filed — it stays a note, now with a task in it.
  async function makeTask(node: ContentNode) {
    const first = (node.markdown || node.title).trim().split("\n", 1)[0] ?? "";
    const reading = parseTaskInput(first, { ...dayAndClock(), locale: getLocale() });
    await taskWriter.create(node.id, reading.title || displayTitle(node.title), reading.when_date ? { when: reading.when_date } : {});
    await file(node);
  }

  return (
    <section className="capture-inbox" aria-labelledby={inTab || phone ? undefined : "capture-inbox-title"} aria-label={inTab || phone ? t("Inbox") : undefined}>
      {!inTab && (
        <header className="capture-inbox-header">
          {/* A phone names the page in the top bar. */}
          {!phone && <h1 id="capture-inbox-title" className="capture-inbox-title">{t("Inbox")}</h1>}
          <p className="capture-inbox-sub">{t("Things you jotted down that are not filed yet.")}</p>
        </header>
      )}

      <DecideSection onOpenNode={onOpenNode} />

      {waiting.length === 0 ? (
        <EmptyState icon={<Inbox size={28} strokeWidth={1.5} aria-hidden="true" />} title={t("Nothing waiting. What you jot down without a place lands here.")}
          ctaLabel={t("Quick capture")} onCta={openQuickCapture} />
      ) : (
        <ul className="capture-inbox-list">
          {waiting.map((node) => {
            const title = displayTitle(node.title);
            const rowBusy = busy === node.id;
            return (
              <li key={node.id} className="capture-inbox-item">
                <Pressable type="button" className="capture-inbox-text" onClick={() => onOpenNode(node.id)}>
                  <span className="capture-inbox-item-title">{title}</span>
                  {excerpt(node) && <span className="capture-inbox-excerpt">{excerpt(node)}</span>}
                  <span className="capture-inbox-when">{agoLabel(node.created_at)}</span>
                </Pressable>
                <div className="capture-inbox-actions">
                  <Button size="sm" disabled={rowBusy} onClick={() => setMoving(node)} aria-label={t("Move “{title}” to…", { title })}>
                    <FolderInput size={14} aria-hidden="true" /> {t("Move to…")}
                  </Button>
                  {tasksOn && (
                    <Button size="sm" disabled={rowBusy} onClick={() => void run(node, () => makeTask(node))} aria-label={t("Make “{title}” a task", { title })}>
                      <ListChecks size={14} aria-hidden="true" /> {t("Make a task")}
                    </Button>
                  )}
                  <Button size="sm" disabled={rowBusy} onClick={() => void run(node, () => nodeActions.delete(node.id))} aria-label={t("Delete “{title}”", { title })}>
                    <Trash2 size={14} aria-hidden="true" /> {t("Delete")}
                  </Button>
                </div>
                {/* Tags are added here, with the note's own tag row (＋ Tag). The inbox's
                    own tag is not shown on it: taking it off is what filing does. */}
                <TitleTagRow node={node} tags={tags.filter((tag) => tag.id !== tagId)} onToggleTag={() => {}} />
              </li>
            );
          })}
        </ul>
      )}

      {moving && (
        <MoveToDialog node={moving} nodes={overviewNodes} onClose={() => setMoving(null)}
          onPick={(parentId) => void run(moving, async () => {
            // Under a note, or the top level: either way it is now an ordinary note.
            await nodeActions.assignToGroup(moving.id, parentId);
            await file(moving);
          })} />
      )}
    </section>
  );
}
