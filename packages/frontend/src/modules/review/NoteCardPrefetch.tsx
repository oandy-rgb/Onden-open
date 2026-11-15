import { useEffect } from "react";
import type { NoteHeaderActionProps } from "../types";
import { noteIsReviewCard } from "./noteCardStatus";

/** Shows nothing: asks the server whether the selected note is a review card, so its review commands know before a menu opens. */
export default function NoteCardPrefetch({ node }: NoteHeaderActionProps) {
  useEffect(() => { noteIsReviewCard(node.id); }, [node.id]);
  return null;
}
