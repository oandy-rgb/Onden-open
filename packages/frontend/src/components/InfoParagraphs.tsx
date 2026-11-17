import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { cutToUnits, parseBlocks, splitParagraphs } from "@onden/markdown";
import type { ContentNode } from "../lib/api";
import { anchorSpansOf, anchorsOf, anchorsVersion, blockAnchorsEnabled, watchAnchors, type AnchorSpan } from "../lib/blockAnchorStore";
import { blockChildWriter, reads } from "../lib/data";
import { useT } from "../lib/i18n";
import { displayTitle } from "../lib/noteLabel";
import { revealBlockInNote } from "../lib/noteReveal";
import { Button, Chip, Select } from "./ui";
import "./InfoTagsTab.css";
import "./InfoParagraphs.css";
import type { NoteParagraph } from "@onden/contract";

type Props = { node: ContentNode; canEdit?: boolean; onOpen: (id: string) => void };

type Row = NoteParagraph & { depth: number };
type Group = { topic: string | null; rows: Row[] };

/** The most paragraphs offered when pointing a lost one at a place. */
const MAX_CHOICES = 80;

/** How long the note must sit still before the list is asked for again (the server reads what was saved). */
const REFRESH_AFTER_EDIT_MS = 1200;

/** Rows from the note's own text and the anchors this device holds, when the server cannot be asked (offline): topics and
 *  nesting as written. A block with no anchor yet is not listed (it has no identity to open). */
function paragraphsFromText(markdown: string, anchors: readonly AnchorSpan[]): NoteParagraph[] {
  const blocks = parseBlocks(markdown, anchors);
  return blocks.flatMap((b, i) => (b.ref ? [{
    id: `${i}`, parentId: b.parent === null ? null : `${b.parent}`, label: b.label, topics: b.tags,
    where: "here" as const, noteId: null, anchorStatus: null, blockRef: b.ref,
  }] : []));
}

function withDepth(list: readonly NoteParagraph[]): Row[] {
  const parent = new Map(list.map((p) => [p.id, p.parentId]));
  return list.map((p) => {
    let depth = 0;
    for (let up = p.parentId; up !== null && up !== undefined && depth < 8; up = parent.get(up) ?? null) depth++;
    return { ...p, depth };
  });
}

/** A row once under each of its topics, in the order topics first appear; rows with no topic last. */
function groupByTopic(rows: readonly Row[]): Group[] {
  const byTopic = new Map<string, Group>();
  const plain: Row[] = [];
  for (const row of rows) {
    if (row.topics.length === 0) { plain.push(row); continue; }
    for (const topic of row.topics) {
      const key = topic.toLowerCase();
      const group = byTopic.get(key) ?? { topic, rows: [] };
      group.rows.push(row);
      byTopic.set(key, group);
    }
  }
  return [...byTopic.values(), ...(plain.length ? [{ topic: null, rows: plain }] : [])];
}

