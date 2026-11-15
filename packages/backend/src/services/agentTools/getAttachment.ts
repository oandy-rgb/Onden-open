import sharp from "sharp";
import { z } from "zod";
import { MEDIA_TYPES, mediaTypeOf, cutToUnits } from "@onden/markdown";
import { pool } from "../../db.js";
import { readableScopeSql } from "../readPolicy.js";
import { canReadMedia } from "../mediaAccess.js";
import { mediaFiles } from "../mediaFiles.js";
import { bodyMediaIds, mediaSize, refToMediaId, type NoteAttachment } from "./attachmentRefs.js";
import type { AgentTool } from "./types.js";

// Fetch one file a note's body references (a phone screenshot pasted into a
// bug note, say). Two gates, both must pass:
//   1. the caller reads the note — the same readableScopeSql as getNode, so a
//      note it cannot read resolves to null, indistinguishable from not-found;
//   2. the note's own body references the file (attachmentRefs.bodyMediaIds),
//      and canReadMedia agrees — a file owned by another, unreadable note does
//      not become readable by pasting its URL into a readable one.
// Nothing else names a file: no media-id lookup outside a note.

/** Largest file returned inline (base64). An image above it is downscaled when
 *  it can be; anything still above it answers `too_large` with its metadata. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const DOWNSCALE_EDGE = 1600;
// Formats a model can read as an image block. Others (avif) are converted;
// svg/ico get metadata only.
const DIRECT_IMAGE_MIMES = new Set([".jpg", ".png", ".gif", ".webp"].map((ext) => MEDIA_TYPES[ext]!.mime));
const RESIZABLE_MIMES = new Set([...DIRECT_IMAGE_MIMES, MEDIA_TYPES[".avif"]!.mime]);

const Args = z.object({
  nodeId: z.string().uuid(),
  ref: z.string().min(1).max(2000).describe(
    "A media reference as it appears in the note's markdown: /api/media/<id> (any origin), " +
    "![[<id>]], or the bare id. getNode's `attachments[].ref` lists them.",
  ),
});

type Meta = Pick<NoteAttachment, "kind" | "mime" | "size"> & { name: string; ref: string };

export type GetAttachmentResult =
  | null // node unreadable or absent — same as getNode
  | (Meta & { error: "not_referenced" | "not_found" | "too_large" | "unsupported_image"; max_bytes?: number })
  | (Meta & { data_base64?: string; downscaled?: boolean });

export const getAttachment: AgentTool<z.infer<typeof Args>, GetAttachmentResult> = {
  name: "getAttachment",
  access: "read",
  description:
    "Fetch a file (e.g. a screenshot) that a note's body references, by nodeId + ref. Images come back as " +
    "an image you can see (over MCP) or base64 (REST); other files return metadata only. " +
    "Returns null if the note is not found or not readable. Errors: not_referenced (the note's body " +
    "does not reference that file), not_found (file missing), too_large (over 5 MB and not shrinkable). " +
    "Use getNode to see a note's attachments.",
  inputSchema: Args,
  async handler({ nodeId, ref }, { workspaceId, actor }) {
    const params: unknown[] = [workspaceId, nodeId];
    const scope = readableScopeSql(actor, "n", params);
    const node = (await pool.query<{ markdown: string | null }>(
      `SELECT n.markdown FROM content_nodes n
        WHERE n.workspace_id = $1 AND n.id = $2 AND ${scope}`,
      params,
    )).rows[0];
    if (!node) return null;

    const id = refToMediaId(ref);
    const type = id ? mediaTypeOf(id) : null;
    const meta: Meta = {
      name: id ?? cutToUnits(ref, 200),
      ref: id ? `/api/media/${id}` : cutToUnits(ref, 200),
      kind: type?.kind ?? "unknown",
      mime: type?.mime ?? "application/octet-stream",
      size: null,
    };
    if (!id || !bodyMediaIds(node.markdown ?? "").includes(id)) return { ...meta, error: "not_referenced" };
    // The file's owner decides, not the note that happens to cite it.
    if (!(await canReadMedia(actor, id, workspaceId))) return { ...meta, error: "not_referenced" };
    const size = await mediaSize(id);
    if (size === null) return { ...meta, error: "not_found" };
    meta.size = size;

    // Only images are returned inline; the rest is metadata the agent can quote.
    if (type?.kind !== "image") return meta;
    if (!RESIZABLE_MIMES.has(type.mime)) return { ...meta, error: "unsupported_image" };

    let bytes: Buffer = (await mediaFiles().read(id)) ?? Buffer.alloc(0);
    let mime = type.mime;
    let downscaled = false;
    if (bytes.length > ATTACHMENT_MAX_BYTES || !DIRECT_IMAGE_MIMES.has(mime)) {
      // sharp is already the backend's image dependency (storeMedia). A copy
      // that fails to decode or stays over the cap is reported, not returned.
      try {
        bytes = Buffer.from(await sharp(bytes).rotate()
          .resize(DOWNSCALE_EDGE, DOWNSCALE_EDGE, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 80 }).toBuffer());
        mime = "image/webp";
        downscaled = true;
      } catch {
        return { ...meta, error: size > ATTACHMENT_MAX_BYTES ? "too_large" : "unsupported_image", max_bytes: ATTACHMENT_MAX_BYTES };
      }
      if (bytes.length > ATTACHMENT_MAX_BYTES) return { ...meta, error: "too_large", max_bytes: ATTACHMENT_MAX_BYTES };
    }
    return { ...meta, mime, ...(downscaled ? { downscaled } : {}), data_base64: bytes.toString("base64") };
  },
  // Over MCP an image is an image block, not a base64 string inside JSON text.
  mcpContent(result) {
    if (!result) return [{ type: "text", text: "null" }];
    const { data_base64, ...info } = result as Meta & { data_base64?: string };
    const blocks: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text", text: JSON.stringify(info, null, 2) },
    ];
    if (data_base64) blocks.push({ type: "image", data: data_base64, mimeType: info.mime });
    return blocks;
  },
};
