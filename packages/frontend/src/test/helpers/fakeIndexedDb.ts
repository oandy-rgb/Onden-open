// A fake IndexedDB for tests that run several tabs against ONE disk
// (test/properties/multiTab.property.test.ts).
//
// What it keeps from the real thing, because the multi-tab bugs live there:
//   - every request answers in a LATER task, and only when the test lets it
//     (`io`): which tab's request completes next is a choice of the test;
//   - transactions of one database are serialized like the spec says: a
//     readwrite transaction waits for every earlier one, a readonly one for
//     earlier readwrite ones; a transaction commits (oncomplete) after its
//     last request, and an aborted one leaves nothing behind;
//   - keys are compared as IndexedDB does (numbers < strings < arrays), so the
//     journal's [scope, session, seq] key ranges work;
//   - values are structured-cloned on the way in and out.
// What it leaves out: versions beyond "create the store on first open",
// indexes, cursors, durability hints. Quota is one switch (`full`): while it is on, every put fails as a full disk does.

type Key = number | string | Key[];
const rank = (k: Key): number => typeof k === "number" ? 0 : typeof k === "string" ? 1 : 2;
export function compareKeys(a: Key, b: Key): number {
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "number" || typeof a === "string") return a < (b as typeof a) ? -1 : a > (b as typeof a) ? 1 : 0;
  const bb = b as Key[];
  for (let i = 0; i < Math.min(a.length, bb.length); i++) {
    const c = compareKeys(a[i]!, bb[i]!);
    if (c) return c;
  }
  return a.length - bb.length;
}

export class FakeKeyRange {
  constructor(readonly lower: Key, readonly upper: Key) {}
  static bound(lower: Key, upper: Key): FakeKeyRange { return new FakeKeyRange(lower, upper); }
  includes(key: Key): boolean { return compareKeys(key, this.lower) >= 0 && compareKeys(key, this.upper) <= 0; }
}

type Entry = { key: Key; value: unknown };
type Store = Entry[];
type Database = { version: number; stores: Map<string, Store>; txs: FakeTx[] };

/** One completion the test may run next. `tab` is who asked (for killing). */
export type IoItem = { tab: unknown; run: () => void };

export class FakeIdb {
  readonly databases = new Map<string, Database>();
  /** Completions waiting for the test's scheduler. */
  io: IoItem[] = [];
  /** Who is running: the world supplies it (an AsyncLocalStorage store). */
  currentTab: () => unknown = () => null;
  isDead: (tab: unknown) => boolean = () => false;
  /** Every read, for a test that wants to know who read what (a tab reading the snapshot again). */
  onRead: (tab: unknown, database: string, store: string, key: Key | null) => void = () => {};
  /** Every write: a put or a delete. */
  onWrite: (tab: unknown, database: string, store: string) => void = () => {};
  /** A readwrite transaction of the tab committed. */
  onCommit: (tab: unknown, database: string, store: string) => void = () => {};
  /** Number of readwrite transactions that completed, for the tests' sanity checks. */
  commits = 0;
  /** The disk is full: every put fails (QuotaExceededError) and aborts its transaction. */
  full = false;
  /** Puts refused because the disk was full, by database. */
  refusedPuts = new Map<string, number>();

  later(run: () => void): void {
    const tab = this.currentTab();
    if (this.isDead(tab)) return;
    this.io.push({ tab, run });
  }

  /** Has the tab storage work that has not finished: a request waiting, or an open transaction. */
  hasOutstanding(tab: unknown): boolean {
    if (this.io.some((item) => item.tab === tab)) return true;
    for (const db of this.databases.values()) if (db.txs.some((tx) => tx.owner === tab)) return true;
    return false;
  }

  /** Forget everything a tab asked for. Its open transactions end now. */
  killTab(tab: unknown, commit: boolean): void {
    this.io = this.io.filter((item) => item.tab !== tab);
    for (const db of this.databases.values()) {
      for (const tx of [...db.txs]) if (tx.owner === tab) tx.endForDeadOwner(commit);
    }
  }

