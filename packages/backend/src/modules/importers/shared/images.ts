import { extname } from "node:path";
import { MEDIA_URL_PREFIX, mediaUrl } from "@onden/markdown";
import { q } from "../../../db.js";
import { AuthorityError, assertAuthority } from "../../../spine/authority.js";
import { capFor } from "../../../services/mediaStore.js";
import { canReadMedia } from "../../../services/mediaAccess.js";
import { storeMedia } from "../../../services/media.js";
import { newNoteSpace } from "../../../services/spaces.js";
import { importPath, importedImageLinks, isImportedMediaPath } from "./imageLinks.js";
import type { ActorCtx } from "../../../types.js";

// Which files are media: any extension on the one media table
// (importedImageLinks.ts isImportedMediaPath). A vault's ![[paper.pdf]]
// becomes a link to the stored file, ![[song.mp3]] a player.
export { isImportedMediaPath };
type File = { path: string; base64?: string };
/** The media id in a URL this module hands out: exactly `/api/media/<id>`
 *  with a minted id (`<32 hex>.<ext>`, mediaStore.opaqueMediaName) — no
 *  origin, query or older name; undefined for anything else. */
const MINTED_ID = /^[0-9a-f]{32}\.[a-z0-9]+$/;
const uploadedId = (url: string | null): string | undefined => {
  const id = url?.startsWith(MEDIA_URL_PREFIX) ? url.slice(MEDIA_URL_PREFIX.length) : undefined;
  return id && MINTED_ID.test(id) && mediaUrl(id) === url ? id : undefined;
};

/** too_large: over the media cap (routes/media.ts capFor); unreadable: not a
 * valid image of the type its extension names. */
export type ImportedImageSkipReason = "too_large" | "unreadable";

/** Accept image bytes for one upload, then rewrite each note using its own
 * source path: media.rewrite(body, "課程/note.md"). Counters reflect committed
 * files, not note completion. Same actor/workspace + sanitized bytes + format
 * reuses an opaque URL only while readable. Changed bytes never overwrite an
 * old asset. Unsupported/bad files are listed in `skippedFiles` with a reason;
 * storage/DB errors propagate. `urls` maps each image path of this request to
 * its URL (null: rejected, the path stays reserved).
 *
 * A folder import too large for one request is sent in batches (frontend
 * settings/folderImport.ts), images first. `uploaded` carries the `urls` of
 * earlier batches so a note resolves an image sent in another request exactly
 * as if both were in one: a URL is used only if this module handed it to this
 * actor (imported_media) and the actor can still read it; anything else
 * reserves the path, like a rejected image.
 * The index is internal file bookkeeping, not ownership or a domain event. */
export async function prepareImportedImages(options: {
  actor: ActorCtx; workspaceId: string; files: File[]; uploaded?: Record<string, string | null>;
}) {
  const { actor, workspaceId, files } = options;
  await assertAuthority(actor, { kind: "any_space_write" });
  // The space this import's new notes land in (noteCreate: the creator's
  // space); an earlier copy is reused only from a note in that space
  // (storeMedia, D107). A caller with no single default space (a token that
  // may write several) reuses no owned copy.
  const spaceId = await newNoteSpace(actor, workspaceId).catch((error: unknown) => {
    if (error instanceof AuthorityError) return null;
    throw error;
  });
  const urls = new Map<string, string | null>();
  const known = new Map<string, string | null>();
  const uploaded = Object.entries(options.uploaded ?? {});
  const ownImports = new Set(uploaded.length ? (await q<{ filename: string }>(
    `SELECT filename FROM imported_media WHERE workspace_id=$1 AND actor_id=$2 AND filename = ANY($3)`,
    [workspaceId, actor.id, uploaded.map(([, url]) => uploadedId(url)).filter(Boolean)])).rows.map(row => row.filename) : []);
  for (const [rawPath, url] of uploaded) {
    const path = importPath(rawPath);
    if (!path || !isImportedMediaPath(path)) continue;
    const filename = uploadedId(url);
    known.set(path, filename && ownImports.has(filename) && await canReadMedia(actor, filename, workspaceId) ? url : null);
  }
  let imported = 0, reused = 0, pdfs = 0;
  const skippedFiles: Array<{ path: string; reason: ImportedImageSkipReason }> = [];
  const skip = (path: string, reason: ImportedImageSkipReason) => { skippedFiles.push({ path, reason }); };
  const counts = new Map<string, number>();
  for (const file of files) {
    const path = importPath(file.path);
    if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  for (const file of files) {
    const path = importPath(file.path), ext = extname(file.path).toLowerCase();
    if (path) urls.set(path, null);
    const b64 = file.base64?.replace(/\s/g, "");
    if (b64 && b64.length > Math.ceil(capFor(ext) / 3) * 4) { skip(file.path, "too_large"); continue; }
    if (!path || counts.get(path) !== 1 || !isImportedMediaPath(path) || !b64 ||
        b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) { skip(file.path, "unreadable"); continue; }
    const stored = await storeMedia(Buffer.from(b64, "base64"), ext, { actor, workspaceId, origin: "import", spaceId });
    // The media table is the upload allowlist (mediaAllowlist.test.ts), so no refusal is "unsupported".
    if (!stored.ok) { skip(path, stored.reason === "too_large" ? "too_large" : "unreadable"); continue; }
    urls.set(path, stored.url);
    if (stored.reused) reused++; else imported++;
    if (ext === ".pdf") pdfs++;
  }
  // This request's own images win over an earlier batch's entry for the same path.
  const links = importedImageLinks(new Map([...known, ...urls]));
  return { imported, reused, pdfs, skippedFiles, urls: Object.fromEntries(urls),
    rewrite: links.rewrite, get unresolvedReferences() { return links.unresolved; } };
}
