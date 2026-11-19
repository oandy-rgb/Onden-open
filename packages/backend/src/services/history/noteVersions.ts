// 單篇筆記的版本清單（GET /api/nodes/:id/versions）。
//
// 版本來自事件紀錄：每個帶 body_hash 的 NODE_CREATED／NODE_UPDATED／NODE_RESTORED 是一次儲存；
// 同一作者 5 分鐘內的連續儲存合成一列（`saves` = 合併次數）。內容沒變的儲存不算一個時間點：
// 標題與內文雜湊都和前一筆相同的事件在查詢裡併進前一筆；只差段尾 ^id、行尾空白或空行數的併進較新的一筆。
// 事件本身一個都不刪，只是顯示時併。這支檔案分兩層：
//   - 純函式（summarizeChange、describeVersions）：不碰資料庫，單元測試直接餵字串。
//   - listNoteVersions：讀取閘（canReadNode）+ SQL，再交給純函式補上 summary／markers／restored_from。
// 讀取只經 canReadNode 之後才查事件，不可讀等同不存在（回傳 null，不洩漏存在與否）。

import { replaceWikilinks, splitWikilink } from "@onden/markdown";
import { shownAuthorKind, shownAuthorName, versionAuthor } from "../authorName.js";
import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { canReadNode } from "../readPolicy.js";
import { bodyEventSql, versionActorTypeSql } from "./bodyEvents.js";
import { alignParagraphs, paragraphSample, sameTextIgnoringIds, splitParagraphs, summarizeAlignment, summarizeChange, type Alignment, type ChangeSummary } from "@onden/markdown";

/* ------------------------------------------------------------------ */
/* 段落摘要（純函式）：切分、對齊、計數都在 @onden/markdown 的 paragraphs.ts */
/* ------------------------------------------------------------------ */

/** 一處被動到的段落：新增與改寫帶新內容，刪除帶舊內容（已正規化，仍含標題／清單記號）。 */
export type TouchedSegment = {
  kind: "added" | "changed" | "removed";
  text: string;
  section: string | null;
};

const touchedOf = (alignment: readonly Alignment[]): TouchedSegment[] =>
  alignment.flatMap((row) => {
    if (row.kind === "same") return [];
    const p = row.new ?? row.old;
    return [{ kind: row.kind, text: p.norm, section: p.section }];
  });

export type { ChangeSummary };

/** 摘錄最長幾字（段落摘錄的切法在 @onden/markdown 的 paragraphSample）。 */
export const SAMPLE_MAX = 120;

type ChangeWithSample = ChangeSummary & {
  /** 第一處改動的那一段文字（見 paragraphSample）；沒有可顯示的文字時 null。 */
  sample: string | null;
  sample_kind: TouchedSegment["kind"] | null;
};

/** summarizeChange 加上第一處「有字可顯示」的改動摘錄（整個工作區歷史的每一列）。 */
export function describeChange(olderMarkdown: string, newerMarkdown: string): ChangeWithSample {
  const alignment = alignParagraphs(olderMarkdown, newerMarkdown);
  const summary = summarizeAlignment(alignment);
  for (const t of touchedOf(alignment)) {
    const sample = paragraphSample(t.text, SAMPLE_MAX);
    if (sample !== null) return { ...summary, sample, sample_kind: t.kind };
  }
  return { ...summary, sample: null, sample_kind: null };
}

/* ------------------------------------------------------------------ */
/* 標記、作者種類（純函式）                                             */
/* ------------------------------------------------------------------ */

export type ActorKind = "human" | "agent" | "system" | "session";

/** domain_events.actor_type（'user' | 'ai_agent' | 'system'）→ 前端用的作者種類。 */
export function actorKindOf(actorType: string): ActorKind {
  if (actorType === "user") return "human";
  if (actorType === "ai_agent") return "agent";
  return "system";
}