// The info panel's 「本篇的段落」: the paragraphs of this note that carry a topic or a task, grouped by topic and nested as
// they are in the text. A paragraph that stands alone as its own note is marked and opens that note; one whose place could
// not be found again is listed apart as 「找不到的段落」 with what was kept, and can be pointed at a paragraph again.
// Where each shows up (tree, search, backup, publishing, vectors): docs/architecture/block-nodes.md.
export default function InfoParagraphs({ node, canEdit = false, onOpen }: Props) {
  const t = useT();
  const enabled = useSyncExternalStore(watchAnchors, blockAnchorsEnabled, () => false);
  const [served, setServed] = useState<NoteParagraph[] | null | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const body = node.markdown ?? "";

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const timer = setTimeout(() => { void reads.notes.paragraphs(node.id).then((rows) => { if (current) setServed(rows); }); }, served === undefined ? 0 : REFRESH_AFTER_EDIT_MS);
    return () => { current = false; clearTimeout(timer); };
    // `served` is read only to decide the first load's delay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, node.id, body, version]);

  const anchorsSeen = useSyncExternalStore(watchAnchors, anchorsVersion, () => 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the held anchors change with `anchorsSeen`
  const rows = useMemo(() => withDepth(served ?? paragraphsFromText(body, anchorSpansOf(node.id, body))), [served, body, node.id, anchorsSeen]);
  const lost = rows.filter((r) => r.where === "lost");
  const groups = useMemo(() => groupByTopic(rows.filter((r) => r.where !== "lost")), [rows]);
  if (!enabled || rows.length === 0) return null;

  const open = (row: Row) => {
    if (row.where === "standing") { if (row.noteId) onOpen(row.noteId); return; }
    revealBlockInNote(node.id, row.blockRef);
    onOpen(node.id);
  };

  return (
    <div className="info-relations info-paragraphs"><section className="info-relations-section" aria-labelledby="info-paragraphs">
      <h3 id="info-paragraphs" className="info-relations-heading">{t("Paragraphs in this note")}</h3>
      {groups.map((group) => (
        <div key={group.topic ?? ""}>
          <p className="info-panel-quiet">{group.topic ?? t("No topic")}</p>
          {group.rows.map((row) => (
            <Button
              key={`${group.topic}-${row.id}`}
              variant="ghost"
              size="sm"
              className="links-relation-row info-paragraph-row"
              style={{ "--depth": row.depth } as CSSProperties}
              disabled={row.where === "standing" && !row.noteId}
              onClick={() => open(row)}
            >
              <span className="links-relation-title">{displayTitle(row.label)}</span>
              {row.where === "standing" ? <Chip className="info-paragraph-note">{t("Its own note")}</Chip> : null}
            </Button>
          ))}
        </div>
      ))}
      {lost.length > 0 ? (
        <div>
          <p className="info-panel-quiet">{t("Paragraphs not found")}</p>
          <p className="info-panel-quiet info-paragraph-hint">{t("Their tasks, schedules and topics are kept. Point each one at a paragraph to bring it back.")}</p>
          {lost.map((row) => (
            <LostRow key={row.id} row={row} node={node} canEdit={canEdit} onDone={() => setVersion((v) => v + 1)} />
          ))}
        </div>
      ) : null}
    </section></div>
  );
}

/** One paragraph whose place was lost: what it said, and a choice of paragraphs to point it at. */
function LostRow({ row, node, canEdit, onDone }: { row: Row; node: ContentNode; canEdit: boolean; onDone: () => void }) {
  const t = useT();
  const body = node.markdown ?? "";
  const [at, setAt] = useState("");
  const [saving, setSaving] = useState(false);
  // The server's best guess for THIS paragraph's anchor, when it has one, comes first.
  const guess = anchorsOf(node.id).find((a) => a.anchor_id === row.blockRef && a.status === "lost" && a.candidate_from !== null)?.candidate_from ?? null;
  const choices = useMemo(() => {
    const all = splitParagraphs(body).filter((p) => p.kind === "text" || p.kind === "listItem" || p.kind === "heading");
    return Array.from({ length: Math.min(MAX_CHOICES, all.length) }, (_, i) => all[i]!);
  }, [body]);
  const pick = async () => {
    if (at === "" || saving) return;
    setSaving(true);
    const saved = await blockChildWriter.reassign(node.id, row.id, Number(at), body);
    setSaving(false);
    if (saved) onDone();
  };
  return (
    <div className="info-paragraph-lost">
      <span className="links-relation-title">{displayTitle(row.label)}</span>
      {canEdit ? (
        <div className="info-paragraph-reassign">
          <Select aria-label={t("Point it at")} value={at} onChange={(e) => setAt(e.target.value)}>
            <option value="">{t("Choose a paragraph…")}</option>
            {choices.map((p) => (
              <option key={p.start} value={p.start}>{(guess !== null && p.start <= guess && guess < p.end ? `${t("Most likely")}: ` : "") + cutToUnits(p.body.replace(/\s+/g, " "), 40)}</option>
            ))}
          </Select>
          <Button size="sm" variant="ghost" disabled={at === "" || saving} onClick={() => void pick()}>{t("Point here")}</Button>
        </div>
      ) : null}
    </div>
  );
}
