// Review module (frontend) — FSRS spaced repetition over notes whose tag
// enables Review. Everything the shell shows for it is declared here and read
// through modules/index.ts:
//   • screen — the card-at-a-time study page (`?view=review`), optionally
//     scoped to one note's subtree; lazy so the markdown renderer chunk stays
//     out of the main bundle;
//   • paragraphAction — a paragraph with `{review}` is a card (a note save gives it its own reference);
//   • noteCommands — make a whole note a card or stop, review the cards under a note, extract Q:/A: blocks into cards;
//   • HomeSection — "N notes ready to review" with the busiest decks;
//   • openCommand — open the session.
// There is no tag to switch on: a card is a note or a paragraph with its own function reference (migration 195).

import { Suspense } from "react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { GraduationCap, Sparkles, Layers } from "lucide-react";
import type { FrontendModule, NoteHeaderActionProps } from "../types";
import ReviewHomeSection from "./ReviewHomeSection";
import { extractCardsFromNote } from "./extractCards";
import { extractReviewCards } from "./reviewExtract";
import { setNoteReviewCard } from "./reviewCard";
import { noteHasReviewCards, noteIsReviewCard } from "./noteCardStatus";
import { t } from "../../lib/i18n";
import { noteStructure } from "../../lib/data";

export { useReviewStats, type ReviewStats } from "./useReviewStats";

const NoteCardPrefetch = lazyWithReload(() => import("./NoteCardPrefetch"));
const NoteCardPrefetchAction = (props: NoteHeaderActionProps) => <Suspense fallback={null}><NoteCardPrefetch {...props} /></Suspense>;

export const reviewModule: FrontendModule = {
  id: "review",
  library: {
    title: "Review",
    description: "Spaced repetition: turn notes into cards and review them on schedule (FSRS).",
    Icon: GraduationCap,
    group: { id: "reading", order: 3 },
    blurb: "Turn notes into cards and review them on schedule",
    // Not translated on purpose: the word `{review}` in a paragraph makes it a card.
    paragraphAction: { id: "review_block", label: "Make this block a review card", Icon: GraduationCap },
    manifest: {
      adds: [
        { kind: "page", text: "A Review page with the cards due today." },
        { kind: "schedule", text: "Each card gets a review schedule (FSRS), kept on the note." },
      ],
      notes: "Only notes and paragraphs you make cards.",
      network: null,
    },
  },
  screen: { label: "Review", Icon: Sparkles, Component: lazyWithReload(() => import("./ReviewScreen")) },
  openCommand: { id: "a-review", label: "Go to Review", keywords: ["study", "flashcards", "spaced", "srs", "due", "複習", "到期", "卡片", "閃卡", "記憶"], group: "Navigate", hint: "place" },
  HomeSection: ({ open }) => (
    <ReviewHomeSection onOpenReview={() => open()} onStudyDeck={(rootId, rootTitle) => open({ rootId, rootTitle })} onOpenStatus={() => open({ page: "status" })} />
  ),
  noteHeaderAction: NoteCardPrefetchAction,
  noteCommands: [
    {
      id: "a-review-card-on",
      label: "Make this note a review card",
      keywords: ["study", "flashcard", "spaced", "review", "card"],
      // Both are shown by what the server said about this note: "make" until it is a card, "stop" once it is.
      available: (node) => noteIsReviewCard(node.id) !== true,
      run: async ({ node }) => { await setNoteReviewCard(node.id, true); },
    },
    {
      id: "a-review-card-off",
      label: "Stop using this note as a review card",
      keywords: ["study", "flashcard", "spaced", "review", "card"],
      available: (node) => noteIsReviewCard(node.id) === true,
      run: async ({ node }) => { await setNoteReviewCard(node.id, false); },
    },
    {
      // 抓題: Q:/A: blocks become child cards under the note.
      id: "a-extract-cards",
      label: "Extract review cards (Q:/A:)",
      keywords: ["flashcards", "study", "spaced", "review"],
      available: (_node, body) => extractReviewCards(body).length > 0,
      // Named for what it does, so it is not the second 「複習」 of the tab (the row below is the one that starts a review).
      row: {
        Icon: Layers, name: "Cards from Q&A", action: "Make cards",
        describe: (node, body) => {
          const all = extractReviewCards(body);
          // A question already made a card under this note is matched by its title, as the extraction itself does (extractCards).
          const titles = new Set(noteStructure.children(node.id).map((child) => (child.title ?? "").trim()));
          const done = all.filter((card) => titles.has(card.question)).length;
          if (done === 0) return t("{n} Q&A pairs in this note", { n: all.length });
          if (done >= all.length) return t("All {n} Q&A pairs are already cards", { n: all.length });
          return t("{n} Q&A pairs in this note, {done} already cards", { n: all.length, done });
        },
      },
      run: async ({ node, refresh }) => { if (await extractCardsFromNote(node) > 0) await refresh(); },
    },
    {
      // Cards grow in the structure: a deck is a note's subtree.
      id: "a-review-here",
      label: "Review cards under this note",
      keywords: ["study", "deck", "flashcards"],
      // Offered where there is something to review here: notes under it, the note itself is a card, or a paragraph of it
      // carries the review word (then opening it also offers back the paragraph cards that were stopped, StoppedInNote).
      available: (node, body) => noteHasReviewCards(node, body, noteStructure.children(node.id).length),
      row: { Icon: GraduationCap, name: "Review this note's cards", action: "Review", describe: () => t("Study the cards in this note and under it") },
      run: ({ node, open }) => open({ rootId: node.id, rootTitle: node.title || "" }),
    },
  ],
};