export type VersionRow = {
  id: string;
  title: string | null;
  markdown: string;
  changed_at: Date | string;
  actor_name: string | null;
  actor_type: string;
  /** `actors.type` of the author's row on this node (null: no row); only to tell a session's write (services/authorName.ts). */
  author_row_type?: string | null;
  saves: number;
  is_restore: boolean;
  /** 被還原那一版（所在那一列）的 changed_at；不是這篇的版本則 null。 */
  restored_at: Date | string | null;
};

/** `rows` 由新到舊。與下一筆較舊的列相比，文字只差段尾 `^id`、行尾空白或空行數
 *  （sameTextIgnoringIds）且標題、作者相同的，較舊的那一列併進較新的一列
 *  （`saves` 相加，較新的內文與時間代表兩者）。
 *  作者不同、還原列、以及清單裡最舊的一列（建立的基準，或只為描述上一列而多抓的那一列）都不併。 */
export function absorbSameText(rows: VersionRow[]): VersionRow[] {
  const out: VersionRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    let row = rows[i]!;
    while (i + 2 < rows.length) {
      const older = rows[i + 1]!;
      if (row.is_restore || older.is_restore || (row.title ?? "") !== (older.title ?? "")) break;
      if (row.actor_type !== older.actor_type || row.actor_name !== older.actor_name || (row.author_row_type ?? null) !== (older.author_row_type ?? null)) break;
      if (!sameTextIgnoringIds(older.markdown, row.markdown)) break;
      row = { ...row, saves: row.saves + older.saves };
      i++;
    }
    out.push(row);
  }
  return out;
}

export type PublishedSnapshot = { n: number; at: Date | string };

export type DescribedVersion = Omit<VersionRow, "is_restore" | "restored_at" | "changed_at"> & {
  changed_at: Date | string;
  actor_kind: ActorKind;
  summary: ChangeSummary;
  markers: string[];
  restored_from: string | null;
};

const iso = (d: Date | string): string => new Date(d).toISOString();

/**
 * `rows` 由新到舊；`olderMarkdownOfLast` 是最後一列再更舊的那一版內文
 * （清單被截斷時才有；null = 最後一列就是最早的一版，摘要算「建立」）。
 * `snapshots` 只含收錄了這篇的發布快照。
 *
 * 「已發布 #n」只標在快照當時的那一版（不晚於快照的最新一列），
 * 不是在它之前的每一列。
 */
