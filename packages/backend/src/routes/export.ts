// GET /api/export/markdown.zip — the workspace as a Markdown archive. The
// archive is built in services/exportZip.ts (frontmatter, link and media
// rewriting, the read and media gates); this route streams it.

import { attachmentHeaders } from "../downloadHeaders.js";
import { Hono } from "hono";
import { Readable } from "node:stream";
import { getWorkspaceId } from "../services/workspaceId.js";
import type { ActorCtx } from "../types.js";
import { buildMarkdownExport } from "../services/exportZip.js";

export { rewriteMediaLinks, exportedNoteFile } from "../services/exportZip.js";

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

router.get("/markdown.zip", async (c) => {
  const workspaceId = await getWorkspaceId();
  // `?lang=en` names the standalone task list Tasks/Tasks.md (default 任務/任務.md).
  const lang = c.req.query("lang") === "en" ? "en" : "zh-TW";
  const archive = await buildMarkdownExport(c.get("actor") ?? null, workspaceId, { lang });
  return c.body(Readable.toWeb(archive) as ReadableStream, 200, {
    ...attachmentHeaders("onden-export.zip", "application/zip"),
  });
});

export default router;
