import { memo, Suspense, useDeferredValue, useId, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ContentNode } from "../lib/api";
import { useAppSelector, useAllNodes } from "../lib/appStore";
import { findBacklinkSnippet, findMentionSnippet, type BacklinkSnippet } from "../lib/backlinks";
import { setPendingCursor } from "../lib/cursorHandoff";
import { countsAsBacklink } from "../lib/edgeKinds";
import { useT } from "../lib/i18n";
import { noteLinks, noteNeighborhood } from "../lib/noteNeighborhood";
import { useCanvasImported } from "../hooks/useModuleFilter";
import { lazyWithReload } from "../lib/lazyWithReload";
import "./OverviewEditor.css";
import { usePersistedFlag, PREFS } from "../lib/prefs";
import { BacklinkSnippetView as Snippet } from "./BacklinkSnippetView";
import "./NoteRelations.css";
import { Pressable } from "./ui";

// The sub-notes list: loaded when a note with sub-notes opens, and kept for
// offline use (lib/offlineWarmup).
const SubNotesList = lazyWithReload(() => import("./SubNotesList"));

// This note's relationships, under its body (moved from the right-hand
// inspector, 2026-10-18): its sub-notes as a plain list (the table, calendar,
// board and cards views of them are tabs above the note), who mentions it, where
// it sits (canvases), and — folded under "More" — what it links to.
// Every section hides while it has nothing to show (a note with no links shows
// nothing here: the "use [[" hint was on every such note and is gone).

/** Backlinks shown before "Show all". */
const BACKLINKS_SHOWN = 5;
/** Unlinked mentions are scanned up to this many. */
const MENTIONS_MAX = 20;

type Props = {
  node: ContentNode;
  /** Open a related note (a backlink lands the caret on the link). */
  onOpenNote: (id: string) => void;
  onOpenCanvas?: (canvasId: string) => void;
};

/** A section with a heading; `collapsible` sections start closed and the
 *  heading's button toggles them (keyed per note, so each note starts closed). */
function RelationSection({ title, count, collapsible = false, className, children }: {
  title: string; count?: number; collapsible?: boolean; className?: string; children: ReactNode;
}) {
  const headingId = useId();
  const [open, setOpen] = useState(!collapsible);
  const countEl = count !== undefined && <span className="ov-panel-count">{count}</span>;
  return (
    <section className={["note-relations-section", className].filter(Boolean).join(" ")} aria-labelledby={headingId}>
      <h2 id={headingId} className="note-relations-heading">
        {collapsible ? (
          <Pressable type="button" className="note-relations-toggle tap-target" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            <span>{title}</span>{countEl}
          </Pressable>
        ) : <><span>{title}</span>{countEl}</>}
      </h2>
      {open && <div className="note-relations-body">{children}</div>}
    </section>
  );
}

