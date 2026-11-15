// The 「手寫」 tab of a note: a stack of fixed pages to write on, drawn by the same notebook surface a handwriting
// note's content tab is (components/InkNodeView over the page book). The strokes are the note's own attribute
// `note_ink` (not `ink_data`, so the note's text stays its content tab), loaded and saved through the same path the
// handwriting note uses (lib/ink/store, lib/ink/surfaceSaver → lib/data saveInk).
import { Suspense, useEffect, useState } from "react";
import { NOTE_INK_ATTR, isInkReadOnly, noteDoc, notePages, type InkPages } from "@onden/markdown/ink";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { decodeInk, loadInkAttributes, notifyInkReadOnly, useInkSurfaceSaver } from "../../lib/ink";
import type { InkSaveOptions } from "../../lib/data";
import { useT } from "../../lib/i18n";
import type { NoteViewPaneProps } from "../types";
import "./handwritingPane.css";

const InkNodeView = lazyWithReload(() => import("../../components/InkNodeView"));

type Loaded = { nodeId: string; pages: InkPages; readOnly: boolean };

export default function HandwritingPane({ node, canEdit }: NoteViewPaneProps) {
  const t = useT();
  const nodeId = node.id;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const { rebase, save } = useInkSurfaceSaver(NOTE_INK_ATTR);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null); // a note opened again reloads; never re-show an older copy
    void (async () => {
      // The server, or the local mirror while this note's attribute writes are still queued or the network is down.
      const { note_ink: stored } = await loadInkAttributes(nodeId, [NOTE_INK_ATTR] as const);
      if (cancelled) return;
      const ink = decodeInk(stored);
      const pages = notePages(ink.kind === "page" ? ink.doc : null);
      const doc = stored == null ? null : noteDoc(pages);
      rebase(nodeId, doc);
      const readOnly = isInkReadOnly(doc);
      if (readOnly) notifyInkReadOnly();
      setLoaded({ nodeId, pages, readOnly });
    })();
    return () => { cancelled = true; };
  }, [nodeId, rebase]);

  if (!loaded || loaded.nodeId !== nodeId) return <div className="handwriting-pane" aria-busy="true" />;
  // The surface hands over a settled document (debounced inside the pages' session, flushed when the view goes away).
  const persist = (next: InkPages, options?: InkSaveOptions) => {
    const doc = noteDoc(next);
    if (doc && !loaded.readOnly) save(nodeId, doc, options);
  };
  return (
    <div className="handwriting-pane">
      <Suspense fallback={null}>
        <InkNodeView key={nodeId} initialPages={loaded.pages} onPagesChange={persist} readOnly={loaded.readOnly || !canEdit} readOnlyNotice={loaded.readOnly ? undefined : t("You can read this note but not change it, so this opens read-only.")} nodeId={nodeId} />
      </Suspense>
    </div>
  );
}
