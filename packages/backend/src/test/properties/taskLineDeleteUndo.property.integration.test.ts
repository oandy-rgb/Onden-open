// Deleting a task that is a line of a note and undoing it (modules/tasks/deletion.ts), through the real routes: for any
// small generated note (headings, paragraphs, blank lines, list items up to three levels deep, some of them task lines),
// deleting any task line and undoing the delete gives the note's text back byte for byte, and the task is its line again.
//
// The delete event records the line's own indent, its previous sibling (or what it sat first under) and the blank lines
// around it; the write-back rebuilds exactly that (placement.ts blankAround / writeTaskLine). No difference is allowed.
//
// The seed is fresh every run and printed first (it is NOT PROPS_SEED's fixed default: a fixed seed would try the same few
// notes for ever). Replay: TASK_LINE_SEED=<seed> npx vitest run src/test/properties/taskLineDeleteUndo
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../../db.js";
import { apiOnError } from "../../httpError.js";
import nodesRouter from "../../routes/nodes.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { isTestDatabase } from "../helpers/testDatabase.js";

let workspaceId = "";
let admin: ActorCtx = { id: "task-line-prop-admin", name: "Tasks", role: "admin", type: "human" };
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", admin); await next(); });
app.route("/nodes", nodesRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const bodyOf = async (id: string) => (await q<{ markdown: string }>("SELECT markdown FROM content_nodes WHERE id = $1", [id])).rows[0]!.markdown;

type Chunk = { kind: "heading"; level: number } | { kind: "paragraph" } | { kind: "item"; depth: number; task: boolean; blankAfter: boolean };
const chunkArb: fc.Arbitrary<Chunk> = fc.oneof(
  fc.record({ kind: fc.constant("heading" as const), level: fc.integer({ min: 1, max: 2 }) }),
  fc.record({ kind: fc.constant("paragraph" as const) }),
  fc.record({ kind: fc.constant("item" as const), depth: fc.integer({ min: 0, max: 2 }), task: fc.boolean(), blankAfter: fc.boolean() }),
  fc.record({ kind: fc.constant("item" as const), depth: fc.integer({ min: 0, max: 2 }), task: fc.constant(true), blankAfter: fc.boolean() }),
);

/** The note text of `chunks`: blocks are separated by a blank line unless both are list items; a nested item is at most one level
 *  deeper than the item before it. Returns the text and the titles of its task lines. */
function render(chunks: Chunk[]): { text: string; titles: string[] } {
  const lines: string[] = [];
  const titles: string[] = [];
  let prev: Chunk | null = null;
  let prevDepth = -1;
  // Whether each open level of the list is a task line. A task nested under a task line is left out of the generated notes: removing
  // such a child line by ANY save (a plain PATCH too) leaves the parent's anchor `maybe` (it quoted the child as well) and the note's
  // save then trashes the parent's task. That is the anchor mapper's (blockAnchors/mapping.ts), a known limit written in
  // docs/architecture/tasks-module.md; this property covers what the delete and the undo themselves do.
  const taskAt: boolean[] = [];
  chunks.forEach((c, i) => {
    const inList = prev?.kind === "item";
    if (prev && !(inList && c.kind === "item" && !(prev as { blankAfter: boolean }).blankAfter)) lines.push("");
    if (c.kind === "heading") { lines.push(`${"#".repeat(c.level)} 標題${i}`); prevDepth = -1; }
    else if (c.kind === "paragraph") { lines.push(`段落${i}`); prevDepth = -1; }
    else {
      const depth = inList ? Math.min(c.depth, prevDepth + 1) : 0;
      taskAt.length = depth;
      const isTask = c.task && !(depth > 0 && taskAt.some(Boolean));
      taskAt[depth] = isTask;
      const label = isTask ? `任務${i}` : `項目${i}`;
      if (isTask) titles.push(label);
      lines.push(`${"  ".repeat(depth)}- ${isTask ? `[ ] ${label} {task}` : label}`);
      prevDepth = depth;
    }
    prev = c;
  });
  return { text: `${lines.join("\n")}\n`, titles };
}

describe.skipIf(!isTestDatabase())("task line: delete then undo", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Task line property',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    admin = await persistActor(workspaceId, admin);
  });

  it("gives the note back byte for byte, and the same task is its line again", async () => {
    const seed = Number(process.env.TASK_LINE_SEED) || (Date.now() ^ (Math.random() * 2 ** 31)) >>> 0;
    console.log(`taskLineDeleteUndo seed=${seed} (replay: TASK_LINE_SEED=${seed})`);
    const run = Number(process.env.TASK_LINE_RUNS) || 25;
    await fc.assert(fc.asyncProperty(fc.array(chunkArb, { minLength: 1, maxLength: 8 }), async (chunks) => {
      const { text, titles } = render(chunks);
      fc.pre(titles.length > 0);
      const created = await send("/nodes", "POST", { title: `屬性 ${randomUUID().slice(0, 6)}`, markdown: text });
      expect(created.status).toBe(201);
      const noteId = ((await created.json()) as { id: string }).id;
      const taskIds = (await q<{ id: string; title: string }>(`SELECT id::text, title FROM content_nodes WHERE parent_id = $1 AND deleted_at IS NULL`, [noteId])).rows;
      expect(taskIds.length).toBe(titles.length);
      // Every task line, one after the other: the whole note must be as it was after each round.
      for (const t of taskIds) {
        expect((await send(`/nodes/${t.id}`, "DELETE")).status, `delete ${t.title} of\n${text}`).toBe(200);
        expect((await send(`/nodes/${t.id}/undelete`, "POST")).status, `undo ${t.title} of\n${text}`).toBe(200);
        expect(await bodyOf(noteId), `after delete+undo of ${t.title}, from\n${JSON.stringify(text)}`).toBe(text);
        const linked = await q(`SELECT 1 FROM block_nodes WHERE note_id = $1 AND task_id = $2 AND hidden_at IS NULL`, [noteId, t.id]);
        expect(linked.rows.length, `${t.title} is its line again`).toBe(1);
      }
    }), { seed, numRuns: run });
  }, 600_000);
});
