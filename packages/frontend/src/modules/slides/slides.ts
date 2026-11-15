// The deck cut moved to @onden/markdown (slideDeck.ts) so the server's getSlides reads a note the same way; this
// file keeps the old import path working.
export { parseDeck, type SlideDeck as Deck, type Slide, type DeckSource } from "@onden/markdown";
