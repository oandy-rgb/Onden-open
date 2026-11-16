// THE CUT of a change bundle (spine/stampedBundle.ts header): a bundle never skips a stamp that commits later with a lower sequence number.
// Today's allocation (spine/stamps.ts lockClock → sync_lock_clock, db/migrations/190): a stamp's number is taken under the workspace's event-append advisory lock and its sync_clock row,
// both held until the writing transaction ends, so in one workspace numbers are taken and committed in number order: a larger number cannot be taken until the smaller one has committed.
// The read takes no lock of its own; it reads the cut (`next_seq - 1`) and the stamps in ONE repeatable-read snapshot, so it sees exactly the stamps up to its cut.
// On a real Postgres this runs three connections (a writer holding its number, a second writer that has to wait, the reader). PGlite has one connection: there the same facts are checked
// in sequence (no skip is possible without a second connection), and the PR says so. The mutation check of the PR (the read without its snapshot) is this test failing.
import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, vi } from "vitest";
import { pool, q, withTransaction } from "../db.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction } from "../spine/stamps.js";
import { readChangeBundle } from "../services/stampedBundle.js";
import { readHave } from "../spine/stampedBundle.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { makeCaller } from "./helpers/stampedWorld.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const onPglite = process.env.ONDEN_DB_DRIVER === "pglite";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(!isTestDb)("a bundle read never skips a stamp that commits later with a lower number", () => {
  let owner!: ActorCtx;
  let space = "";
  const notes: string[] = [];
  const note = async (title: string) => (await makeCaller(owner)("POST", "/api/nodes", { id: randomUUID(), title, markdown: "", space_id: space })).id as string;
  /** The stamps of the workspace's notes as a bundle carries them: [origin, seq] of every row stamp, and the cut. */
  const read = async (have: Record<string, number> = {}) => {
    const pages = await readChangeBundle(owner, WS, have);
    const stamps = pages.flatMap((p) => p.items.flatMap((i) => (i.kind === "row" ? i.stamps : [i.stamp]).flatMap((s) => [s, ...s.heads]))).filter((s) => s.origin !== "genesis");
    return { cut: pages[0]!.cut, node: pages[0]!.sender, seqs: stamps.map((s) => s.seq), upTo: pages[0]!.upTo };
  };

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Cut', $1) RETURNING id`, [`cut-${Date.now()}`])).rows[0]!.id;
    owner = await persistActor(WS, { id: "", name: "Owner", role: "admin", type: "human" });
    await setModulesOn(WS, null);
    space = await makeSpace(WS, `cut ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
    for (const t of ["one", "two", "three"]) notes.push(await note(t));
  });

  it("stamps are taken and committed in number order, and a reader sees exactly the stamps up to its cut", async () => {
    const before = await read();
    expect(Math.max(...before.seqs)).toBeLessThanOrEqual(before.cut);
    if (onPglite) {
      // one connection: sequential facts only (the two-connection proof ran on a real Postgres)
      await makeCaller(owner)("PATCH", `/api/nodes/${notes[0]}`, { title: "a" });
      const after = await read();
      expect(after.cut).toBeGreaterThanOrEqual(before.cut);
      expect(Math.max(...after.seqs)).toBeLessThanOrEqual(after.cut);
      return;
    }
    // writer 1 takes its number and holds it (its transaction is open)
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let taken!: (seq: number) => void;
    const firstSeq = new Promise<number>((r) => { taken = r; });
    const writer1 = withTransaction(async () => withEventTransaction(WS, async () => {
      await stampTransaction(WS, owner.id);
      await q(`UPDATE content_nodes SET title = 'writer one' WHERE id = $1`, [notes[0]]);
      taken(Number((await q<{ next_seq: string }>(`SELECT next_seq FROM sync_clock WHERE workspace_id = $1`, [WS])).rows[0]!.next_seq) - 1);
      await gate;
    }));
    const n1 = await firstSeq;
    // writer 2 wants the next number: it must wait for writer 1
    let writer2Done = false;
    const writer2 = withTransaction(async () => withEventTransaction(WS, async () => {
      await stampTransaction(WS, owner.id);
      await q(`UPDATE content_nodes SET title = 'writer two' WHERE id = $1`, [notes[1]]);
    })).then(() => { writer2Done = true; });
    await sleep(500);
    expect(writer2Done, "a larger number was taken while a smaller one was uncommitted").toBe(false);
    // a reader now sees neither: its cut is the last COMMITTED number and no stamp of the bundle is past it
    const during = await read();
    expect(during.cut).toBe(before.cut);
    expect(Math.max(...during.seqs)).toBeLessThanOrEqual(during.cut);
    expect(n1).toBe(during.cut + 1);
    release();
    await Promise.all([writer1, writer2]);
    const after = await read();
    expect(after.cut).toBe(n1 + 1); // both numbers are committed, in order
    expect(after.seqs).toEqual(expect.arrayContaining([n1, n1 + 1]));
    // the bundle for a receiver that held the first cut carries exactly what it lacks
    const delta = await read({ [after.node]: before.cut });
    expect([...new Set(delta.seqs)].filter((s) => s > before.cut).sort((x, y) => x - y)).toEqual([n1, n1 + 1]);
    expect(await readHave(WS)).toEqual(expect.objectContaining({ [after.node]: after.cut }));
  }, 60_000);

  it("a write that commits BETWEEN the read of the cut and the read of the stamps is in neither (one snapshot)", async () => {
    const before = await read();
    if (onPglite) { // one connection: a write cannot commit while the read snapshot is open; only the plain facts are checked here, the interleaving ran on a real Postgres
      const pages = await readChangeBundle(owner, WS, {}, { afterCut: async () => undefined });
      expect(pages[0]!.cut).toBe(before.cut);
      return;
    }
    let inBetween = 0;
    const pages = await readChangeBundle(owner, WS, {}, {
      afterCut: async () => { // on another connection, committed before the reader goes on
        const client = await pool.connect();
        try { await client.query(`UPDATE content_nodes SET title = 'between the two reads' WHERE id = $1`, [notes[2]]); inBetween = 1; } finally { client.release(); }
      },
    });
    expect(inBetween).toBe(1);
    const stamps = pages.flatMap((p) => p.items.flatMap((i) => (i.kind === "row" ? i.stamps : [i.stamp]).flatMap((s) => [s, ...s.heads]))).filter((s) => s.origin !== "genesis");
    expect(pages[0]!.cut).toBe(before.cut); // the cut is that of the snapshot, whatever committed meanwhile
    expect(Math.max(...stamps.map((s) => s.seq))).toBeLessThanOrEqual(pages[0]!.cut); // no stamp past the cut: a stamp the cut does not cover would be skipped by the next bundle's base
    const next = await read({ [pages[0]!.sender]: pages[0]!.cut });
    expect(next.seqs.some((s) => s > pages[0]!.cut)).toBe(true); // and the next bundle carries the write that was in between
  }, 60_000);
});
