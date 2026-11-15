// A card created by clicking the board opens with its title ready for typing.
// The creator names the card before it exists on the board; the card claims
// the request when it mounts (or right away if it is already there).
// A note created from a note's menu (「在裡面新增」) does the same with the
// editor's title field: one request channel per surface, so a board card and
// the editor never claim each other's request.
function titleFocusChannel(event: string) {
  let pending: string | null = null;
  return {
    request(nodeId: string): void {
      pending = nodeId;
      window.dispatchEvent(new CustomEvent(event, { detail: nodeId }));
    },
    /** True once for the node that was asked for; later calls return false. */
    claim(nodeId: string): boolean {
      if (pending !== nodeId) return false;
      pending = null;
      return true;
    },
    onRequest(listener: (nodeId: string) => void): () => void {
      const handler = (e: Event) => listener((e as CustomEvent<string>).detail);
      window.addEventListener(event, handler);
      return () => window.removeEventListener(event, handler);
    },
  };
}

const card = titleFocusChannel("onden-focus-card-title");
const note = titleFocusChannel("onden-focus-note-title");

export const requestCardTitleFocus = card.request;
export const claimCardTitleFocus = card.claim;
export const onCardTitleFocusRequest = card.onRequest;

/** The editor's title field takes focus when it shows `nodeId` next. */
export const requestNoteTitleFocus = note.request;
export const claimNoteTitleFocus = note.claim;
export const onNoteTitleFocusRequest = note.onRequest;

/** Focus a title field and select its text. The create dialog hands focus back
 *  to the button that opened it as it closes, which can land after this, so the
 *  field takes focus back for a moment unless the writer has put it somewhere of
 *  their own (not the page or a button). Returns a function that stops the retries. */
export function focusTitleField(field: () => HTMLInputElement | HTMLTextAreaElement | null): () => void {
  const take = () => { field()?.focus(); field()?.select(); };
  take();
  const timers = [60, 250].map((ms) => window.setTimeout(() => {
    const active = document.activeElement;
    if (active === document.body || active instanceof HTMLButtonElement) take();
  }, ms));
  return () => timers.forEach((id) => window.clearTimeout(id));
}
