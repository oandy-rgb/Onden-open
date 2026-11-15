import { embedMatches, expandExcerptEmbeds } from "@onden/markdown";
import { anchorSpansOf, type AnchorSpan } from "./blockAnchorStore";
import { readPartLink } from "./blockLinks";
import { getAppState } from "./appStore";
import { resolveEmbed } from "./embeds";
import { embedSource } from "./embedSources";
import { untitledTitle } from "./noteLabel";
import type { NoteExportSnapshot } from "./noteExport";

/** The snapshot with each `![[Note/words]]` (a part link) or old-form `![[Note#^id]]` line (`id`: the anchor's) that embeds an EXCERPT (a quote
 *  with its source link, @onden/markdown excerpt.ts) replaced by the quote and
 *  its link, so the file reads without the note it was embedded from. The
 *  source notes are the ones this reader may read (the store; one read for a
 *  note held without its text); an embed whose note cannot be read now stays
 *  as written. Other embeds are not touched. Publishing does the same for
 *  excerpts only, at publish time (backend publishing/excerptEmbeds.ts). */
export function expandExcerpts(snapshot: NoteExportSnapshot, wanted: ReturnType<typeof embedMatches>): Promise<NoteExportSnapshot> {
  const nodes = getAppState().data.nodes;
  const bodies = new Map<string, { markdown: string; anchors: AnchorSpan[]; id?: string }>();
  return Promise.all(wanted.map(async (m) => {
    if (m.blockId) {
      const embed = resolveEmbed(m.body, { id: snapshot.id }, nodes);
      if (embed.kind !== "block") return;
      const source = await embedSource(embed.node);
      if (source.ok) bodies.set(m.body, { markdown: source.markdown, anchors: anchorSpansOf(embed.node.id, source.markdown) });
      return;
    }
    // A part link: read the way the app reads it (its binding first, then its words); the part is the excerpt when its block is one.
    const read = readPartLink(m.target, { nodes, from: { id: snapshot.id } });
    if (read.kind !== "part" && read.kind !== "maybe") return;
    const node = nodes.find((n) => n.id === read.part.noteId);
    if (!node) return;
    const source = await embedSource(node);
    if (!source.ok) return;
    const anchors = anchorSpansOf(node.id, source.markdown);
    // A link typed by hand has no anchor: the part it was read to be stands in for one.
    bodies.set(m.body, read.anchorId
      ? { markdown: source.markdown, anchors, id: read.anchorId }
      : { markdown: source.markdown, anchors: [...anchors, { id: "part", from: read.part.from, to: read.part.to }], id: "part" });
  })).then(() => ({ ...snapshot, markdown: expandExcerptEmbeds(snapshot.markdown, (m) => bodies.get(m.body) ?? null, untitledTitle()) }));
}
