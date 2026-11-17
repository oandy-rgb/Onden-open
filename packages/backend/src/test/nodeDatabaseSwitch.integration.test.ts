// The seam of the single-process multi-node tests (helpers/distSim/realNode.ts onNode, postgresNodes.ts pointPoolAt): the one handle the
// backend has reaches the database of the node a test is on, and nothing else, whichever engine the run is on.
// On a real Postgres the seam is `pool.options.connectionString` of the pool db.ts makes: if a pg upgrade changes what `options` does, this
// is the test that goes red first (current_database() stops being the node's, or an old node keeps connections).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { dbDriver, q, withTransaction } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { urlOfDatabase } from "./helpers/distSim/nodeDatabaseNames.js";
import { openNode } from "./helpers/stampedWorld.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const nameHere = async () => (await q<{ name: string }>(`SELECT name FROM workspaces WHERE slug = 'default'`)).rows[0]!.name;

async function sessionsOf(database: string): Promise<number> {
  const admin = new pg.Client({ connectionString: urlOfDatabase("postgres") });
  await admin.connect();
  try { return Number((await admin.query(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = $1`, [database])).rows[0].n); } finally { await admin.end(); }
}

describe.skipIf(!isTestDb)("onNode reaches the database of its node", () => {
  let a: RealNode;
  let b: RealNode;
  beforeAll(async () => {
    a = await openNode("switch-a");
    b = await openNode("switch-b");
    await onNode(a, () => seedQ(`UPDATE workspaces SET name = 'node A' WHERE slug = 'default'`));
    await onNode(b, () => seedQ(`UPDATE workspaces SET name = 'node B' WHERE slug = 'default'`));
  }, 120_000);
  afterAll(async () => { await a?.close(); await b?.close(); });

  it("two nodes taken in turn 20 times: each time the rows and (on a server) current_database() are that node's; the other keeps no connection", async () => {
    for (let i = 0; i < 20; i++) {
      const [node, other, label] = i % 2 === 0 ? [a, b, "node A"] as const : [b, a, "node B"] as const;
      await onNode(node, async () => {
        expect(await nameHere()).toBe(label);
        if (dbDriver === "postgres") expect((await q<{ d: string }>(`SELECT current_database() AS d`)).rows[0]!.d).toBe(node.database);
      });
      if (dbDriver === "postgres") expect(await sessionsOf(other.database!), `a connection to ${other.name} is left after leaving it`).toBe(0);
    }
  }, 120_000);

  // A node database is a copy of a template (and `copyOf` a copy of a node). What lives in the database's directory without being a relation
  // (PGroonga's own index files) must come along, or the first write to an indexed table fails on a server that has PGroonga (it did, on CI).
  // On a server without PGroonga, and on PGlite, there is no such index and this test proves nothing about it: it says so in its log line.
  it("a new node and a copy of a node can write an indexed note and find it through the full-text index (where the server has PGroonga)", async () => {
    const copy = await RealNode.open("switch-a-copy", a);
    try {
      for (const node of [a, copy]) {
        await onNode(node, async () => {
          const indexed = dbDriver === "postgres"
            && (await q(`SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am m ON m.oid = c.relam WHERE m.amname = 'pgroonga' LIMIT 1`)).rowCount! > 0;
          const word = `pgrnnode${node === a ? "first" : "copy"}`;
          const changed = await seedQ(`UPDATE content_nodes SET title = $1 WHERE id = (SELECT id FROM content_nodes ORDER BY id LIMIT 1)`, [word]);
          expect(changed.rowCount, "the template has no row in content_nodes to write to: this test needs one").toBe(1);
          if (!indexed) { console.log(`[nodeDatabaseSwitch] ${node.name}: no PGroonga index on this server (${dbDriver}); the write was made, the index was not exercised`); return; }
          // Through the index, not a sequential evaluation of the operator: the planner is told so for this one transaction.
          const found = await withTransaction(async () => {
            await q(`SET LOCAL enable_seqscan = off`);
            return q<{ n: string }>(`SELECT count(*) AS n FROM content_nodes WHERE title &@~ $1`, [word]);
          });
          expect(Number(found.rows[0]!.n)).toBe(1);
        });
      }
    } finally { await copy.close(); }
  }, 120_000);

  it("a node's database is dropped with the node, and the process's own database is the one the pool goes back to", async () => {
    const c = await openNode("switch-c");
    const database = c.database;
    await onNode(c, () => seedQ(`UPDATE workspaces SET name = 'node C' WHERE slug = 'default'`));
    await c.close();
    if (dbDriver === "postgres") {
      const admin = new pg.Client({ connectionString: urlOfDatabase("postgres") });
      await admin.connect();
      try { expect((await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [database])).rowCount).toBe(0); } finally { await admin.end(); }
      await onNode(null, async () => {
        expect((await q<{ d: string }>(`SELECT current_database() AS d`)).rows[0]!.d).toBe(new URL(process.env.DATABASE_URL!).pathname.slice(1));
      });
    }
    expect(await onNode(a, nameHere)).toBe("node A"); // the others are not touched by one going away
  }, 120_000);
});
