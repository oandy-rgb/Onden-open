// Property test of 「空間發布」: which notes the site shows
// (modules/website/publishing/publishedSet.ts publishedNodeIds, the ONE set the
// snapshot, the served site and a note's site status all read).
//
// Each run writes a random workspace straight into the test database (1–3
// spaces with 「發布到網站」 on or off; 0–25 notes in a tree: text or none,
// hidden, `_published` none/true/false, saved articles, system machinery,
// attributes kept beside the text, trashed ones) and checks:
//   1. publishedNodeIds equals publishSetModel (a short independent model);
//   2. never shown: hidden, trashed, 「不發布」, in a space that does not publish;
//   3. the same data built in another insertion order gives the same set;
//   4. marking a note 「不發布」 removes exactly that note; switching a space's
//      publish off removes exactly that space's notes and leaves the others;
//   5. the publish preview lists exactly those notes;
//   9. a note made through createNote under a note of the world joins it as the rule says (owner 2026-11-13: under a
//      「不發布」 parent it is 「不發布」 too, otherwise as any note), and no other note's standing changes;
//   6. migration 186's UPDATE (read from the file): a space that published and
//      has a live `_published`='true' note stays on, the other spaces that were
//      on go off, off stays off, other capabilities untouched; twice = once.
//
// There is no "restricted tag" in the read policy any more (tag access policies
// became spaces, migration 094), so publishedNodeIds has no such exclusion to test.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> (helpers/propsConfig).
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, q, withTransaction } from "../../db.js";
import { publishedNodeIds } from "../../modules/website/publishing/publishedSet.js";
import { buildPublishPreview } from "../../modules/website/publishing/preview.js";
import { seedQ } from "../helpers/seedQ.js";
import { checkAsync } from "../helpers/propsConfig.js";
import { modelPublished, worldArb, type World } from "../helpers/publishSetModel.js";
import { createNote } from "../../services/noteCreate.js";
import { persistActor } from "../helpers/persistActor.js";
import { setWorkspaceOwner } from "../helpers/setOwner.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const DEFAULT_RUNS = 25;
/** Slow properties (a publish preview per run) are capped. */
const runsCap = (cap: number) => (process.env.PROPS_RUNS ? Infinity : Math.min(DEFAULT_RUNS, cap));

type Built = { ws: string; spaceIds: string[]; noteIds: string[] };

let runSerial = 0;
const stamp = Date.now().toString(36);

/** Write the world. `order` is the insertion order of the notes (a permutation
 *  of indexes); parents are linked afterwards, so any order is valid. */
async function build(world: World, order: number[]): Promise<Built> {
  const tag = `${stamp}${(runSerial++).toString(36)}`;
  const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id::text`, [`ps-${tag}`])).rows[0]!.id;
  const spaceIds: string[] = [];
  for (const [i, s] of world.spaces.entries()) {
    spaceIds.push((await q<{ id: string }>(
      `INSERT INTO spaces (workspace_id, name, kind, capabilities) VALUES ($1, $2, 'shared', $3) RETURNING id::text`,
      [ws, `s${i}`, JSON.stringify({ publish: s.publish, external_ai: true, backup: true })])).rows[0]!.id);
  }
  const noteIds = world.notes.map(() => randomUUID());
  await withTransaction(async () => {
    for (const i of order) {
      const n = world.notes[i]!;
      await q(
        `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id, hidden, deleted_at)
         VALUES ($1, $2, $3, 'content', $4, $4, $5, $6, $7, ${n.deleted ? "now()" : "NULL"})`,
        [noteIds[i], ws, n.sourceType, `n${i}`, n.markdown, spaceIds[n.space], n.hidden],
      );
    }
    for (const i of order) {
      const n = world.notes[i]!;
      if (n.parent !== null) await q(`UPDATE content_nodes SET parent_id = $1 WHERE id = $2`, [noteIds[n.parent], noteIds[i]]);
      if (n.flag) await q(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, '_published', $3)`, [ws, noteIds[i], n.flag]);
      // `_note` is bookkeeping (does not count as content); `ink` is kept beside the text.
      await q(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, '_note', 'x')`, [ws, noteIds[i]]);
      if (n.hasKeptAttr) await q(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, 'ink', 'stroke')`, [ws, noteIds[i]]);
    }
  });
  return { ws, spaceIds, noteIds };
}

async function drop(ws: string): Promise<void> {
  await withTransaction(async () => {
    await q(`DELETE FROM node_attributes WHERE workspace_id = $1`, [ws]);
    await q(`UPDATE content_nodes SET parent_id = NULL WHERE workspace_id = $1`, [ws]);
    await q(`DELETE FROM content_nodes WHERE workspace_id = $1`, [ws]);
    await q(`DELETE FROM spaces WHERE workspace_id = $1`, [ws]);
    await q(`DELETE FROM workspaces WHERE id = $1`, [ws]);
  });
}

