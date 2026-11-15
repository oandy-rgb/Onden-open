// Each source's article prefix (@onden/markdown articlePrefix: the path its own articles share), read from its newest
// articles. A link inside an article under it is another article of the same source, which the reader opens in place
// (links.ts, routes.ts GET /items/:id/link); anything else opens in the browser.

import { articlePrefix } from "@onden/markdown";
import { sql } from "kysely";
import { db } from "../../dbKysely.js";

/** How many of a source's newest article URLs the prefix is read from. */
const PREFIX_SAMPLE = 200;

/** articlePrefix per source, from its newest article URLs. */
export async function articlePrefixes(workspaceId: string, sourceIds: readonly string[]): Promise<Map<string, string | null>> {
  if (sourceIds.length === 0) return new Map();
  const rows = (await sql<{ subscription_id: string; urls: string[] }>`
    SELECT s.id::text AS subscription_id,
           ARRAY(SELECT st.url FROM rss_staging st
                  WHERE st.workspace_id = ${workspaceId} AND st.subscription_id = s.id AND st.url IS NOT NULL
                  ORDER BY st.fetched_at DESC LIMIT ${PREFIX_SAMPLE}) AS urls
      FROM unnest(${sourceIds}::uuid[]) AS s(id)`.execute(db)).rows;
  return new Map(rows.map((r) => [r.subscription_id, articlePrefix(r.urls)]));
}
