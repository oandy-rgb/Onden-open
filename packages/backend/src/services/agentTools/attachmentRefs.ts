import { embedMatches, isMediaId, mediaRefs, mediaTypeOf, mediaUrl, type MediaFileKind } from "@onden/markdown";
import { mediaFiles } from "../mediaFiles.js";

// The files one note's body shows or links, as an agent sees them: the media
// ids its markdown references (`![](/api/media/<id>)`, `[x](/api/media/<id>)`,
// `![[<id>]]`). getNode lists them; getAttachment serves only these — a note
// body is the only thing that makes a file reachable through a note, so an
// agent cannot ask for a media id the note does not carry.

export type NoteAttachment = {
  /** The reference as the body writes it (`/api/media/<id>`): pass it to getAttachment. */
  ref: string;
  kind: MediaFileKind | "unknown";
  mime: string;
  /** Bytes on disk; null when the file is missing. */
  size: number | null;
};

/** Distinct media ids `markdown` references, first-seen order. An `![[id.png]]`
 *  embed counts only when its target is itself a media id of an allowed type —
 *  a note embed `![[Some note]]` names no file. */
export function bodyMediaIds(markdown: string): string[] {
  const ids = new Set(mediaRefs(markdown));
  for (const embed of embedMatches(markdown)) {
    if (isMediaId(embed.target) && mediaTypeOf(embed.target)) ids.add(embed.target);
  }
  return [...ids];
}

/** The media id a caller's `ref` names — a URL or path (query/fragment ignored),
 *  an `![[…]]`/`![](…)` as written, or a bare id — or null when it names none. */
export function refToMediaId(ref: string): string | null {
  const text = ref.trim();
  const inUrl = mediaRefs(text);
  if (inUrl.length > 0) return inUrl[0]!;
  const embed = embedMatches(text)[0];
  const bare = (embed ? embed.target : text.replace(/^!?\[[^\]]*\]\(|\)$/g, "")).split(/[?#]/, 1)[0]!.trim();
  return isMediaId(bare) ? bare : null;
}

export async function mediaSize(id: string): Promise<number | null> {
  return (await mediaFiles().info(id))?.size ?? null;
}

export async function describeAttachment(id: string): Promise<NoteAttachment> {
  const type = mediaTypeOf(id);
  return { ref: mediaUrl(id), kind: type?.kind ?? "unknown", mime: type?.mime ?? "application/octet-stream", size: await mediaSize(id) };
}
