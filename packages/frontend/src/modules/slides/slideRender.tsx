// How the slides draw Markdown: the one function the view's pictures and the
// full-screen player share, so a [[link]] resolves among the same notes and the
// words look the same in both.
import type { ReactNode } from "react";
import { NotePreview } from "../../components/markdownSurfaces";
import type { ContentNode } from "../../lib/api";
import type { WikilinkSource } from "../../lib/wikilinks";

export function slideRenderer(nodes: ContentNode[], from: WikilinkSource | null | undefined, openNote?: (id: string) => void) {
  // A render callback (Markdown → ReactNode), not a component.
  // eslint-disable-next-line react/display-name
  return (markdown: string): ReactNode => (
    <NotePreview nodes={nodes} from={from} onNavigate={(_slug, id) => { if (id) openNote?.(id); }}>{markdown}</NotePreview>
  );
}