export function describeVersions(
  rows: VersionRow[],
  olderMarkdownOfLast: string | null,
  snapshots: PublishedSnapshot[],
): DescribedVersion[] {
  const published = new Map<number, number[]>(); // row index → snapshot numbers
  for (const snap of snapshots) {
    const at = new Date(snap.at).getTime();
    const index = rows.findIndex((r) => new Date(r.changed_at).getTime() <= at);
    if (index < 0) continue;
    published.set(index, [...(published.get(index) ?? []), snap.n].sort((a, b) => a - b));
  }
  return rows.map((row, index) => {
    const older = index + 1 < rows.length ? rows[index + 1]!.markdown : olderMarkdownOfLast;
    const summary: ChangeSummary =
      older === null
        ? { added: splitParagraphs(row.markdown).length, changed: 0, removed: 0, sections: [] }
        : summarizeChange(older, row.markdown);
    const newer = index > 0 ? rows[index - 1]! : null;
    const markers: string[] = [];
    if (row.is_restore) markers.push("restored");
    if (newer && actorKindOf(newer.actor_type) === "agent") markers.push("before_agent");
    for (const n of published.get(index) ?? []) markers.push(`published:${n}`);
    const { is_restore: _isRestore, restored_at, author_row_type, ...rest } = row;
    return {
      ...rest,
      actor_kind: shownAuthorKind(author_row_type, actorKindOf(row.actor_type)),
      summary,
      markers,
      restored_from: row.is_restore && restored_at ? iso(restored_at) : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 資料庫                                                              */
/* ------------------------------------------------------------------ */

/** 清單最多幾列；多抓一列只為了算最後一列的摘要。 */
const VERSION_LIMIT = 50;

type RawVersion = {
  id: string;
  title: string | null;
  markdown: string;
  changed_at: Date;
  actor_name: string | null;
  actor_type: string;
};

/**
 * 這篇筆記的版本。`raw` = 未合併的儲存事件（最新 50 筆，只多一個 actor_kind）；
 * 否則是合併後的清單，附 summary／markers／restored_from。筆記對 actor 不可讀 → null。
 */
export async function listNoteVersions(
  workspaceId: string,
  actor: ActorCtx,
  nodeId: string,
  opts: { raw: boolean },
): Promise<Array<Record<string, unknown>> | null> {
  if (!(await canReadNode(actor, nodeId))) return null;
  if (opts.raw) {
    const raw = await q<Omit<RawVersion, "actor_name"> & { imported: boolean; import_name: string | null; row_name: string | null; row_type: string | null }>(
      `SELECT e.id, (e.payload->>'title') AS title, b.content AS markdown,
              e.created_at AS changed_at, (e.tx_meta ? 'history_import') AS imported, e.tx_meta->'history_import'->>'actor_name' AS import_name, a.name AS row_name, a.type AS row_type, ${versionActorTypeSql("e")} AS actor_type
         FROM domain_events e
         JOIN blobs b ON b.hash = e.payload->>'body_hash'
    LEFT JOIN actors a ON a.id::text = e.actor_id
        WHERE e.target_id = $1 AND e.workspace_id = $2
          AND ${bodyEventSql("e")}
        ORDER BY e.created_at DESC, e.id DESC LIMIT ${VERSION_LIMIT}`,
      [nodeId, workspaceId],
    );
    return raw.rows.map(({ imported, import_name, row_name, row_type, ...r }) => {
      const author = versionAuthor({ imported, import_name, row_name, row_type });
      return { ...r, actor_name: shownAuthorName(author.rowType, author.name), actor_kind: shownAuthorKind(author.rowType, actorKindOf(r.actor_type)) };
    });
  }

  const result = await q<Omit<VersionRow, "restored_at" | "actor_name" | "author_row_type"> & { restored_at: Date | null; imported: boolean; import_name: string | null; row_name: string | null; row_type: string | null }>(
    `WITH saves AS (
       SELECT e.id, e.actor_id, ${versionActorTypeSql("e")} AS actor_type, e.created_at,
              (e.payload->>'title') AS title, e.payload->>'body_hash' AS body_hash,
              e.event_type, e.tx_meta->'history_import'->>'actor_name' AS import_actor, (e.tx_meta ? 'history_import') AS imported,
              -- 還原：NODE_RESTORED（版本還原）或 eventRestore 寫的 NODE_UPDATED（tx_meta.restored_from）
              (e.event_type = 'NODE_RESTORED' OR e.tx_meta ? 'restored_from') AS is_restore,
              CASE WHEN e.event_type = 'NODE_RESTORED' THEN e.payload->>'version_id'
                   ELSE e.tx_meta->>'restored_from' END AS restored_id,
              -- 內文與標題都和前一筆相同的儲存（舊版沒變也會記）不是新的時間點
              (e.payload->>'body_hash' IS DISTINCT FROM lag(e.payload->>'body_hash') OVER w
               OR e.payload->>'title' IS DISTINCT FROM lag(e.payload->>'title') OVER w) AS keep
         FROM domain_events e
        WHERE e.target_id = $1 AND e.workspace_id = $2
          AND ${bodyEventSql("e")}
       WINDOW w AS (ORDER BY e.created_at ASC, e.id ASC)
     ),
     -- 被併掉的事件算在它前面留下的那一筆（還原指向它時，仍找得到那一列）
     anchored AS (
       SELECT *, max(CASE WHEN keep THEN id END) OVER (ORDER BY created_at ASC, id ASC) AS anchor_id FROM saves
     ),
     bodies AS (
       SELECT * FROM anchored WHERE keep
     ),
     marked AS (
       SELECT *,
              CASE WHEN lag(created_at) OVER w IS NULL
                     OR created_at - lag(created_at) OVER w > interval '5 minutes'
                     OR actor_id IS DISTINCT FROM lag(actor_id) OVER w
                     -- history carried in from another workspace is all attributed to the importer's id; its saves by different
                     -- people (the name it kept) are still different authors
                     OR import_actor IS DISTINCT FROM lag(import_actor) OVER w
                     -- restores and creates are single-event sessions: they
                     -- start one AND the next save starts fresh, so the
                     -- created/restored baseline never coalesces away
                     OR event_type <> 'NODE_UPDATED'
                     OR lag(event_type) OVER w <> 'NODE_UPDATED'
                     OR is_restore OR lag(is_restore) OVER w
                     -- a save that won a body conflict starts a session: the
                     -- body it overrode (the previous row, even by the same
                     -- actor in another tab) stays its own restore point
                     OR id IN (SELECT triggered_by_event_id FROM domain_events
                                WHERE target_id = $1 AND workspace_id = $2
                                  AND event_type = 'BODY_CONFLICT'
                                  AND triggered_by_event_id IS NOT NULL)
                   THEN 1 ELSE 0 END AS boundary
         FROM bodies
       WINDOW w AS (ORDER BY created_at ASC, id ASC)
     ),
     sessions AS (
       SELECT *, sum(boundary) OVER (ORDER BY created_at ASC, id ASC) AS session_no
         FROM marked
     ),
     collapsed AS (
       SELECT DISTINCT ON (session_no)
              session_no, id, actor_id, actor_type, import_actor, imported, created_at, title, body_hash,
              is_restore, restored_id,
              count(*) OVER (PARTITION BY session_no) AS saves
         FROM sessions
        ORDER BY session_no, created_at DESC, id DESC
     )
     SELECT c.id::text AS id, c.title, b.content AS markdown,
            c.created_at AS changed_at, c.imported, c.import_actor AS import_name, a.name AS row_name, a.type AS row_type, c.actor_type,
            c.saves::int AS saves, c.is_restore,
            -- 被還原的那個事件落在哪一列（用該列的 changed_at 指它）
            (SELECT c2.created_at FROM anchored v
               JOIN sessions s2 ON s2.id = v.anchor_id
               JOIN collapsed c2 ON c2.session_no = s2.session_no
              WHERE c.is_restore AND v.id::text = c.restored_id) AS restored_at
       FROM collapsed c
       JOIN blobs b ON b.hash = c.body_hash
  LEFT JOIN actors a ON a.id::text = c.actor_id
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${VERSION_LIMIT + 1}`,
    [nodeId, workspaceId],
  );
  // The query reads one row beyond the list only to describe the list's last
  // row; that row is never merged away (absorbSameText keeps the oldest), and a
  // merge above it only makes the list shorter.
  // A session's write is sent as the kind 'session' with no name (services/authorName.ts; describeVersions sets the kind).
  const listed: VersionRow[] = result.rows.map(({ imported, import_name, row_name, row_type, ...row }) => {
    const author = versionAuthor({ imported, import_name, row_name, row_type });
    return { ...row, actor_name: shownAuthorName(author.rowType, author.name), author_row_type: author.rowType };
  });
  const merged = absorbSameText(listed);
  const hasOlder = listed.length > VERSION_LIMIT;
  const rows = hasOlder ? merged.slice(0, -1) : merged;

  // 發布快照序號 = 這個工作區的快照依建立時間排的第幾個（最舊 = #1）
  const snaps = await q<{ n: number; at: Date }>(
    `SELECT n::int AS n, at FROM (
       SELECT row_number() OVER (ORDER BY created_at, id) AS n, created_at AS at,
              payload->'nodes' @> jsonb_build_array(jsonb_build_object('id', $2::text)) AS has_note
         FROM publish_snapshots WHERE workspace_id = $1
     ) s WHERE has_note ORDER BY n DESC LIMIT 50`,
    [workspaceId, nodeId],
  );
  return describeVersions(rows, hasOlder ? merged[merged.length - 1]!.markdown : null, snaps.rows);
}
