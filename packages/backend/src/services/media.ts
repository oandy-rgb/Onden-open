// Storing a media file: the one path from received bytes to a served
// `/api/media/<id>` (the address grammar is @onden/markdown mediaRefs.ts).
// The upload route (routes/media.ts) and the vault image import
// (modules/importers/shared/images.ts) both store through `storeMedia`, so a file is
// validated, sanitised, written and recorded the same way whichever door it
// came in by. Reading a file back is services/mediaAccess.ts (canReadMedia);
// where files live and what may be stored is services/mediaStore.ts.

import { sha256Hex } from "../utils.js";
import type { Readable } from "node:stream";
import { mediaUrl } from "@onden/markdown";
import { q } from "../db.js";
import { log } from "../logger.js";
import { afterCommit } from "../spine/txHooks.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import type { ActorCtx } from "../types.js";
import { canReadMedia } from "./mediaAccess.js";
import { mediaOwnerSpace } from "./mediaOwners.js";
import { MIME, capFor, opaqueMediaName } from "./mediaStore.js";
import { mediaFiles } from "./mediaFiles.js";
import { imageCodec } from "./imageCodec.js";
import { sanitizeSvg, hasXmlDeclarations } from "./svgSanitize.js";

/** Why a file was not stored. unsupported: the extension is not on the
 *  allowlist (mediaStore.MIME); too_large: over capFor(ext); unreadable:
 *  empty, or the bytes are not the format the extension names. */
export type MediaRefusal = "unsupported" | "too_large" | "unreadable";

export type StoredMedia = {
  /** The media id, `<32 hex>.<ext>`. */
  filename: string;
  /** Where the file is served: `/api/media/<filename>`. */
  url: string;
  /** An import of bytes this actor already imported: the earlier file's
   *  address is handed back instead of a new one. */
  reused: boolean;
};

export type StoreMediaResult = ({ ok: true } & StoredMedia) | { ok: false; reason: MediaRefusal };

/**
 * Validate `bytes` as a file of type `ext` (".png", ".pdf", … any case),
 * store it under a new opaque id and record who stored it.
 *
 * Validation, the same for every origin: the extension must be on the
 * allowlist and the bytes within its cap; an SVG is sanitised; images, PDFs
 * and office documents must be what their extension says (decoded by sharp /
 * file signature) — except an upload to a re-encoded raster extension
 * (.jpg/.jpeg/.png/.webp/.avif), which may be any raster image sharp decodes;
 * an .ico must carry the icon header. Audio, video, .ico, .eml and .txt are
 * stored as given — they are
 * served with their allowlisted type and `nosniff`. A refused file returns
 * `{ ok: false, reason }`; disk and DB errors propagate.
 *
 * The bytes go through services/mediaFiles.ts (all-or-nothing and durable
 * before it returns: on disk a temporary sibling is synced and renamed into
 * place, so a reader never sees a partial file). Then the store is recorded:
 *  - origin "upload": raster images are re-encoded to WebP (max 2400px wide; the browser app's
 *    codec writes JPEG/PNG where its canvas cannot write WebP, and the id carries the extension written);
 *    media_uploads records the uploader, who alone may preview the file until
 *    a note references it (canReadMedia, mediaOwners.ts). This row is file
 *    bookkeeping, not domain state: no event, outside any transaction.
 *  - origin "import": bytes are kept; imported_media indexes them by
 *    workspace, actor, sanitised content and extension. The same bytes again
 *    reuse the earlier file while `actor` can still read it and the note
 *    that owns it (mediaOwners.mediaOwnerSpace) is in `spaceId`, the space
 *    the import's notes land in, or no note owns it yet (a missing or
 *    damaged copy is rewritten from these bytes); otherwise a new id is
 *    minted. The owning note decides who reads a file, so a copy owned in
 *    another space would hide the image from the new note's readers (D107).
 *    Lookup and write run under the workspace event lock.
 *
 * Authorisation is the caller's: both callers require that `actor` may write
 * in some space (routes/media.ts per upload, prepareImportedImages per batch).
 * A DB failure after the write can leave an unreferenced file; it is not
 * deleted, since after an uncertain COMMIT it may belong to a retry.
 */
