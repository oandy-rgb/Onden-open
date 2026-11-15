// Review cards: whether a whole note is a review card, and making it one or not (/api/review/cards/:noteId).
// A paragraph becomes a card by the review word in its `{…}`; only whole notes are switched here.

/** GET /api/review/cards/:noteId */
export type ReviewCardStatus = { node_id: string; card: boolean };

/** PUT (make a card) and DELETE (stop) /api/review/cards/:noteId. `changed` is false when the note already was in that state. */
export type ReviewCardChange = { note_id: string; card: boolean; changed: boolean };