const identity = (n: number) => Array.from({ length: n }, (_, i) => i);
/** Indexes of the published notes, from ids back to positions. */
const indexesOf = (ids: Set<string>, b: Built) => new Set(b.noteIds.flatMap((id, i) => (ids.has(id) ? [i] : [])));
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

async function withWorld<T>(world: World, order: number[], fn: (b: Built) => Promise<T>): Promise<T> {
  const b = await build(world, order);
  try { return await fn(b); } finally { await drop(b.ws); }
}

describe.skipIf(!isTestDb)("空間發布 properties (publishedNodeIds)", () => {
  beforeAll(() => { /* each run makes its own workspace */ });
  afterAll(async () => { await pool.end(); });

  it("the generator reaches the interesting cases", () => {
    const worlds = fc.sample(worldArb, { numRuns: 300, seed: 1 });
    const notes = worlds.flatMap((w) => w.notes.map((n) => ({ w, n })));
    expect(worlds.filter((w) => modelPublished(w.spaces, w.notes).size > 0).length).toBeGreaterThan(100);
    expect(notes.some(({ n }) => n.flag === "true" && n.sourceType === "rss")).toBe(true);
    expect(notes.some(({ n }) => n.flag === "true" && n.hidden)).toBe(true);
    expect(notes.some(({ w, n }) => n.flag === "true" && !w.spaces[n.space]!.publish)).toBe(true);
    expect(notes.some(({ n }) => !/\S/.test(n.markdown) && !n.hasKeptAttr && n.flag === null && !n.hidden)).toBe(true);
  });

  it("1+2: the set equals the model, and never holds what must stay off", async () => {
    await checkAsync(fc.asyncProperty(worldArb, async (world) => {
      await withWorld(world, identity(world.notes.length), async (b) => {
        const got = indexesOf(await publishedNodeIds(b.ws), b);
        expect(sorted(got)).toEqual(sorted(modelPublished(world.spaces, world.notes)));
        for (const i of got) {
          const n = world.notes[i]!;
          expect(n.hidden, `hidden note ${i} shown`).toBe(false);
          expect(n.deleted, `trashed note ${i} shown`).toBe(false);
          expect(n.flag, `「不發布」 note ${i} shown`).not.toBe("false");
          expect(world.spaces[n.space]!.publish, `note ${i} shown from a space that does not publish`).toBe(true);
        }
      });
    }), runsCap(Infinity));
  }, 600_000);

  it("3: the insertion order does not change the set", async () => {
    await checkAsync(fc.asyncProperty(worldArb, fc.infiniteStream(fc.nat()), async (world, rnd) => {
      const order = identity(world.notes.length);
      const picks = rnd[Symbol.iterator]();
      for (let i = order.length - 1; i > 0; i--) { const j = picks.next().value! % (i + 1); [order[i], order[j]] = [order[j]!, order[i]!]; }
      const a = await withWorld(world, identity(world.notes.length), async (b) => sorted(indexesOf(await publishedNodeIds(b.ws), b)));
      const c = await withWorld(world, order, async (b) => sorted(indexesOf(await publishedNodeIds(b.ws), b)));
      expect(c).toEqual(a);
    }), runsCap(Infinity));
  }, 600_000);

  it("4: 「不發布」 removes exactly that note; a space's switch off removes exactly that space's notes", async () => {
    await checkAsync(fc.asyncProperty(worldArb, fc.nat(), fc.nat(), async (world, pick, spacePick) => {
      await withWorld(world, identity(world.notes.length), async (b) => {
        const before = indexesOf(await publishedNodeIds(b.ws), b);
        if (world.notes.length > 0) {
          const k = pick % world.notes.length;
          await seedQ(`DELETE FROM node_attributes WHERE node_id = $1 AND key = '_published'`, [b.noteIds[k]]);
          await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, '_published', 'false')`, [b.ws, b.noteIds[k]]);
          const after = indexesOf(await publishedNodeIds(b.ws), b);
          expect(sorted(after)).toEqual(sorted(new Set([...before].filter((i) => i !== k))));
        }
        // Back to the first state, then switch one space off.
        const s = spacePick % world.spaces.length;
        await seedQ(`DELETE FROM node_attributes WHERE workspace_id = $1 AND key = '_published'`, [b.ws]);
        for (const [i, n] of world.notes.entries()) if (n.flag) await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, '_published', $3)`, [b.ws, b.noteIds[i], n.flag]);
        await seedQ(`UPDATE spaces SET capabilities = capabilities || '{"publish": false}'::jsonb WHERE id = $1`, [b.spaceIds[s]]);
        const off = indexesOf(await publishedNodeIds(b.ws), b);
        expect(sorted(off)).toEqual(sorted(new Set([...before].filter((i) => world.notes[i]!.space !== s))));
      });
    }), runsCap(Infinity));
  }, 600_000);

  it("5: the publish preview lists exactly the published notes", async () => {
    await checkAsync(fc.asyncProperty(worldArb, async (world) => {
      await withWorld(world, identity(world.notes.length), async (b) => {
        const preview = await buildPublishPreview(b.ws, { title: "t" });
        const nodes = (preview.site.payload as { nodes?: Array<{ id: string }> }).nodes ?? [];
        expect(sorted(indexesOf(new Set(nodes.map((n) => n.id)), b))).toEqual(sorted(indexesOf(await publishedNodeIds(b.ws), b)));
        expect(nodes.length).toBe(new Set(nodes.map((n) => n.id)).size);
      });
    }), runsCap(30));
  }, 600_000);

  it("6: migration 186's UPDATE keeps a space on only when it has a live 'true' note, and is idempotent", async () => {
    const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/186_publish_by_space.sql"), "utf8");
    const update = file.match(/^UPDATE spaces s[\s\S]*?;/m)?.[0];
    expect(update, "the UPDATE statement was not found in migration 186").toBeTruthy();
    await checkAsync(fc.asyncProperty(worldArb, async (world) => {
      await withWorld(world, identity(world.notes.length), async (b) => {
        const read = async () => new Map((await q<{ id: string; caps: Record<string, unknown> }>(`SELECT id::text, capabilities AS caps FROM spaces`)).rows.map((r) => [r.id, r.caps]));
        const ROLLBACK = new Error("rollback");
        let first: Map<string, Record<string, unknown>> = new Map(), second: Map<string, Record<string, unknown>> = new Map();
        const before = await read();
        await withTransaction(async () => {
          await q(update!); first = await read();
          await q(update!); second = await read();
          throw ROLLBACK;
        }).catch((e) => { if (e !== ROLLBACK) throw e; });
        expect([...second.entries()]).toEqual([...first.entries()]); // twice = once
        for (const [id, caps] of before) {
          const after = first.get(id)!;
          const { publish: _a, ...restBefore } = caps; const { publish: afterPublish, ...restAfter } = after;
          expect(restAfter).toEqual(restBefore); // only the switch changes
          const i = b.spaceIds.indexOf(id);
          if (i < 0) { if (caps.publish !== true) expect(afterPublish).toBe(caps.publish); else expect([true, false]).toContain(afterPublish); continue; }
          const keeps = world.notes.some((n) => n.space === i && !n.deleted && n.flag === "true");
          expect(afterPublish).toBe(world.spaces[i]!.publish ? keeps : false);
        }
      });
    }), runsCap(Infinity));
  }, 600_000);

  it("9: a note made under another note starts kept off exactly when its parent is, and nothing else moves", async () => {
    await checkAsync(fc.asyncProperty(worldArb, fc.nat(), async (world, pick) => {
      const parents = world.notes.flatMap((n, i) => (!n.deleted && !n.hidden && n.sourceType === "manual" ? [i] : []));
      if (parents.length === 0) return;
      const parent = parents[pick % parents.length]!;
      // Real events make the workspace undroppable (domain_events is append-only), so its rows stay in the test database.
      await (async (b: Built) => {
        const actor = await persistActor(b.ws, { id: "", name: `Maker ${b.ws.slice(0, 6)}`, type: "human", role: "editor" });
        await setWorkspaceOwner(b.ws, actor.id);
        for (const spaceId of b.spaceIds) await seedQ(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'edit')`, [spaceId, actor.id]);
        const made = await createNote({ actor, workspaceId: b.ws, title: "Made", markdown: "text", parentId: b.noteIds[parent]!,
          event: { uiContext: "test.create" } });
        // The model states the rule on its own: kept off iff the direct parent's own flag is 「不發布」.
        const notes = [...world.notes, { ...world.notes[parent]!, parent, markdown: "text", hidden: false, flag: world.notes[parent]!.flag === "false" ? "false" as const : null,
          sourceType: "manual" as const, hasKeptAttr: false, deleted: false }];
        const got = await publishedNodeIds(b.ws);
        const expected = modelPublished(world.spaces, notes);
        expect(got.has(String(made.node.id)), "the new note").toBe(expected.has(notes.length - 1));
        for (const i of world.notes.keys()) if (i !== parent) expect(got.has(b.noteIds[i]!), `note ${i}`).toBe(expected.has(i));
      })(await build(world, identity(world.notes.length)));
    }), runsCap(15));
  }, 600_000);
});
