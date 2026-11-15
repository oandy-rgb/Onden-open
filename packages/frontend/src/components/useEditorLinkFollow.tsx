import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import EditorLinkChip from "./EditorLinkChip";
import type { ContentNode } from "../lib/api";
import { editorLinkFollow, followLink, type LinkChip, type LinkFollowEnv } from "../lib/editorLinkFollow";
import { resolveWikilink } from "../lib/wikilinks";
import { readPartLink } from "../lib/blockLinks";

/** Link following for a MarkdownEditor (lib/editorLinkFollow; read-only comes from the editor state): the extension
 *  to put in the editor's extensions, and the "Open" chip to render inside its
 *  wrapper. Links open as in Preview: `onOpenWikilink(label, targetId, blockId?)`. */
export function useEditorLinkFollow(args: {
  viewRef: RefObject<EditorView | null>;
  nodes: readonly ContentNode[];
  /** The note being edited (its space scopes `[[title]]` lookups). */
  nodeKey: string | undefined;
  onOpenWikilink?: (label: string, targetId: string | null, blockId?: string) => void;
}): { extension: Extension; chip: ReactNode } {
  const latest = useRef(args);
  useEffect(() => { latest.current = args; });
  const [chip, setChip] = useState<LinkChip | null>(null);

  const [env] = useState<LinkFollowEnv>(() => ({
    resolveNote: (label) => {
      const { nodes, nodeKey } = latest.current;
      const self = nodes.find((n) => n.id === nodeKey);
      return resolveWikilink(label, self ? { id: self.id, space_id: self.space_id } : null, nodes);
    },
    selfId: () => latest.current.nodeKey ?? null,
    partTarget: (label) => {
      const { nodes, nodeKey } = latest.current;
      const self = nodes.find((n) => n.id === nodeKey);
      const read = readPartLink(label, { nodes, from: self ? { id: self.id, space_id: self.space_id } : null });
      switch (read.kind) {
        case "not-a-part": case "no-such-part": return null;
        case "part": case "maybe": return { noteId: read.part.noteId, title: read.part.noteTitle, at: read.part.from };
        case "lost": case "pending": return { noteId: read.noteId, title: read.noteTitle, at: null };
        case "ambiguous": return { noteId: read.options[0]!.noteId, title: read.options[0]!.noteTitle, at: read.options[0]!.from };
        case "erased": case "unavailable": return "closed";
      }
    },
    openWikilink: (label, targetId, blockId) => latest.current.onOpenWikilink?.(label, targetId, blockId),
  }));
  const [extension] = useState(() => editorLinkFollow({
    env, onChip: setChip,
  }));

  // A chip belongs to the note it appeared in.
  useEffect(() => { setChip(null); }, [args.nodeKey]);

  const follow = useCallback(() => {
    const view = args.viewRef.current;
    if (view && chip) followLink(view, chip.link, env);
  }, [args.viewRef, chip, env]);

  const view = args.viewRef.current;
  return {
    extension,
    chip: chip && <EditorLinkChip chip={chip} wrap={view?.dom.closest<HTMLElement>(".md-editor-wrap") ?? null} onFollow={follow} />,
  };
}
