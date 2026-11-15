// A review card's identity in one session and its routes: a whole-note card is
// its note; a paragraph card is its block node (several can share a note).

/** The part of a ReviewCard (@onden/contract) a card key is made from. */
type CardRef = { node_id: string; block?: { id: string } | null };

export function cardKey(card: CardRef): string {
  return card.block ? `block:${card.block.id}` : card.node_id;
}

/** The review routes of the card with key `key`. */
export function cardPath(key: string): string {
  return key.startsWith("block:") ? `/api/review/blocks/${key.slice(6)}` : `/api/review/${key}`;
}
