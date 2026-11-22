// The words that make a checkbox line a task are decided on the server and sent to the editor on
// `workspace.line_words` (services/lineWords.ts): the bootstrap and the sync delta carry exactly the words the
// note save acts on, in every workspace shape — a renamed module tag, the user's own `task` tag, the module off.
// The editor's side of the same question is frontend/src/test/lineWordsParity.test.ts.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import tagsRouter from "../routes/tags.js";
import { mountModules } from "../modules/index.js";
import { tasksModule } from "../modules/tasks/index.js";
import { buildBootstrap } from "../services/sync/bootstrap.js";
import { buildSyncDelta } from "../services/sync/delta.js";
import { reservedTagFixture, taskModuleTagId } from "./helpers/reservedTag.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

type WireWords = { tasks?: { words: string[]; on: boolean } };

describe.skipIf(!isTestDb)("line words: the wire and the save agree (DB)", () => {
  const stamp = Date.now();
  const alice: ActorCtx = { id: "alice", name: "Alice", role: "admin", type: "human" };
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", alice); await next(); });
  app.route("/api/nodes", nodesRouter);
  app.route("/api/tags", tagsRouter);
  let counter = 0;

  async function workspace(label: string): Promise<void> {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [label, `line-words-${stamp}-${counter++}`])).rows[0]!.id;
    Object.assign(alice, await persistActor(WS, alice));
    await setModulesOn(WS, null);
  }

  const WORDS = ["task", "待辦", "任務", "其他"];
  /** Which of the words made a task of its line when the note was saved, as the bootstrap's tasks list shows. */
  async function savedTasks(): Promise<string[]> {
    const body = WORDS.map((word) => `- [ ] line ${word} {${word}}`).join("\n");
    const res = await app.request("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `n ${counter}`, markdown: body }) });
    expect(res.status).toBe(201);
    const boot = await buildBootstrap(alice, WS, { slimBodies: false });
    const titles = (boot.tasks as Array<{ title: string }>).map((task) => task.title);
    return WORDS.filter((word) => titles.some((title) => title.includes(`line ${word}`)));
  }
  const wireWords = async (): Promise<WireWords> => {
    const boot = await buildBootstrap(alice, WS, { slimBodies: false });
    return (boot.workspace as { line_words: WireWords }).line_words;
  };
  /** What the words on the wire say is a task, for the same four words the note carried. */
  const madeByWire = (wire: WireWords) => WORDS.filter((word) => wire.tasks?.on && wire.tasks.words.includes(word));

  beforeAll(() => { mountModules(app, [tasksModule]); });

  const shapes: Array<{ name: string; setup: () => Promise<void> }> = [
    { name: "usual: the module tag is called task", setup: async () => { await reservedTagFixture(WS, "task"); } },
    { name: "the module tag was renamed", setup: async () => {
      const id = await reservedTagFixture(WS, "task");
      await seedQ(`UPDATE content_nodes SET title = '待辦' WHERE id = $1`, [id]);
    } },
    { name: "the user's own `task` tag, no module tag", setup: async () => {
      await seedQ(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, 'manual', 'class_tag', 'task', $2, '')`, [WS, `tag-own-task-${stamp}-${counter}`]);
    } },
    { name: "the tasks module is off", setup: async () => { await reservedTagFixture(WS, "task"); await setModulesOn(WS, []); } },
  ];

  for (const shape of shapes) {
    it(`${shape.name}: the wire's words are the ones the save acts on`, async () => {
      await workspace(shape.name);
      await shape.setup();
      const wire = await wireWords();
      expect(wire.tasks, "the bootstrap carries the tasks words").toBeDefined();
      expect(madeByWire(wire)).toEqual(await savedTasks());
    });
  }

  it("a module tag renamed after the bootstrap shows in the next delta, so an open editor follows it", async () => {
    await workspace("rename later");
    const id = await reservedTagFixture(WS, "task");
    const before = await buildBootstrap(alice, WS, { slimBodies: false });
    const since = Number(before.last_event_id);
    expect((before.workspace as { line_words: WireWords }).line_words.tasks!.words).toEqual(["task"]);
    const renamed = await app.request(`/api/tags/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "待辦" }) });
    expect(renamed.status).toBe(200);
    const delta = await buildSyncDelta(alice, WS, { since, known: [] });
    const words = (delta.workspace as unknown as { line_words: WireWords } | null)?.line_words.tasks;
    expect(words?.words).toEqual(["待辦", "task"]);
    expect(await taskModuleTagId(WS)).toBe(id);
  });
});
