// Web bookmark — POST a URL, get a node back.
//
// The point is the lowest-friction "save this link for later" capture:
// one click, one URL, the system fetches the page once and pulls out
// title / description / og:image so the resulting node is informative
// before the user touches it.
//
// Why not a full reader / archiver (Karakeep, Omnivore): scope. v1
// captures metadata, stores the URL on a `bookmark_url` attribute so
// future renderers can branch on its presence (same pattern as
// pdf_url, sketch_data), and leaves "render the actual article body"
// to a later iteration that could use Readability / Mercury.
//
// Why server-side fetch: client-side fetch is blocked by CORS for
// most sites. The backend has no such restriction. We do not follow
// redirects past 5 and time out at 8s to keep this from being a DoS
// surface.
//
// The fetch and the HTML parsing live in services/pageMeta.ts.

import { requireActor } from "../spine/mutate.js";
import { assertMayReachOut } from "../spine/authority.js";
import { newNoteSpace } from "../services/spaces.js";
import { bookmarkMarkdown, oneLine } from "../services/bookmarkMarkdown.js";
import { fetchPageMeta } from "../services/pageMeta.js";
import { isHttpUrl } from "@onden/markdown";
import { Hono } from "hono";
import { z } from "zod";
import { getWorkspaceId } from "../services/workspaceId.js";
import { type ActorCtx } from "../types.js";
import { createNote } from "../services/noteCreate.js";
import { recordAttributeChange } from "../services/attributeChange.js";
import { PERSON_SOURCE } from "../spine/attributeSource.js";
import { parseBody, readJsonBody } from "./params.js";
import { StatusError } from "../statusError.js";

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

const urlBody = z.object({ url: z.string().url().refine(isHttpUrl, "http(s) only") });

// POST /api/bookmark/preview — the page's title only, creating nothing: quick
// capture's 「分享 → Onden」 puts it above a shared link (frontend
// lib/share/shareInbox.ts). A POST so the URL stays out of access logs.
router.post("/preview", async (c) => {
  const actor = requireActor(c.get("actor"));
  assertMayReachOut(actor);
  const parsed = urlBody.safeParse(await readJsonBody(c));
  if (!parsed.success) throw new StatusError(400, "invalid_url");
  const meta = await fetchPageMeta(parsed.data.url, "");
  return c.json({ title: meta?.title || null });
});

router.post("/", async (c) => {
  const actor = requireActor(c.get("actor"));
  const workspaceId = await getWorkspaceId();
  const { url, space_id } = await parseBody(c, z.object({ url: z.string().url(), space_id: z.string().uuid().optional() }));
  // Authority before the page is fetched (createNote asks it again, under its lock): who may not write there makes no request leave.
  assertMayReachOut(actor);
  await newNoteSpace(actor, workspaceId, { spaceId: space_id ?? null });

  const meta = await fetchPageMeta(url, new URL(url).hostname);
  const title = oneLine(meta?.title ?? "") || new URL(url).hostname;
  const description = meta?.description ?? "";
  const imageUrl = meta?.imageUrl ?? null;

  const markdown = bookmarkMarkdown({ title, description, imageUrl, url });

  // services/noteCreate.ts: the creator's space, backup and embedding like
  // any note. Mirror the pdf_url / sketch_data pattern: `bookmark_url` is the
  // branching marker for renderers that treat bookmark nodes specially.
  const { node } = await createNote({
    actor, workspaceId, title, markdown, spaceId: space_id,
    event: { type: "BOOKMARK_CREATED", uiContext: "bookmark.create", payload: { url } },
    within: async ({ nodeId }) => {
      await recordAttributeChange({
        workspaceId, nodeId, key: "bookmark_url", actor,
        next: { value: url, source: PERSON_SOURCE }, rule: "always",
        authority: { kind: "cascade" }, uiContext: "bookmark.create",
      });
    },
  });
  const id = node.id as string;
  return c.json({ id, title, url }, 201);
});

export default router;