export async function storeMedia(
  bytes: Buffer,
  ext: string,
  options: {
    actor: ActorCtx; workspaceId: string; origin: "upload" | "import";
    /** Import only: the space the importing notes land in (null: unknown, so
     *  a copy some note already owns is never reused). */
    spaceId?: string | null;
  },
): Promise<StoreMediaResult> {
  const checked = await validateMedia(bytes, ext.toLowerCase(), options.origin);
  if (!checked.ok) return checked;
  const { actor, workspaceId } = options;

  if (options.origin === "upload") {
    const optimized = OPTIMIZE_EXTS.has(checked.ext) ? await imageCodec().reencode(checked.bytes, UPLOAD_MAX_WIDTH) : null;
    const filename = opaqueMediaName(optimized?.ext ?? checked.ext);
    await mediaFiles().write(filename, optimized?.bytes ?? checked.bytes);
    await q(
      `INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id) VALUES ($1, $2, $3)
       ON CONFLICT (filename) DO NOTHING`,
      [filename, workspaceId, actor.id],
    );
    return { ok: true, filename, url: mediaUrl(filename), reused: false };
  }

  const hash = sha256Hex(checked.bytes);
  return withEventTransaction(workspaceId, async () => {
    const params = [workspaceId, actor.id, hash, checked.ext];
    const existing = (await q<{ filename: string }>(`SELECT filename FROM imported_media
      WHERE workspace_id=$1 AND actor_id=$2 AND content_hash=$3 AND extension=$4`, params)).rows[0];
    const ownerSpace = existing ? await mediaOwnerSpace(workspaceId, existing.filename) : undefined;
    const sameSpace = ownerSpace === undefined || (ownerSpace !== null && ownerSpace === options.spaceId);
    if (existing && sameSpace && await canReadMedia(actor, existing.filename, workspaceId)) {
      let previous: Buffer | null;
      previous = await mediaFiles().read(existing.filename);
      // Recover missing/damaged bytes from the exact same sanitized content.
      // No fallback to an arbitrary file with the same original basename.
      if (!previous?.equals(checked.bytes)) await mediaFiles().write(existing.filename, checked.bytes);
      return { ok: true as const, filename: existing.filename, url: mediaUrl(existing.filename), reused: true };
    }
    const filename = opaqueMediaName(checked.ext);
    await mediaFiles().write(filename, checked.bytes);
    await q(`INSERT INTO imported_media(workspace_id,actor_id,content_hash,extension,filename)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,actor_id,content_hash,extension)
      DO UPDATE SET filename=EXCLUDED.filename`, [...params, filename]);
    return { ok: true as const, filename, url: mediaUrl(filename), reused: false };
  });
}

/**
 * Store a file the server made itself under a name it chose (a published
 * handwriting page, modules/website/publishing/handwritingPages.ts): recorded
 * as an upload claimed by `ownerNodeId`, so the media rule
 * (mediaAccess.canReadMedia) asks that note. The name is the content's, so a
 * file already there is the same file: `render` (which may be expensive) runs
 * only when it is absent, and the write is atomic. The bytes are trusted — not
 * sniffed or sanitised like an upload's — so only server code may call this,
 * never with client bytes. Idempotent: the same name again changes nothing.
 * Joins the caller's transaction for the row; the file is written at once.
 */
export async function storeGeneratedMedia(file: {
  workspaceId: string; filename: string; render: () => string; ownerNodeId: string; uploaderActorId: string;
}): Promise<void> {
  if (!await mediaFiles().info(file.filename)) await mediaFiles().write(file.filename, Buffer.from(file.render(), "utf8"));
  await q(
    `INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id, node_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (filename) DO NOTHING`,
    [file.filename, file.workspaceId, file.uploaderActorId, file.ownerNodeId],
  );
}

/**
 * Forget stored files: their upload and import records go in the caller's
 * transaction, the bytes once it commits (a rollback must not lose a file its
 * note still has). A failed unlink leaves an unreferenced file behind, logged.
 * The caller has decided nothing references them (purgedContent.ts after a
 * purge; handwritingPages.ts for a page a newer publish replaced). The one
 * removal of media, so no path forgets the record but keeps the bytes.
 */
export async function removeMediaFiles(workspaceId: string, files: readonly string[]): Promise<void> {
  if (files.length === 0) return;
  await q(`DELETE FROM media_uploads WHERE workspace_id = $1 AND filename = ANY($2::text[])`, [workspaceId, files]);
  await q(`DELETE FROM imported_media WHERE workspace_id = $1 AND filename = ANY($2::text[])`, [workspaceId, files]);
  afterCommit(() => {
    for (const file of files) {
      mediaFiles().remove(file).catch((error: Error) => log.warn("media", `could not remove media file ${file}: ${error.message}`));
    }
  });
}

// Raster formats an upload re-encodes to WebP. GIF keeps its bytes (animation).
/** An upload is scaled down to this width (never enlarged). */
const UPLOAD_MAX_WIDTH = 2400;
const OPTIMIZE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
// What sharp must decode an image extension as.
const IMAGE_FORMATS: Record<string, string> = {
  ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp", ".svg": "svg", ".avif": "heif",
};
// Signatures for the non-image formats we can recognise reliably.
const SIGNATURES: Record<string, string> = {
  ".pdf": "%PDF-",
  // Office Open XML is a ZIP container.
  ".docx": "PK\x03\x04", ".xlsx": "PK\x03\x04", ".pptx": "PK\x03\x04",
  // An icon directory (reserved 0, type 1). sharp cannot decode .ico, so the
  // header is all that is checked before it is stored as given.
  ".ico": "\x00\x00\x01\x00",
};

type Checked = { ok: true; bytes: Buffer; ext: string } | { ok: false; reason: MediaRefusal };

