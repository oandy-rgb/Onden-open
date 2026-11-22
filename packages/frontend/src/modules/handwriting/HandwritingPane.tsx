// The 「手寫」 tab of a note: a stack of fixed pages to write on, drawn by the same notebook surface a handwriting
// note's content tab is (components/InkNodeView over the page book). The strokes are the note's own attribute
// `note_ink` (not `ink_data`, so the note's text stays its content tab), loaded and saved through the same path the
// handwriting note uses (lib/ink/store, lib/ink/surfaceSaver → lib/data saveInk).
import { Suspense, useEffect, useState } from "react";
import { NOTE_INK_ATTR, isInkReadOnly, noteDoc, notePages, type InkPages, decodeInk } from "@onden/markdown/ink";
import { NOTE_PAGES_ATTR } from "@onden/markdown/contract";
import { decodeNotePages, type NotePages } from "@onden/markdown/note-pages";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { useDrawingRestoreSerial } from "../../hooks/useDrawingRestoreSerial";
import { loadInkAttributes, notifyInkReadOnly, useInkSurfaceSaver } from "../../lib/ink";
import type { InkSaveOptions } from "../../lib/data";
import { useT } from "../../lib/i18n";
import type { NoteViewPaneProps } from "../types";
import "./handwritingPane.css";

const InkNodeView = lazyWithReload(() => import("../../components/InkNodeView"));
const NotePagesBook = lazyWithReload(() => import("./NotePagesBook"));

type Loaded = { nodeId: string; pages: InkPages; readOnly: boolean; list: NotePages | null; listValue: string };

export default function HandwritingPane({ node, canEdit }: NoteViewPaneProps) {
  const t = useT();
  const nodeId = node.id;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const { rebase, save } = useInkSurfaceSaver(NOTE_INK_ATTR);
  // A version put back from History: this pane loads it again.
  const drawingRestored = useDrawingRestoreSerial(nodeId);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null); // a note opened again reloads; never re-show an older copy
    void (async () => {
      // The server, or the local mirror while this note's attribute writes are still queued or the network is down.
      const { note_ink: stored, note_pages: listValue } = await loadInkAttributes(nodeId, [NOTE_INK_ATTR, NOTE_PAGES_ATTR] as const);
      if (cancelled) return;
      const ink = decodeInk(stored);
      const pages = notePages(ink.kind === "page" ? ink.doc : null);
      const doc = stored == null ? null : noteDoc(pages);
      rebase(nodeId, doc);
      // A list made with a newer version is not read here: the strokes show as stored and nothing is saved over it.
      const decoded = decodeNotePages(listValue);
      const readOnly = isInkReadOnly(doc) || (!decoded.ok && decoded.reason === "newer");
      if (readOnly) notifyInkReadOnly();
      setLoaded({ nodeId, pages, readOnly, list: decoded.ok ? decoded.pages : null, listValue: listValue ?? "" });
    })();
    return () => { cancelled = true; };
  }, [nodeId, rebase, drawingRestored]);

  if (!loaded || loaded.nodeId !== nodeId) return <div className="handwriting-pane" aria-busy="true" />;
  // The surface hands over a settled document (debounced inside the pages' session, flushed when the view goes away).
  const persist = (next: InkPages, options?: InkSaveOptions) => {
    const doc = noteDoc(next);
    if (doc && !loaded.readOnly) save(nodeId, doc, options);
  };
  return (
    <div className="handwriting-pane">
      <Suspense fallback={null}>
        {loaded.list ? (
          <NotePagesBook key={nodeId} nodeId={nodeId} list={loaded.list} listValue={loaded.listValue} stored={loaded.pages} readOnly={loaded.readOnly || !canEdit}
            readOnlyNotice={loaded.readOnly ? undefined : t("You can read this note but not change it, so this opens read-only.")}
            save={(doc, options) => save(nodeId, doc, options)} />
        ) : <InkNodeView key={nodeId} initialPages={loaded.pages} onPagesChange={persist} readOnly={loaded.readOnly || !canEdit} readOnlyNotice={loaded.readOnly ? undefined : t("You can read this note but not change it, so this opens read-only.")} nodeId={nodeId} />}
      </Suspense>
    </div>
  );
}
