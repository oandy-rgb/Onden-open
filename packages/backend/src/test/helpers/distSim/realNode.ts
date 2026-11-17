// A FULL backend (every table, every service) per node, several in one process.
//
// The backend reaches its database through one process-wide handle (db.ts `pglite`). A "real node" is a PGlite of its own, loaded from
// the migrated template; `onNode(node, fn)` points that handle at the node's database for the duration of `fn` and runs one node at a
// time (a mutex), so a service call, a route request or the sync bridge runs against exactly that node's rows and nothing else.
// Two nodes can therefore be driven by the real services/API in one test, which is what the shadow comparison needs.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { dbDriver, pglite, pool } from "../../../db.js";
import { describeOutstanding, outstanding, trackConnections } from "./connectionLedger.js";
import { awaitAllDispatchers } from "../../../services/dispatcherQueue.js";
import { openPglite } from "../../../dbPglite.js";
import { baseUrl, urlOfDatabase } from "./nodeDatabaseNames.js";
import { createNodeDatabase, dropNodeDatabase, leaveDatabase, pointPoolAt } from "./postgresNodes.js";

// Every connection the nodes' requests take is recorded, so that a node that leaves work behind is named (connectionLedger.ts).
trackConnections(dbDriver === "postgres" ? pool : pglite!);

type Holder = { opened: Promise<PGlite> | null };

/** On a real Postgres a node is a database of the server of DATABASE_URL (postgresNodes.ts) and `pg` is absent; on PGlite it is a PGlite. */
export class RealNode {
  private constructor(readonly name: string, public pg: PGlite | null, readonly database: string | null = null) {}

  /** The PGlite of a PGlite node; asking a real-Postgres node for it is a test written for one engine. */
  get lite(): PGlite {
    if (!this.pg) throw new Error(`node ${this.name} is a database of a real Postgres server, not a PGlite`);
    return this.pg;
  }

  /** A new node: from `copyOf` (a copy of that node's database right now: "two copies of one server"), else from the migrated template
   *  (or from `tarFile`, another PGlite dump such as the browser's packaged database). */
  static async open(name: string, copyOf?: RealNode, tarFile?: string): Promise<RealNode> {
    if (dbDriver === "postgres") {
      if (tarFile) throw new Error("a PGlite tar is the starting point of a PGlite node only");
      return new RealNode(name, null, await createNodeDatabase(copyOf?.database ?? undefined));
    }
    if (copyOf) {
      const dump = await copyOf.lite.dumpDataDir("none");
      return new RealNode(name, await openPglite({ dataDir: "memory://", loadDataDir: async () => dump }));
    }
    const file = tarFile ?? process.env.ONDEN_PGLITE_SNAPSHOT;
    if (!file) throw new Error("realNode needs ONDEN_PGLITE_SNAPSHOT (a PGlite test run)");
    const tar = new Blob([await readFile(file)]);
    return new RealNode(name, await openPglite({ dataDir: "memory://", loadDataDir: async () => tar }));
  }

  /** Power loss and restart from disk: the database goes through dump and reload. */
  async restart(): Promise<void> {
    if (this.database) { await leaveDatabase(this.database); return; } // a server keeps its data; what restarts is the connections
    const dump = await this.lite.dumpDataDir("none");
    await this.lite.close();
    this.pg = await openPglite({ dataDir: "memory://", loadDataDir: async () => dump });
  }

  /** Also when the test failed: a PGlite is closed, a database is dropped (connections and all). */
  async close(): Promise<void> {
    if (this.database) await dropNodeDatabase(this.database);
    else if (this.pg && !this.pg.closed) await this.pg.close();
  }
}

const current = new AsyncLocalStorage<RealNode>();
/** Stands in for "the database this process was started with" while it holds the lock (real Postgres only). */
const PROCESS_OWN = { name: "(this process's own database)", database: null, pg: null } as unknown as RealNode;
let tail: Promise<unknown> = Promise.resolve();

/** Run `fn` against `node`'s database, alone (`null`: the one this process has). Nested calls for the same node join; for another node they are a bug (they would deadlock).
 *  When `fn` is done the node's own after-commit work (the dispatcher queue's cascades, which the routes do not wait for) is awaited, and
 *  every connection must be back: leaving the node with work still running would let it land on the next node's database. Both engines. */
export function onNode<T>(node: RealNode | null, fn: () => Promise<T>): Promise<T> {
  // null: the database this process is connected to, as it is (a process that has one database of its own, on a real Postgres)
  // (on a real Postgres other nodes may have pointed the pool elsewhere since: it is pointed back, in line with the nodes)
  if (node === null) {
    if (dbDriver !== "postgres" || current.getStore()) return fn();
    return exclusive(PROCESS_OWN, () => pointPoolAt(baseUrl), fn);
  }
  const inside = current.getStore();
  if (inside) {
    if (inside !== node) throw new Error(`onNode(${node.name}) inside onNode(${inside.name})`);
    return fn();
  }
  return exclusive(node, async () => {
    if (node.database) await pointPoolAt(urlOfDatabase(node.database));
    else (pglite as unknown as Holder).opened = Promise.resolve(node.lite);
  }, fn);
}

function exclusive<T>(node: RealNode, enter: () => Promise<void>, fn: () => Promise<T>): Promise<T> {
  const run = tail.then(() => current.run(node, async () => {
    await enter();
    const outcome = await fn().then((value) => ({ value }), (error: unknown) => ({ error }));
    await awaitAllDispatchers();
    await new Promise((resolve) => setImmediate(resolve)); // a connection is given back one tick after the query that used it
    if (outstanding() > 0 && !("error" in outcome)) throw new Error(`leaving ${node.name} with connections still out; its work is not over:\n${describeOutstanding()}`);
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }));
  tail = run.then(() => undefined, () => undefined);
  return run;
}
