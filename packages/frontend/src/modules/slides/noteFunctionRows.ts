import { Presentation } from "lucide-react";
import { t, tn } from "../../lib/i18n";
import type { NoteFunctionEnv, NoteFunctionRow } from "../types";
import { presentNote } from "./present";
import { parseDeck } from "./slides";
import { isNote } from "@onden/markdown/contract";

/** The 「簡報」 row of the 功能 tab: a note that splits into several slides (`---`, else `##`) has a deck
 *  (its page count); any other note with text is offered as one. The note's own text is the deck, so there is
 *  no separate "source changed" state to show. */
export default function slidesNoteFunctionRows({ node, body, nav }: NoteFunctionEnv): NoteFunctionRow[] {
  if (!isNote(node) || !body.trim()) return [];
  const pages = parseDeck(body).slides.length;
  const deck = pages > 1;
  return [{
    id: "slides",
    Icon: Presentation,
    name: t("Slides"),
    related: deck,
    status: deck ? tn("Plays as 1 slide", "Plays as {n} slides", pages) : t("Play this note as slides"),
    action: { label: t("Play slides"), run: () => presentNote(node, nav.openNote) },
  }];
}
