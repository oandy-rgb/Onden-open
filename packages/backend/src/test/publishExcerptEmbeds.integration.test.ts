// `![[Note#^id]]` of an excerpt on the published site (modules/website/publishing/
// excerptEmbeds.ts, user decision 2026-10-29): the quote and its source link are
// frozen into the published note even when the note holding the excerpt (a private
// diary) is not published; nothing else of that note reaches the payload, an embed
// of an ordinary paragraph keeps the old rule, and editing the diary afterwards
// does not change the published site.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { excerptBlock } from "@onden/markdown";
import { q } from "../db.js";
import { sha256Hex } from "../utils.js";
import type { ActorCtx } from "../types.js";
import { buildCandidate } from "../modules/website/publishing/snapshot.js";
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let WS = "";
let stamp = "";
let owner: ActorCtx;
type SiteNode = { id: string; markdown: string };
const nodesOf = (payload: Record<string, unknown>) => payload.nodes as SiteNode[];

const QUOTE = { exact: "A quiet sentence worth keeping." };
const SOURCE = { title: "An Article", url: "https://example.com/post", feed: "Some Feed" };

async function note(title: string, markdown: string, published: boolean): Promise<string> {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,$4) RETURNING id`,
    [WS, title, `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}`, markdown],
  )).rows[0]!.id;
  // The default space publishes; an unpublished note is one kept off (「不發布」).
  await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, '_published', $3, 'bool')`,
    [WS, id, published ? "true" : "false"]);
  return id;
}

describe.skipIf(!isTestDb)("published ![[excerpt]] embeds (DB)", () => {
  let home = "", diary = "";
  // 段落身分只在 block_anchors：兩個段落（摘錄、普通段落）各有一個錨點，首頁用錨點 id 嵌入。
  const EXCERPT = excerptBlock(QUOTE, SOURCE);
  const PLAIN = "Another private paragraph.";
  const diaryText = () => `Private day.\n\n${EXCERPT}\n\nMy secret thought about it.\n\n${PLAIN}`;
  const anchorIds = { excerpt: "ex1", plain: "plain1" };
  async function anchorBlocks(noteId: string, body: string): Promise<void> {
    for (const [id, text] of [[anchorIds.excerpt, EXCERPT], [anchorIds.plain, PLAIN]] as const) {
      const from = body.indexOf(text);
      await seedQ(
        `INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [WS, id, noteId, from, from + text.length, sha256Hex(body), text]);
    }
  }
  async function publish() {
    const c = await buildCandidate(WS, { title: "Site", actor: owner });
    await q(
      `INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref) VALUES ($1,$2,$3,$4,$5,'/site/')`,
      [WS, c.title, c.homeNodeId, c.eventCursor, c.payload],
    );
    return c;
  }
  beforeEach(async () => {
    stamp = randomUUID().slice(0, 8);
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Excerpts', $1) RETURNING id::text`, [`excerpts-${stamp}`])).rows[0]!.id;
    await publishDefaultSpace(WS);
    owner = await persistActor(WS, { id: "", name: `Excerpt owner ${stamp}`, role: "admin", type: "human" });
    diary = await note("Secret Diary", diaryText(), false);
    await anchorBlocks(diary, diaryText());
    home = await note("Home", `Intro.\n\n![[Secret Diary#^${anchorIds.excerpt}]]\n\nMiddle.\n\n![[Secret Diary#^${anchorIds.plain}]]`, true);
  });

  it("expands the excerpt alone: quote and original link, nothing else of the diary", async () => {
    const c = await buildCandidate(WS, { title: "Site", actor: owner });
    const md = nodesOf(c.payload).find((n) => n.id === home)!.markdown;
    expect(md).toContain("> A quiet sentence worth keeping.");
    expect(md).toContain("[An Article](https://example.com/post#:~:text=");
    expect(md).toContain("Some Feed");
    // The paragraph that is not an excerpt keeps the old rule: inert text.
    expect(md).toContain("(private)");
    const json = JSON.stringify(c.payload);
    for (const leak of ["Secret Diary", "secret-diary", "My secret thought", "Private day", "Another private paragraph", diary]) {
      expect(json, leak).not.toContain(leak);
    }
    expect(nodesOf(c.payload).some((n) => n.id === diary)).toBe(false);
  });

  it("without a publishing actor nothing is expanded", async () => {
    const c = await buildCandidate(WS, { title: "Site" });
    const md = nodesOf(c.payload).find((n) => n.id === home)!.markdown;
    expect(md).not.toContain("A quiet sentence");
    expect(md.match(/\(private\)/g)).toHaveLength(2);
  });

  it("the published site is a snapshot: editing the diary afterwards changes nothing", async () => {
    await publish();
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [diary, "Rewritten, no excerpt any more."]);
    const served = nodesOf((await loadServedSite(WS)).payload).find((n) => n.id === home)!.markdown;
    expect(served).toContain("> A quiet sentence worth keeping.");
    expect(served).toContain("https://example.com/post");
    expect(served).not.toContain("Rewritten");
  });
});
