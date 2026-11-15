// Open one field's settings popover (tagPage/FieldPopover) from anywhere on
// the tag's pages: a field chip under the title, or a column name in the
// tag's table view. The popover is the tag page's, so both ask the same way.
// (Apart from lib/tagPageRequest so the table's few lines stay in the first
// load and the listening side loads with the popover.)

const FIELD_EVENT = "onden:edit-tag-field";

/** `field`: the field's key (a table column) or its place in the tag's own
 *  field list (a chip); null adds a new field and opens it. `at` is where the
 *  popover opens (just under the element that was pressed). */
export type FieldEditorRequest = { tagId: string; field: string | number | null; at: { x: number; y: number } };

export function requestFieldEditor(request: FieldEditorRequest): void {
  window.dispatchEvent(new CustomEvent<FieldEditorRequest>(FIELD_EVENT, { detail: request }));
}

/** Calls `open` for requests about `tagId`'s fields; returns the unsubscribe. */
export function onFieldEditorRequest(tagId: string, open: (request: FieldEditorRequest) => void): () => void {
  const handler = (event: Event) => {
    const request = (event as CustomEvent<FieldEditorRequest>).detail;
    if (request.tagId === tagId) open(request);
  };
  window.addEventListener(FIELD_EVENT, handler);
  return () => window.removeEventListener(FIELD_EVENT, handler);
}

/** The point just under `el`, where a popover about it opens. */
export function pointBelow(el: Element): { x: number; y: number } {
  const box = el.getBoundingClientRect();
  return { x: box.left, y: box.bottom + 4 };
}
