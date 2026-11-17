// Who holds a database connection right now, in a test process that switches between nodes (realNode.ts onNode).
// A node's work is over when every connection its requests took has been given back. A connection still out when the test moves to
// another node is work the previous node started and did not wait for; this ledger says which: the stack that took it and the last SQL it ran.
// It wraps `connect` of the one handle db.ts makes (a pg.Pool, or the PglitePool) and nothing else: no product code is touched.
type Holder = { stack: string; lastSql: string; since: number };
type Releasable = { release: (err?: unknown) => void; query: (...args: any[]) => unknown };
type Connectable = { connect: (...args: any[]) => any };

const holders = new Map<Releasable, Holder>();
const patched = new WeakSet<object>();
const queryPatched = new WeakSet<object>();

function note(client: Releasable): Releasable {
  const holder: Holder = { stack: new Error().stack!.split("\n").filter((l) => !l.includes("connectionLedger")).slice(1, 14).join("\n"), lastSql: "(none yet)", since: Date.now() };
  holders.set(client, holder);
  if (!queryPatched.has(client)) {
    queryPatched.add(client);
    const query = client.query.bind(client);
    client.query = (...args: any[]) => {
      const first = args[0];
      const held = holders.get(client);
      if (held) held.lastSql = String(typeof first === "string" ? first : first?.text ?? "").replace(/\s+/g, " ").slice(0, 200);
      return query(...args);
    };
  }
  const release = client.release.bind(client);
  client.release = (err?: unknown) => { holders.delete(client); release(err); };
  return client;
}

/** Start recording on `handle` (once per handle). */
export function trackConnections(handle: Connectable): void {
  if (patched.has(handle)) return;
  patched.add(handle);
  const connect = handle.connect.bind(handle);
  handle.connect = (...args: any[]) => {
    if (typeof args[0] === "function") { // pg-pool's callback form (pool.query uses it)
      const done = args[0];
      return connect((err: unknown, client: Releasable, release: unknown) => done(err, client && note(client), release));
    }
    return Promise.resolve(connect(...args)).then(note);
  };
}

export const outstanding = (): number => holders.size;

/** A readable list of what still holds a connection (for the error that says the previous node left work behind). */
export function describeOutstanding(): string {
  return [...holders.values()].map((h) => `held for ${Date.now() - h.since} ms; last SQL: ${h.lastSql}\n${h.stack}`).join("\n---\n");
}
