import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { cjkAttentionSides } from "@onden/markdown";

// `**「重點」**接著` in the editor's markdown grammar, read the way the preview
// pane and the published page read it (packages/markdown cjkEmphasis.ts).
// CommonMark refuses a closing `**` when punctuation is before it and a letter
// after it, which is how every Chinese sentence with 「」 or （） reads; the
// CJK-friendly rule accepts it. Lezer's own emphasis parser has the
// CommonMark rule built in, so this one lets it run and only replaces which
// sides of the run may open and close (`side`: 1 opens, 2 closes) with the
// shared answer. Matching, nesting and node names stay Lezer's.
//
// It reaches for two members Lezer does not document (`parser.inlineNames` /
// `inlineParsers`, to find its own emphasis parser). If a Lezer upgrade
// removes them this falls back to the CommonMark rule instead of breaking, and
// test/properties/cjkEmphasis.property.test.ts (editor and parser must find
// the same bold and italic spans) fails.

const ASTERISK = 42;
const UNDERSCORE = 95;
const LOOKBEHIND = 4; // UTF-16 units: two code points, as cjkAttentionSides reads
const LOOKAHEAD = 2;

type InlineParse = (cx: InlineContext, next: number, pos: number) => number;
type PartWithSide = { side?: unknown };
/** InlineContext as Lezer's own parsers use it: `append` takes elements and delimiters but is not in its types. */
type AppendingContext = InlineContext & { append(part: unknown): number };

export const cjkEmphasis: MarkdownConfig = {
  parseInline: [{
    name: "CjkEmphasis",
    before: "Emphasis",
    parse(cx, next, start) {
      if (next !== ASTERISK && next !== UNDERSCORE) return -1;
      const parser = cx.parser as unknown as { inlineNames?: string[]; inlineParsers?: unknown[] };
      const at = parser.inlineNames?.indexOf("Emphasis") ?? -1;
      const builtin = at >= 0 ? parser.inlineParsers?.[at] : undefined;
      if (typeof builtin !== "function") return -1;

      let end = start + 1;
      while (cx.char(end) === next) end++;
      const { open, close } = cjkAttentionSides(
        cx.slice(Math.max(cx.offset, start - LOOKBEHIND), start),
        cx.slice(end, Math.min(cx.end, end + LOOKAHEAD)),
        next === ASTERISK ? "*" : "_",
      );
      const side = (open ? 1 : 0) | (close ? 2 : 0);
      const patched: AppendingContext = Object.create(cx);
      patched.append = (part) => {
        if (typeof (part as PartWithSide).side === "number") (part as { side: number }).side = side;
        return (cx as AppendingContext).append(part);
      };
      return (builtin as InlineParse)(patched, next, start);
    },
  }],
};
