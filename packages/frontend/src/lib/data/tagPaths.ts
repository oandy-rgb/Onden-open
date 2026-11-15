import { normalizeText } from "@onden/markdown";
import { api, type Tag } from "../api";
import { setData } from "../appStore";
import { isServerUnreachable } from "./writeErrors";
import { sendWrite } from "./onlineWrite";
import { ancestorsOf, indexById } from "../treeWalk";

// Tag paths ("meeting", "ttrpg/character") → class_tag ids for a note being
// created, without letting a lost connection silently strip the tags.
//
// POST /api/tags/resolve-path is find-or-create and has no client-minted id,
// so it cannot be queued like the other writes: the note's membership needs
// the id it returns. Online it stays the authority (the local catalog may be
// stale). When it cannot be reached, most paths still name a tag that already
// exists, and the store holds the whole tag catalog (with parent_id), so the
// FIND half is done locally, exactly as the server does it (segment title
// under the previous segment's id). Those ids ride in the note's own create
// request, which the note writer queues offline and replays in order (a tag
// created offline via tagWriter.create is queued ahead of the note, so its id
// is valid at replay). A path that needs a NEW tag cannot be resolved offline:
// it comes back `unresolved`, and the caller keeps it in the note as `#path`
// text and names it, never drops it.
//
// A tag the server CREATED is not in the local catalog yet, so it would be
// missing from 標籤 › 我的標籤 until a reload; the catalog is refetched then.

type TagRow = Pick<Tag, "id" | "name" | "parent_id">;

/** The id of the existing tag at `path`, from the local catalog, or null.
 *  The server's written-name rule (services/tagHierarchy.ts
 *  tagIdForWrittenName, D63): in NFC (D58), segments split on `/` and
 *  trimmed, empty ones dropped, walked from the root (a bare name is a root
 *  tag); under the previous segment, the tag titled exactly so (in either
 *  Unicode form), else the ONE whose title matches case-insensitively.
 *  fixtures/writtenTagNameParity.json holds both ends to it. */
export function findTagIdByPath(tags: readonly TagRow[] | undefined, path: string): string | null {
  const segments = normalizeText(path).split("/").map((s) => s.trim()).filter(Boolean);
  if (!segments.length || !tags?.length) return null;
  let parentId: string | null = null;
  for (const segment of segments) {
    const folded = segment.toLowerCase();
    const siblings = tags.filter((tag) => (tag.parent_id ?? null) === parentId && normalizeText(tag.name).toLowerCase() === folded);
    const hit: TagRow | undefined = siblings.find((tag) => normalizeText(tag.name) === segment) ?? (siblings.length === 1 ? siblings[0] : undefined);
    if (!hit) return null;
    parentId = hit.id;
  }
  return parentId;
}

/** The path of tag `tagId` ("ttrpg/character"), the inverse of
 *  findTagIdByPath: segment titles from the root down. Stops at a parent
 *  missing from `tags` (or a cycle), so it never throws; "" for an unknown id. */
export function tagPath(tags: readonly TagRow[], tagId: string): string {
  const byId = indexById(tags);
  const tag = byId.get(tagId);
  return tag ? [...ancestorsOf(byId, tag), tag].map((row) => row.name).join("/") : "";
}

export type ResolvedTagPaths = {
  resolved: Array<{ path: string; id: string }>;
  /** Paths that could not become a tag id now (offline, or refused). */
  unresolved: string[];
};

/** Resolve tag paths for a note: the server's find-or-create while online,
 *  else (offline, or the server unreachable: writeErrors.isServerUnreachable)
 *  the local catalog. A path the server answered with an error for (a refusal,
 *  a 500, a 429) stays unresolved: substituting a local id would only get the
 *  note's own create refused for it. Never throws. */
export async function resolveTagPaths(
  paths: readonly string[],
  { tags, online }: { tags: readonly TagRow[] | undefined; online: boolean },
): Promise<ResolvedTagPaths> {
  const result: ResolvedTagPaths = { resolved: [], unresolved: [] };
  let created = false;
  for (const path of paths) {
    let id: string | null = null;
    let unreachable = !online;
    if (online) {
      try {
        // Creates the missing tags of the path: an online write with a key.
        // Not the online operation — capture resolves paths with writes
        // still queued, and falls back to the local catalog when offline.
        const res = await sendWrite<{ leaf_id: string; created_ids?: string[] }>("POST", "/api/tags/resolve-path", { path });
        id = res.leaf_id;
        if (res.created_ids?.length) created = true;
      } catch (error) {
        unreachable = isServerUnreachable(error);
      }
    }
    if (!id && unreachable) id = findTagIdByPath(tags, path);
    if (id) result.resolved.push({ path, id });
    else result.unresolved.push(path);
  }
  if (created) await refreshTagCatalog();
  return result;
}

/** Refetch the tag catalog into the store. Best effort: on failure the new
 *  tags arrive with the next bootstrap. */
async function refreshTagCatalog(): Promise<void> {
  try {
    const catalog = await api<Tag[]>("/api/tags");
    setData((state) => ({ ...state, tags: catalog }));
  } catch { /* the next bootstrap brings them */ }
}
