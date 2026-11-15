// What a Markdown export leaves out on purpose, said in plain words in one
// text file inside the archive (nothing is written when nothing was left out).
// A vault of .md files cannot carry the trash, where cards sit on a whiteboard
// and how they are connected, or a tag's fields and colour (a drawing travels
// as pictures: exportInk.ts); the full backup (services/backupArchive.ts) carries them.

import { pool } from "../db.js";
import type { ActorCtx } from "../types.js";
import type { ArchiveSink } from "./archiveStream.js";
import { readableScopeSql } from "./readPolicy.js";
import { spaceScopeSql } from "../spine/spaceScope.js";
import { whiteboardNoteSql, whiteboardShownSql } from "./boardStore.js";
import { taskHostLiveSql } from "../spine/taskIdentity.js";
import type { TaskListLang } from "./taskListFile.js";
import { liveNodeSql, liveTagNodeSql } from "../spine/nodeSql.js";

export type LeftOut = { trashed: number; canvases: number; tagsWithSettings: number };

export const LEFT_OUT_FILE: Record<TaskListLang, string> = { "zh-TW": "未匯出的內容.txt", en: "left-out.txt" };

/** How many notes in the trash, whiteboards (a note's whiteboard tab) and tags with fields or a colour
 *  `actor` can read that the Markdown export does not carry. */
export async function readLeftOut(actor: ActorCtx | null, workspaceId: string): Promise<LeftOut> {
  const params: unknown[] = [workspaceId];
  const live = readableScopeSql(actor, "cn", params);
  const retained = spaceScopeSql(actor, "cn", params);
  const { rows } = await pool.query<{ trashed: string; canvases: string; tags: string }>(
    `SELECT count(*) FILTER (WHERE cn.node_type = 'content' AND cn.hidden = false
                              AND (cn.deleted_at IS NOT NULL OR NOT ${taskHostLiveSql("cn")}) AND ${retained}
                              AND NOT (${live})) AS trashed,
            count(*) FILTER (WHERE cn.node_type IN ('content', 'canvas') AND ${liveNodeSql("cn")} AND ${live}
                              AND ${whiteboardNoteSql("cn")} AND ${whiteboardShownSql("cn")}) AS canvases,
            count(*) FILTER (WHERE ${liveTagNodeSql("cn")} AND ${live}
                              AND (cn.tag_color IS NOT NULL
                                   OR (jsonb_typeof(cn.tag_schema->'fields') = 'array' AND jsonb_array_length(cn.tag_schema->'fields') > 0)
                                   OR COALESCE(cn.tag_schema->>'description', '') <> '')) AS tags
       FROM content_nodes cn WHERE cn.workspace_id = $1`,
    params,
  );
  const row = rows[0]!;
  return { trashed: Number(row.trashed), canvases: Number(row.canvases), tagsWithSettings: Number(row.tags) };
}

const WORDS: Record<TaskListLang, { title: string; trashed: (n: number) => string; canvases: (n: number) => string; tags: (n: number) => string; hint: string }> = {
  "zh-TW": {
    title: "這份匯出沒有包含下列內容：",
    trashed: (n) => `垃圾桶裡的筆記：${n} 篇`,
    canvases: (n) => `白板上的卡片位置與連線：${n} 張白板`,
    tags: (n) => `標籤的欄位、說明與顏色：${n} 個標籤`,
    hint: "想把這些一起帶走，請改用「完整備份」。",
  },
  en: {
    title: "This export does not include:",
    trashed: (n) => `Notes in the trash: ${n}`,
    canvases: (n) => `Card positions and connections on whiteboards: ${n} whiteboard${n === 1 ? "" : "s"}`,
    tags: (n) => `Tag fields, descriptions and colours: ${n} tag${n === 1 ? "" : "s"}`,
    hint: "To take these along, use the full backup instead.",
  },
};

/** The report's text, or null when nothing was left out. */
export function leftOutText(left: LeftOut, lang: TaskListLang): string | null {
  const words = WORDS[lang];
  const lines = [
    left.trashed > 0 ? words.trashed(left.trashed) : null,
    left.canvases > 0 ? words.canvases(left.canvases) : null,
    left.tagsWithSettings > 0 ? words.tags(left.tagsWithSettings) : null,
  ].filter((line): line is string => line !== null);
  return lines.length === 0 ? null : `${words.title}\n${lines.map((line) => `- ${line}`).join("\n")}\n\n${words.hint}\n`;
}

export async function writeLeftOutReport(out: ArchiveSink, actor: ActorCtx | null, workspaceId: string, lang: TaskListLang): Promise<void> {
  const text = leftOutText(await readLeftOut(actor, workspaceId), lang);
  if (text !== null) await out.addText(LEFT_OUT_FILE[lang], text);
}