// Raster formats an upload to an OPTIMIZE_EXTS extension may really be: the
// bytes are re-encoded to WebP anyway, and a browser-saved PNG named foo.jpg
// is common. HEIF must be AV1 (AVIF) — the bundled decoder has no HEVC.
const RASTER_FORMATS = new Set(["jpeg", "png", "webp", "gif", "tiff", "heif"]);

async function validateMedia(raw: Buffer, ext: string, origin: "upload" | "import"): Promise<Checked> {
  if (!MIME[ext]) return { ok: false, reason: "unsupported" };
  if (raw.length > capFor(ext)) return { ok: false, reason: "too_large" };
  if (raw.length === 0) return { ok: false, reason: "unreadable" };
  // An SVG is served as image/svg+xml, an active document: inline <script>,
  // on* handlers, <foreignObject> HTML, SMIL retargeting or external refs
  // would be stored XSS. Sanitise (svgSanitize.ts) before anything else.
  // A DOCTYPE / ENTITY declaration lets markup hide in an entity that a regex
  // sanitiser never sees; no drawing needs one, so refuse the file outright.
  if (ext === ".svg" && hasXmlDeclarations(raw.toString("utf8"))) return { ok: false, reason: "unreadable" };
  const bytes = ext === ".svg" ? Buffer.from(sanitizeSvg(raw.toString("utf8")), "utf8") : raw;
  const format = IMAGE_FORMATS[ext];
  if (format) {
    try {
      const metadata = await imageCodec().inspect(bytes);
      // An upload that will be re-encoded may be any raster format; everything
      // stored as given (import, .gif, .svg) must be the format it is named.
      const lenient = origin === "upload" && OPTIMIZE_EXTS.has(ext);
      const formatOk = lenient ? RASTER_FORMATS.has(metadata.format ?? "") : metadata.format === format;
      const av1 = metadata.format !== "heif" || metadata.compression === "av1";
      if (!formatOk || !av1) {
        return { ok: false, reason: "unreadable" };
      }
    } catch {
      return { ok: false, reason: "unreadable" }; // decoder rejection of in-memory input only
    }
  }
  const signature = SIGNATURES[ext];
  if (signature && bytes.subarray(0, signature.length).toString("latin1") !== signature) {
    return { ok: false, reason: "unreadable" };
  }
  return { ok: true, bytes, ext };
}

/**
 * Put a file from a backup back under its own media id (services/
 * backupRestore.ts): the restored notes still reference `/api/media/<id>`.
 * A file already at that id is kept as it is ("exists"; ids are random, so
 * the same id is the same upload). Otherwise the bytes are checked as an
 * import's are (validateMedia: allowlist, cap, SVG sanitised, images decoded,
 * signatures) and written atomically ("written"); a refusal names why.
 * Images (at most 50 MB) are checked in memory; other kinds — up to a 500 MB
 * video — are streamed to the temporary file and only their signature read,
 * so a large attachment never sits in memory. No database row is written:
 * the caller records the upload in its own transaction, and unlinks
 * "written" files if that transaction fails.
 */
export async function restoreMediaFile(
  filename: string, source: { stream: Readable; size: number },
): Promise<"written" | "exists" | MediaRefusal> {
  const ext = (/\.[^.]+$/.exec(filename)?.[0] ?? "").toLowerCase();
  if (!MIME[ext]) { source.stream.destroy(); return "unsupported"; }
  if (source.size > capFor(ext)) { source.stream.destroy(); return "too_large"; }
  const files = mediaFiles();
  if (await files.info(filename)) {
    source.stream.destroy();
    return "exists";
  }
  if (IMAGE_FORMATS[ext]) {
    const chunks: Buffer[] = [];
    for await (const chunk of source.stream) chunks.push(chunk as Buffer);
    const checked = await validateMedia(Buffer.concat(chunks), ext, "import");
    if (!checked.ok) return checked.reason;
    await files.write(filename, checked.bytes);
    return "written";
  }
  // Streamed through the check, never held whole: the storage keeps nothing if the stream is refused part-way
  // (too long) or at its end (empty, wrong signature).
  const signature = SIGNATURES[ext];
  const refused = new Error("refused");
  let reason: MediaRefusal = "unreadable";
  async function* checkedChunks(): AsyncGenerator<Uint8Array> {
    let head = Buffer.alloc(0);
    let written = 0;
    for await (const chunk of source.stream) {
      const bytes = chunk as Buffer;
      if (signature && head.length < signature.length) head = Buffer.concat([head, bytes.subarray(0, signature.length - head.length)]);
      written += bytes.length;
      if (written > capFor(ext)) { reason = "too_large"; throw refused; }
      yield bytes;
    }
    if (written === 0 || (signature && head.toString("latin1") !== signature)) throw refused;
  }
  try {
    await files.write(filename, checkedChunks());
  } catch (error) {
    if (error === refused) return reason;
    throw error;
  }
  return "written";
}
