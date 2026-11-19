// One server, no sync (review of PR #1853 round 2, point 3): a task line's task goes to the trash when its line is removed (modules/tasks/blockTasks.ts syncBlockTasks);
// a person restores the task from the trash by hand; the note is saved again, the line still gone. Does that save trash the task again? Pinned as it is today: yes, every
// save trashes the task of a paragraph row that is no longer a task line, whoever restored it since. Not changed here; the PR description asks the owner.
import { afterEach, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, openNode } from "./helpers/stampedWorld.js";
import { peerOf } from "./helpers/stampedBundleWorld.js";
import { setModulesOn } from "./helpers/setModulesOn.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

describe.skipIf(!isTestDb)("a task restored by hand after its line was removed", () => {
  it("the next save of the note, the line still gone, trashes the task again (pinned)", async () => {
    const node = await openNode("one");
    open.push(node);
    const world = await buildSourceWorld(node);
    const a = peerOf("A", node, world);
    await onNode(node, async () => {
      await setModulesOn(a.ws, null);
      const note = (await a.call("POST", "/api/nodes", { title: "Tasks", markdown: "Intro\n\n- [ ] call the library {task}\n", space_id: a.space })).id as string;
      const task = (await q<{ id: string }>(`SELECT task_id::text AS id FROM block_nodes WHERE note_id = $1 AND task_id IS NOT NULL`, [note])).rows[0]!.id;
      const trashed = async () => (await q<{ d: boolean }>(`SELECT deleted_at IS NOT NULL AS d FROM content_nodes WHERE id = $1`, [task])).rows[0]!.d;
      await a.call("PATCH", `/api/nodes/${note}`, { markdown: "Intro\n" }); // the line removed
      expect(await trashed()).toBe(true);
      await a.call("POST", `/api/nodes/${task}/undelete`, {}); // the person restores the task
      expect(await trashed()).toBe(false);
      await a.call("PATCH", `/api/nodes/${note}`, { markdown: "Intro, a word more\n" }); // any later save of the note
      expect(await trashed()).toBe(true); // trashed again
    });
  }, 600_000);
});
