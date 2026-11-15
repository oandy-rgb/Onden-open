// Adding a block of text to the end of a note's body.

/** `base` with `block` at the very end: one blank line after the last text,
 *  trailing whitespace of `base` replaced, one newline at the end. */
export function appendedBody(base: string, block: string): string {
  const kept = base.replace(/\s+$/, "");
  return `${kept}${kept ? "\n\n" : ""}${block}\n`;
}
