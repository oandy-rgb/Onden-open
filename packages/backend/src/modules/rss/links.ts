// A link clicked inside an article (routes.ts GET /items/:id/link): another article of the same source opens in the
// reader instead of the browser (owner decision 2026-11-09).
//
//   1. an article the reader's feeds already hold at that address: that article, as 下一篇 would open it;
//   2. an address under the source's own prefix (sourcePrefix.ts): the page fetched once and its article extracted, as
//      「載入全文」 does, shown in the reader and kept nowhere (not a staging row, not a note);
//   3. anything else, or a page with no article to extract: the browser (the client opens it).

import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import { pageMetaFromHtml } from "../../services/pageMeta.js";
import type { ActorCtx } from "../../types.js";
import { fetchPageHtml } from "./fetch.js";
import { extractArticleHtml } from "./sanitize.js";
import { listSources } from "./sources.js";
import { withinPrefix } from "@onden/markdown";
import { articlePrefixes } from "./sourcePrefix.js";

export type LinkAnswer =
  | { kind: "item"; id: string }
  | { kind: "page"; url: string; title: string; body: string }
  | { kind: "outside" }
  | { kind: "failed" };

/** What the reader does with `url`, a link inside the article of `subscriptionId`. */
export async function answerArticleLink(actor: ActorCtx, workspaceId: string, subscriptionId: string, url: string): Promise<LinkAnswer> {
  let address: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { kind: "outside" };
    u.hash = "";
    address = u.href;
  } catch { return { kind: "outside" }; }

  const readable = (await listSources(actor, workspaceId)).map((s) => s.id);
  if (readable.length > 0) {
    const held = (await sql<{ id: string }>`
      SELECT id::text FROM rss_staging
       WHERE workspace_id = ${workspaceId} AND subscription_id = ANY(${readable}::uuid[]) AND tombstoned_at IS NULL
         AND url = ANY(${[address, address.endsWith("/") ? address.slice(0, -1) : `${address}/`]}::text[])
       ORDER BY fetched_at DESC LIMIT 1`.execute(db)).rows[0];
    if (held) return { kind: "item", id: held.id };
  }

  if (!withinPrefix(address, (await articlePrefixes(workspaceId, [subscriptionId])).get(subscriptionId) ?? null)) return { kind: "outside" };
  try {
    const html = await fetchPageHtml(address);
    const title = pageMetaFromHtml(html, address).title;
    const body = extractArticleHtml(html, address, { title });
    if (!body.trim()) return { kind: "failed" };
    return { kind: "page", url: address, title, body };
  } catch {
    return { kind: "failed" };
  }
}
