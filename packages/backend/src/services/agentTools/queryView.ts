import { z } from "zod";
import { q } from "../../db.js";
import { executeTagView } from "../tagViews.js";
import { VIEW_PAGE } from "../collectionViewQuery.js";
import type { AgentTool } from "./types.js";
import { liveNodeSql, tagNodeSql } from "../../spine/nodeSql.js";

// The same answer as GET /api/tags/:tagId/views/:viewId/exec, from the same function (services/tagViews.ts
// executeTagView): rows bounded by what the caller may read, and whatever that function decides about who may see
// the view at all. The tool used to run its own copy of that query; the two answered alike only as long as nobody
// changed one of them.

const Args = z.object({
  viewId: z.string().uuid(),
  limit: z.number().int().min(1).max(200).optional(),
});

type QueryViewResult = {
  view: {
    id: string;
    tagId: string;
    layout: string;
    visibleFields: string[];
    groupBy: string | null;
  };
  rows: Array<{
    id: string;
    title: string;
    slug: string;
    updated_at: string;
    attributes: Record<string, string | null>;
  }>;
  count: number;
};

export const queryView: AgentTool<z.infer<typeof Args>, QueryViewResult> = {
  name: "queryView",
  access: "read",
  description:
    "Execute a saved CollectionView by id. Returns the filtered + sorted rows " +
    "you can read.",
  inputSchema: Args,
  async handler(args, { actor, workspaceId }) {
    // A saved view is a function reference of its tag (functionRefs, B2). The agent passes only the view id, so
    // find which tag holds it (view ids are app-unique): the id alone, nothing of the view is read here.
    const holder = await q<{ tag_id: string }>(
      `SELECT n.id AS tag_id
         FROM function_refs r JOIN content_nodes n ON n.id = r.holder_node_id
        WHERE n.workspace_id = $1 AND ${tagNodeSql("n")} AND ${liveNodeSql("n")} AND r.instance = $2
        LIMIT 1`,
      [workspaceId, args.viewId],
    );
    const tagId = holder.rows[0]?.tag_id;
    // A view that does not exist and one the view function withholds answer alike.
    const result = tagId
      ? await executeTagView(actor, workspaceId, tagId, args.viewId, { limit: args.limit ?? VIEW_PAGE.default, offset: 0 })
      : null;
    if (!tagId || !result) throw new Error(`view not found: ${args.viewId}`);
    return {
      view: {
        id: args.viewId,
        tagId,
        layout: result.view.layout,
        visibleFields: result.view.visible_fields ?? [],
        groupBy: result.view.group_by,
      },
      rows: result.rows,
      count: result.rows.length,
    };
  },
};
