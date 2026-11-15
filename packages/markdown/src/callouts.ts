// `> [!note] Title` blockquotes (GitHub / Obsidian callouts) become
// `<div class="callout callout-note">` with a title paragraph. Moved from the
// frontend MarkdownRenderer so the app, the published site and the exports
// render callouts the same way.

import { visit } from "unist-util-visit";
import type { Root, Blockquote, Paragraph, PhrasingContent } from "mdast";

/** Obsidian's callout types and their aliases (help.obsidian.md/callouts). Each
 *  alias draws as its type; a type not listed here draws as `note`, as Obsidian
 *  does. The one list: the renderer, link previews and block labels read it. */
const CALLOUT_ALIASES = {
  note: [],
  abstract: ["summary", "tldr"],
  info: [],
  todo: [],
  tip: ["hint", "important"],
  success: ["check", "done"],
  question: ["help", "faq"],
  warning: ["caution", "attention"],
  failure: ["fail", "missing"],
  danger: ["error"],
  bug: [],
  example: [],
  quote: ["cite"],
} as const satisfies Record<string, readonly string[]>;

export type CalloutType = keyof typeof CALLOUT_ALIASES;
export const CALLOUT_TYPES = Object.keys(CALLOUT_ALIASES) as CalloutType[];

const CALLOUT_ICONS: Record<CalloutType, string> = {
  note: "ℹ️", abstract: "📋", info: "ℹ️", todo: "☑️", tip: "💡", success: "✅", question: "❓",
  warning: "⚠️", failure: "❌", danger: "🚨", bug: "🐛", example: "📑", quote: "💬",
};

const TYPE_OF = new Map<string, CalloutType>(
  (Object.entries(CALLOUT_ALIASES) as [CalloutType, readonly string[]][]).flatMap(([type, aliases]) => [[type, type], ...aliases.map((a) => [a, type] as const)]),
);

/** The type a callout written `[!name]` draws as (case does not matter); `note` for a name Obsidian does not know. */
export function calloutType(name: string): CalloutType {
  return TYPE_OF.get(name.toLowerCase()) ?? "note";
}

// `[!type]`, optionally `+` / `-` (Obsidian's open/closed fold), then spaces.
const MARKER = /^\[!([A-Za-z0-9_-]+)\]([+-]?)[ \t]*/;

/** `-` starts folded, `+` starts open, no mark is not foldable (Obsidian). */
export type CalloutFold = "open" | "closed" | null;

/** The callout marker at the start of `text`: the name as written, its drawn type, its fold and how many characters it takes; null if `text` does not start with one. */
export function parseCalloutMarker(text: string): { name: string; type: CalloutType; fold: CalloutFold; length: number } | null {
  const match = MARKER.exec(text);
  if (!match) return null;
  const fold = match[2] === "+" ? "open" : match[2] === "-" ? "closed" : null;
  return { name: match[1]!, type: calloutType(match[1]!), fold, length: match[0].length };
}

/** The title a callout is written with: the rest of the marker's line (`> [!tip] My title` is "My title"), and the body after it. */
function splitTitle(children: PhrasingContent[]): { title: PhrasingContent[]; body: PhrasingContent[] } {
  const title: PhrasingContent[] = [];
  const body: PhrasingContent[] = [];
  let inBody = false;
  for (const child of children) {
    if (inBody) body.push(child);
    else if (child.type === "break") inBody = true;
    else if (child.type === "text" && child.value.includes("\n")) {
      const at = child.value.indexOf("\n");
      if (child.value.slice(0, at)) title.push({ ...child, value: child.value.slice(0, at) });
      const after = child.value.slice(at + 1);
      if (after) body.push({ ...child, value: after });
      inBody = true;
    } else title.push(child);
  }
  return { title, body };
}

/** `text` without its callout marker (unchanged when there is none). */
export function stripCalloutMarker(text: string): string {
  return text.slice(parseCalloutMarker(text)?.length ?? 0);
}

export function remarkCallouts() {
  return (tree: Root) => {
    visit(tree, "blockquote", (node: Blockquote) => {
      const first = node.children[0];
      if (first?.type !== "paragraph") return;
      const text = first.children[0];
      if (text?.type !== "text") return;
      const marker = parseCalloutMarker(text.value);
      if (!marker) return;
      const { type, fold } = marker;
      const rest = first.children.slice();
      (rest[0] as typeof text) = { ...text, value: text.value.slice(marker.length) };
      const { title: written, body } = splitTitle(rest.filter((child) => child.type !== "text" || child.value !== ""));
      const hasTitle = written.length > 0 && !(written.length === 1 && written[0]!.type === "text" && written[0].value.trim() === "");
      // Without a title of its own the callout is named by its marker, as before.
      const title: Paragraph = {
        type: "paragraph",
        data: { hName: fold ? "summary" : "p", hProperties: { className: ["callout-title"] } },
        children: hasTitle ? written : [{ type: "text", value: `${CALLOUT_ICONS[type]} ${marker.name.toUpperCase()}` }],
      };
      const bodyFirst = body[0];
      if (bodyFirst?.type === "text") body[0] = { ...bodyFirst, value: bodyFirst.value.trimStart() };
      if (body.length) first.children = body;
      else node.children.splice(0, 1);
      node.children.unshift(title);
      // Its other properties (a `^id`'s data-block-id, remarkBlockId) stay.
      node.data = { ...(node.data ?? {}), hName: fold ? "details" : "div", hProperties: { ...(node.data as { hProperties?: object } | undefined)?.hProperties, className: ["callout", `callout-${type}`], ...(fold === "open" ? { open: true } : {}) } };
    });
  };
}
