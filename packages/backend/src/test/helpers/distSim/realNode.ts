// A FULL backend (every table, every service) per node, several in one process.
//
// The backend reaches its database through one process-wide handle (db.ts `pglite`). A "real node" is a PGlite of its own, loaded from
// the migrated template; `onNode(node, fn)` points that handle at the node's database for the duration of `fn` and runs one node at a
// time (a mutex), so a service call, a route request or the sync bridge runs against exactly that node's rows and nothing else.
// Two nodes can therefore be driven by the real services/API in one test, which is what the shadow comparison needs.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { pglite } from "../../../db.js";
import { openPglite } from "../../../dbPglite.js";

type Holder = { opened: Promise<PGlite> | null };

export class RealNode {
  private constructor(readonly name: string, public pg: PGlite) {}

  /** A new node: from `copyOf` (a copy of that node's database right now: "two copies of one server"), else from the migrated template. */
  static async open(name: string, copyOf?: RealNode): Promise<RealNode> {
    if (copyOf) {
      const dump = await copyOf.pg.dumpDataDir("none");
      return new RealNode(name, await openPglite({ dataDir: "memory://", loadDataDir: async () => dump }));
    }
    const file = process.env.ONDEN_PGLITE_SNAPSHOT;
    if (!file) throw new Error("realNode needs ONDEN_PGLITE_SNAPSHOT (a PGlite test run)");
    const tar = new Blob([await readFile(file)]);
    return new RealNode(name, await openPglite({ dataDir: "memory://", loadDataDir: async () => tar }));
  }

  /** Power loss and restart from disk: the database goes through dump and reload. */
  async restart(): Promise<void> {
    const dump = await this.pg.dumpDataDir("none");
    await this.pg.close();
    this.pg = await openPglite({ dataDir: "memory://", loadDataDir: async () => dump });
  }

  async close(): Promise<void> { if (!this.pg.closed) await this.pg.close(); }
}

const current = new AsyncLocalStorage<RealNode>();
let tail: Promise<unknown> = Promise.resolve();

/** Run `fn` against `node`'s database, alone. Nested calls for the same node join; for another node they are a bug (they would deadlock). */
export function onNode<T>(node: RealNode, fn: () => Promise<T>): Promise<T> {
  const inside = current.getStore();
  if (inside) {
    if (inside !== node) throw new Error(`onNode(${node.name}) inside onNode(${inside.name})`);
    return fn();
  }
  const run = tail.then(() => current.run(node, async () => {
    (pglite as unknown as Holder).opened = Promise.resolve(node.pg);
    return fn();
  }));
  tail = run.then(() => undefined, () => undefined);
  return run;
}
