// The rows of the `[[Note#` popup (lib/wikilinkTargets.ts): which note the
// typed text names, that note's targets (the editor's own text for the note
// being edited, else read through the data layer — the open row, this
// device's copy, the server), and the filter. `rows` is null when the typed
// text names no note (then the popup is the plain note list).

import { useEffect, useMemo, useState } from "react";
import { anchorSpansOf } from "../lib/blockAnchorStore";
import { listLinkTargets, type LinkTarget } from "@onden/markdown";
import type { ContentNode } from "../lib/api";
import { useOnline } from "../lib/appStore";
import { useCapabilities } from "../lib/capabilities";
import { reads } from "../lib/data";
import { parseTargetQuery, resolveNoteByTitle, targetRows, type LinkTargetRow } from "../lib/wikilinkTargets";

export type LinkTargetList = { rows: LinkTargetRow[]; status: "ready" | "loading" | "unavailable" } | null;

type Options = {
  nodes: readonly ContentNode[];
  /** The note being edited, and its text as the editor holds it now. */
  currentId: string | undefined;
  currentText: () => string;
};

export function useLinkTargets(wikilinkQuery: string | null, { nodes, currentId, currentText }: Options): LinkTargetList {
  const online = useOnline();
  const caps = useCapabilities(online);
  const parsed = useMemo(() => {
    if (wikilinkQuery === null) return null;
    const current = nodes.find((n) => n.id === currentId);
    return parseTargetQuery(wikilinkQuery, (name) => resolveNoteByTitle(name, nodes, current));
  }, [wikilinkQuery, nodes, currentId]);

  const note = parsed?.note ?? null;
  const same = !!note && note.id === currentId;
  const [loaded, setLoaded] = useState<{ id: string; targets: LinkTarget[] | null } | null>(null);
  const noteId = note?.id;
  useEffect(() => {
    const target = nodes.find((n) => n.id === noteId);
    if (!target || same) return;
    let live = true;
    void reads.notes.body(target).then((markdown) => {
      if (live) setLoaded({ id: target.id, targets: markdown === null ? null : listLinkTargets(markdown, anchorSpansOf(target.id, markdown)) });
    });
    return () => { live = false; };
    // Read again only for another note (nodes changes on every edit).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, same]);

  return useMemo(() => {
    if (!parsed || !note) return null;
    const info = { id: note.id, title: note.title, sameNote: same, writable: same || caps.canEdit(note) };
    if (same) return { rows: targetRows(parsed, listLinkTargets(currentText(), anchorSpansOf(note.id, currentText())), info), status: "ready" as const };
    if (loaded?.id !== note.id) return { rows: [], status: "loading" as const };
    if (!loaded.targets) return { rows: [], status: "unavailable" as const };
    return { rows: targetRows(parsed, loaded.targets, info), status: "ready" as const };
    // `wikilinkQuery` is in `parsed`: the editor's text is read again for each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, loaded, same, caps]);
}
