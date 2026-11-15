// Open a tag's page at its field settings, from anywhere (a note's tag card's
// 「編輯 #X 的欄位 →」). The caller still opens the tag the usual way; this
// only tells the tag page (SchemaLens) to start with its fields editor open.
// A page mounting for the tag takes the request; a page already showing it
// hears the event.

const EVENT = "onden:open-tag-fields";
let pendingTagId: string | null = null;

/** Ask the tag page for `tagId` to open its field settings. Call it right
 *  before opening the tag. */
export function requestTagFields(tagId: string): void {
  pendingTagId = tagId;
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: tagId }));
}

/** Whether a request for `tagId` is waiting; takes it (once). */
export function takeTagFieldsRequest(tagId: string): boolean {
  if (pendingTagId !== tagId) return false;
  pendingTagId = null;
  return true;
}

/** Calls `open` when the fields of `tagId` are asked for while its page is
 *  showing; returns the unsubscribe. */
export function onTagFieldsRequest(tagId: string, open: () => void): () => void {
  const handler = (event: Event) => {
    if ((event as CustomEvent<string>).detail !== tagId) return;
    pendingTagId = null;
    open();
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