  open(name: string, version?: number) {
    const req: { result: unknown; error: unknown; onsuccess: null | (() => void); onerror: null | (() => void); onupgradeneeded: null | (() => void); onblocked: null | (() => void) } =
      { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    this.later(() => {
      let database = this.databases.get(name);
      const created = !database;
      if (!database) { database = { version: version ?? 1, stores: new Map(), txs: [] }; this.databases.set(name, database); }
      const upgrade = created || (version !== undefined && version > database.version);
      if (upgrade && version !== undefined) database.version = version;
      const connection = new FakeConnection(this, database, name);
      req.result = connection;
      if (upgrade) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  }
}

class FakeConnection {
  onversionchange: null | (() => void) = null;
  onclose: null | (() => void) = null;
  constructor(private readonly idb: FakeIdb, private readonly database: Database, readonly name: string) {}
  get version(): number { return this.database.version; }
  get objectStoreNames() {
    return { contains: (store: string) => this.database.stores.has(store) };
  }
  createObjectStore(store: string) { if (!this.database.stores.has(store)) this.database.stores.set(store, []); }
  close(): void {}
  transaction(storeName: string, mode: "readonly" | "readwrite" = "readonly"): FakeTx {
    const store = this.database.stores.get(storeName);
    if (!store) throw new DOMException(`No object store ${storeName}`, "NotFoundError");
    const tx = new FakeTx(this.idb, this.database, store, mode, `${this.name}/${storeName}`);
    this.database.txs.push(tx);
    this.idb.later(() => tx.pump());
    return tx;
  }
}

class FakeTx {
  error: unknown = null;
  oncomplete: null | (() => void) = null;
  onerror: null | (() => void) = null;
  onabort: null | (() => void) = null;
  readonly owner: unknown;
  private queue: Array<() => void> = [];
  private started = false;
  private finished = false;
  private undo: Array<() => void> = [];
  constructor(private readonly idb: FakeIdb, private readonly database: Database, private readonly store: Store, readonly mode: "readonly" | "readwrite", private readonly where: string) {
    this.owner = idb.currentTab();
  }

  /** May this transaction run yet: nothing earlier conflicts with it. */
  private ready(): boolean {
    for (const other of this.database.txs) {
      if (other === this) return true;
      if (other.finished) continue;
      if (this.mode === "readwrite" || other.mode === "readwrite") return false;
    }
    return true;
  }

  pump(): void {
    if (this.finished) return;
    if (!this.started) {
      if (!this.ready()) { this.idb.later(() => this.pump()); return; }
      this.started = true;
    }
    const next = this.queue.shift();
    if (next) { next(); this.idb.later(() => this.pump()); return; }
    this.complete();
  }

  private request<T>(work: () => T) {
    const req: { result: T | undefined; error: unknown; onsuccess: null | (() => void); onerror: null | (() => void) } = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.queue.push(() => {
      try { req.result = work(); } catch (error) { req.error = error; this.abortWith(error); return; }
      req.onsuccess?.();
    });
    return req;
  }

  private complete(): void {
    if (this.finished) return;
    this.finished = true;
    this.database.txs = this.database.txs.filter((tx) => tx !== this);
    if (this.mode === "readwrite") {
      this.idb.commits++;
      const [database, storeName] = this.where.split("/");
      this.idb.onCommit(this.owner, database!, storeName!);
    }
    this.oncomplete?.();
  }

  private abortWith(error: unknown): void {
    if (this.finished) return;
    for (const undo of this.undo.reverse()) undo();
    this.undo = [];
    this.finished = true;
    this.error = error;
    this.database.txs = this.database.txs.filter((tx) => tx !== this);
    this.onabort?.();
  }

  abort(): void { this.abortWith(new DOMException("aborted", "AbortError")); }

  /** The page died: what the transaction already did either stays or goes. */
  endForDeadOwner(commit: boolean): void {
    if (this.finished) return;
    this.finished = true;
    if (!commit) { for (const undo of this.undo.reverse()) undo(); this.undo = []; }
    else if (this.mode === "readwrite") this.idb.commits++;
    this.database.txs = this.database.txs.filter((tx) => tx !== this);
  }

  objectStore(_name: string) {
    const find = (key: Key) => this.store.findIndex((e) => compareKeys(e.key, key) === 0);
    return {
      get: (key: Key) => this.request(() => {
        const [database, storeName] = this.where.split("/");
        this.idb.onRead(this.owner, database!, storeName!, key);
        const i = find(key);
        return i < 0 ? undefined : structuredClone(this.store[i]!.value);
      }),
      getAll: (range?: FakeKeyRange) => this.request(() => {
        const [database, storeName] = this.where.split("/");
        this.idb.onRead(this.owner, database!, storeName!, null);
        return this.store.filter((e) => !range || range.includes(e.key)).map((e) => structuredClone(e.value));
      }),
      put: (value: unknown, key: Key) => this.request(() => {
        if (this.mode !== "readwrite") throw new DOMException("read-only transaction", "ReadOnlyError");
        if (this.idb.full) {
          const database = this.where.split("/")[0]!;
          this.idb.refusedPuts.set(database, (this.idb.refusedPuts.get(database) ?? 0) + 1);
          throw new DOMException("the disk is full", "QuotaExceededError");
        }
        const [database, storeName] = this.where.split("/");
        this.idb.onWrite(this.owner, database!, storeName!);
        const stored = structuredClone(value);
        const i = find(key);
        if (i >= 0) { const before = this.store[i]!.value; this.store[i]!.value = stored; this.undo.push(() => { const j = find(key); if (j >= 0) this.store[j]!.value = before; }); }
        else {
          this.store.push({ key, value: stored });
          this.store.sort((a, b) => compareKeys(a.key, b.key));
          this.undo.push(() => { const j = find(key); if (j >= 0) this.store.splice(j, 1); });
        }
        return key;
      }),
      delete: (target: Key | FakeKeyRange) => this.request(() => {
        if (this.mode !== "readwrite") throw new DOMException("read-only transaction", "ReadOnlyError");
        const [database, storeName] = this.where.split("/");
        this.idb.onWrite(this.owner, database!, storeName!);
        const gone = this.store.filter((e) => target instanceof FakeKeyRange ? target.includes(e.key) : compareKeys(e.key, target) === 0);
        for (const e of gone) {
          this.store.splice(this.store.indexOf(e), 1);
          this.undo.push(() => { this.store.push(e); this.store.sort((a, b) => compareKeys(a.key, b.key)); });
        }
        return undefined;
      }),
    };
  }
}