/** The sub-notes heading folds the list; folded or not is one setting for every note. */
function SubNotesHeading({ id, count, folded, onToggle }: { id: string; count: number; folded: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <h2 id={id} className="note-relations-heading">
      <Pressable type="button" className="note-relations-toggle tap-target" aria-expanded={!folded} onClick={onToggle}>
        {folded ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        <span>{t("Sub-notes")}</span><span className="ov-panel-count">{count}</span>
      </Pressable>
    </h2>
  );
}

function NoteRelations({ node, onOpenNote, onOpenCanvas }: Props) {
  const t = useT();
  const nodes = useAllNodes();
  const edges = useAppSelector((s) => s.data.edges);
  const allCanvasMemberships = useAppSelector((s) => s.data.canvas_memberships);
  // The boards a note is on show only with the whiteboard imported.
  const canvasImported = useCanvasImported();
  const [allBacklinks, setAllBacklinks] = useState(false);
  const [subNotesFolded, setSubNotesFolded] = usePersistedFlag(PREFS.noteSubNotesFolded, false);
  // Per-note UI state: a switch to another note starts collapsed again.
  const [stateFor, setStateFor] = useState(node.id);
  if (stateFor !== node.id) { setStateFor(node.id); setAllBacklinks(false); }

  const canvasMemberships = useMemo(
    () => (allCanvasMemberships ?? []).filter((m) => m.node_id === node.id),
    [node.id, allCanvasMemberships],
  );

  // Unlinked mentions (doc 09 #3): other notes whose markdown writes THIS
  // note's title as plain text but never linked it. This scans EVERY note's
  // markdown (O(n · body)), the heaviest derivation on the switch path, so it
  // is keyed on a DEFERRED node id: React commits the note switch first, then
  // recomputes mentions in a low-priority pass.
  const deferredNodeId = useDeferredValue(node.id);
  const unlinkedMentions = useMemo<{ node: ContentNode; snippet: BacklinkSnippet }[]>(() => {
    const target = nodes.find((n) => n.id === deferredNodeId);
    if (!target) return [];
    const linkedSourceIds = new Set(
      edges.filter((e) => e.target_node_id === target.id && countsAsBacklink(e)).map((e) => e.source_node_id),
    );
    const out: { node: ContentNode; snippet: BacklinkSnippet }[] = [];
    for (const n of nodes) {
      if (n.id === target.id || linkedSourceIds.has(n.id)) continue;
      const snippet = findMentionSnippet(n, target.title);
      if (snippet) {
        out.push({ node: n, snippet });
        if (out.length >= MENTIONS_MAX) break;
      }
    }
    return out;
  }, [deferredNodeId, nodes, edges]);

  // The same neighbourhood the info panel's 關係 tab and the graph read.
  const { backlinks, outgoing, children } = useMemo(
    () => noteLinks(noteNeighborhood(node, nodes, edges).relations),
    [node, nodes, edges],
  );
  const shownBacklinks = allBacklinks ? backlinks : backlinks.slice(0, BACKLINKS_SHOWN);
  const showsCanvases = canvasImported && canvasMemberships.length > 0;

  return (
    <section className="note-relations" aria-label={t("This note's relationships")}>
      {children.length > 0 && (
        <section className="note-relations-section note-relations-children" aria-labelledby={`${node.id}-sub-notes`}>
          <SubNotesHeading id={`${node.id}-sub-notes`} count={children.length} folded={subNotesFolded} onToggle={() => setSubNotesFolded((v) => !v)} />
          {!subNotesFolded && (
            <Suspense fallback={null}>
              <SubNotesList subNotes={children} onOpenNote={onOpenNote} />
            </Suspense>
          )}
        </section>
      )}

      {backlinks.length > 0 && (
        <RelationSection title={t(backlinks.length === 1 ? "Mentioned in {n} note" : "Mentioned in {n} notes", { n: backlinks.length })}>
          {shownBacklinks.map((src) => {
            // The prose around the wikilink to this note — the "why" of the
            // back-reference, not just "who" (doc 09).
            const snippet = findBacklinkSnippet(src, node);
            return (
              <Pressable
                key={src.id}
                type="button"
                className="backlink-card"
                // Land ON the referencing link, SELECTED (not just a caret): hand
                // the link's absolute span to the editor mount-restore.
                onClick={() => { if (snippet) setPendingCursor(src.id, snippet.linkAbsStart, snippet.linkAbsStart + (snippet.linkEnd - snippet.linkStart)); onOpenNote(src.id); }}
                title={t("Open {title}", { title: src.title })}
              >
                <span className="backlink-card-title">{src.title}</span>
                {snippet ? <Snippet snippet={snippet} /> : (
                  <span className="backlink-card-snippet backlink-card-snippet--muted">{t("(linked from this note)")}</span>
                )}
              </Pressable>
            );
          })}
          {backlinks.length > BACKLINKS_SHOWN && (
            <Pressable className="note-relations-more tap-target" onClick={() => setAllBacklinks((v) => !v)}>
              {allBacklinks ? t("Show less") : t("Show all {n}", { n: backlinks.length })}
            </Pressable>
          )}
        </RelationSection>
      )}

      {/* Notes that write this note's title as plain text but never linked
          it. Clicking opens the source with the mention selected, to link it. */}
      {unlinkedMentions.length > 0 && (
        <RelationSection key={`mentions-${node.id}`} title={t("Unlinked mentions")} count={unlinkedMentions.length} collapsible>
          {unlinkedMentions.map(({ node: src, snippet }) => (
            <Pressable
              key={src.id}
              type="button"
              className="backlink-card backlink-card--unlinked"
              onClick={() => { setPendingCursor(src.id, snippet.linkAbsStart, snippet.linkAbsStart + (snippet.linkEnd - snippet.linkStart)); onOpenNote(src.id); }}
              title={t("Open {title} — names this note without linking it", { title: src.title })}
            >
              <span className="backlink-card-title">{src.title}</span>
              <Snippet snippet={snippet} />
            </Pressable>
          ))}
        </RelationSection>
      )}

      {/* The canvases this note is on (many-to-many): "which thinking
          sessions touched this idea?" */}
      {showsCanvases && (
        <RelationSection title={t("Appears on canvases")} count={canvasMemberships.length}>
          {canvasMemberships.map((m) => (
            <Pressable key={m.canvas_id} type="button" className="ov-link-row" onClick={() => onOpenCanvas?.(m.canvas_id)} title={t("Open this canvas")}>
              {m.canvas_title}
            </Pressable>
          ))}
        </RelationSection>
      )}

      {outgoing.length > 0 && (
        <RelationSection key={`more-${node.id}`} title={t("More")} collapsible className="note-relations-extra">
          <h3 className="note-relations-subheading">{t("Outgoing Links")}<span className="ov-panel-count">{outgoing.length}</span></h3>
          {outgoing.map((n) => (
            <Pressable key={n.id} type="button" className="ov-link-row" onClick={() => onOpenNote(n.id)}>{n.title}</Pressable>
          ))}
        </RelationSection>
      )}
    </section>
  );
}

export default memo(NoteRelations);
