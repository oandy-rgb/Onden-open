// lowlight without its bundled grammar lists: lazy.ts imports this, so the
// chunk holds the highlighter alone and each grammar arrives on its own.
// A function, not a re-export: the server build (Rollup, lowlight external)
// dropped the binding of a bare `export { createLowlight } from "lowlight"`
// when it merged this module into a shared chunk.
import { createLowlight } from "lowlight";
import { toText } from "hast-util-to-text";

// The text of a code node (hast-util-to-text) rides on the lowlight instance, so the
// boot JS, which never highlights, does not carry that library.
export function withNodeText<T extends object>(lowlight: T) {
  return Object.assign(lowlight, {
    textOf: (node: Parameters<typeof toText>[0]) => toText(node, { whitespace: "pre" }),
  });
}

export function emptyLowlight() {
  return withNodeText(createLowlight());
}
