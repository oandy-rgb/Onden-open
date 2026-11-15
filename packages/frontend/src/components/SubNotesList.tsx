import { useMemo } from "react";
import type { ContentNode } from "../lib/api";
import { useTagRows } from "../lib/appStore";
import { sharedChildFields } from "../lib/childFields";
import MemberList from "./MemberList";

// A note's sub-notes under its text: just the list, with the fields they
// share as columns when there are any. The other ways of seeing them (table,
// calendar, board, cards) are tabs above the note (components/viewTabs), not a
// menu here. Read from the local store, so it shows offline.
type Props = {
  /** The note's sub-notes, as the page lists them. */
  subNotes: ContentNode[];
  onOpenNote: (id: string) => void;
};

export default function SubNotesList({ subNotes, onOpenNote }: Props) {
  const tags = useTagRows();
  const fields = useMemo(() => sharedChildFields(subNotes, tags ?? []), [subNotes, tags]);
  return <MemberList flat nodes={subNotes} fields={fields} onOpenNode={onOpenNote} />;
}
