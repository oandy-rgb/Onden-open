// A generated note's blocks (roundTripArb.ts BlockSpec) as the Markdown a
// person would type. Pure, so the DB-free render tests and the builders that
// write into Postgres or into a vault share one rendering.

import type { BlockSpec, NoteSpec, WorldSpec } from "./roundTripArb.js";

/** Titles that a `[[…]]` can carry whole (services/exportZip.ts linkableTitle). */
export const linkable = (title: string) => !/[[\]|#\r\n]/.test(title);

/** A block as the Markdown a person would type. */
function renderBlock(block: BlockSpec, ctx: { notes: NoteSpec[]; ids: string[]; refs: Set<string> }): string {
  switch (block.kind) {
    case "paragraph": {
      const text = block.tag ? `${block.text} {${block.tag}}` : block.text;
      if (block.ref && !ctx.refs.has(block.ref)) { ctx.refs.add(block.ref); return `${text} ^${block.ref}`; }
      return text;
    }
    case "heading": return `${"#".repeat(block.level)} ${block.text}`;
    case "list": return block.items.map((item, i) => (block.ordered ? `${i + 1}. ${item}` : `- ${item}`)).join("\n");
    case "task": return `- [${block.done ? "x" : " "}] ${block.text}`;
    case "code": return ["```" + block.lang, ...block.lines, "```"].join("\n");
    case "math": return block.display ? `$$\n${block.formula}\n$$` : `Inline $${block.formula}$ math`;
    case "image": return `![${block.alt}](https://example.com/img-${block.n}.png)`;
    case "quote": return `> ${block.text}`;
    case "link": {
      const target = ctx.notes[block.target]!;
      if (block.via === "wikilink" && linkable(target.title)) return `See [[${target.title}${block.alias ? `|${block.alias}` : ""}]]`;
      return `See [${block.alias ?? target.title}](onden://node/${ctx.ids[block.target]})`;
    }
    case "embed": return linkable(ctx.notes[block.target]!.title) ? `![[${ctx.notes[block.target]!.title}]]` : "Embedded";
    case "blockLink": {
      const target = ctx.notes[block.target]!;
      const ref = target.blocks.find((b) => b.kind === "paragraph" && b.ref)?.["ref" as never] as string | undefined;
      return linkable(target.title) ? (ref ? `See [[${target.title}#^${ref}]]` : `See [[${target.title}]]`) : "Linked";
    }
  }
}

export function renderBody(note: NoteSpec, noteIndex: number, spec: WorldSpec, ids: string[], mediaFile: string | undefined): string {
  const ctx = { notes: spec.notes, ids, refs: new Set<string>() };
  const blocks = note.blocks.map((b) => renderBlock(b, ctx));
  if (mediaFile) blocks.push(`![scan](/api/media/${mediaFile})`);
  void noteIndex;
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

