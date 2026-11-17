// One half of the two-process snapshot round trip (stampedSnapshotTwoProcess.integration.test.ts). It runs as a process of its own
// with ONE database (DATABASE_URL), the way two real devices do, and is started with `npx tsx`:
//   export <out.json>              build the everyday world in this database, read its snapshot (the service and GET /api/snapshot),
//                                   and write the stream, the source's digest and its own row-by-row reading
//   import <export.json> <out.json> fill this empty database through POST /api/snapshot, then write what it holds the same two ways
//   refuse <cases.json> <out.json>  one empty database, a list of damaged copies tried one after the other: for each, how it was refused
//                                   and whether anything of the workspace was left behind
//   shells <out.json>               a fresh database (before and after its first sign-in) is an empty shell; then every kind of thing a person puts
//                                   in a database (helpers/stampedShellCases.ts), one at a time and rolled back, makes it not empty
//   half <out.json>                 a person signs in, a join starts, one page is applied, and the process is killed (SIGKILL; PGlite: just ends)
//   boot <out.json>                 the next start of that database: what it holds now, and whether a write is accepted
// The route gates (the ticket, the first line, the readiness probe) are answered inside these modes, on the engine of the run: export (`gates`), import
// (`shape`, `readyBefore`, `joinedProbe`, `foreign`), shells (`readiness`, a `probe` per case) and half (`running`).
// The two ways are independent: the digest (hashes of what the snapshot code reads) and the rows and stamps read back as JSON.
import { readFileSync, writeFileSync } from "node:fs";
import { getWorkspaceId, migrate, q, withSavepoint, withTransaction } from "../../db.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { stampTransaction } from "../../spine/stamps.js";
import { abandonJoin, applyJoinPage, databaseJoinReadiness, startJoin } from "../../services/stampedJoin.js";
import { FRESH_PROOF_HEADER } from "../../services/freshProof.js";
import { ticketWithoutEvidence } from "./freshProofTicket.js";
import { markJoinDone, mergeUnitsIntoWorkspace } from "../../spine/stampedImport.js";
import { readUnit } from "../../spine/stampedMerge/dbUnits.js";
import { conflictsOf } from "../../spine/stampedMerge/unit.js";
import type { StampedPage, TableDigest } from "../../spine/snapshotSql.js";
import type { ActorCtx } from "../../types.js";
import { ensureOwnNodeId } from "../../browser/nodeIdentity.js";
import { persistActor } from "./persistActor.js";
import { seedQ } from "./seedQ.js";
import { buildSourceWorld, capture, digestAs, exportAs, fillFrom, headsOfWorkspace, makeCaller, notCarriedOnPurpose, outOfScopeIds, rowsOf, snapshotApp, stampsOfWorkspace } from "./stampedWorld.js";
import { independentRowHashes } from "./stampedRowHashes.js";

const [mode, first, second] = process.argv.slice(2);

/** Migrate, and give this process's database an identity of its own: PGlite processes all start from one template, and a copy of it
 *  is "the same node" until it takes an id (the browser's start does this; a Postgres database made its id when it was built). */
async function start(): Promise<void> {
  await migrate();
  if (process.env.ONDEN_DB_DRIVER === "pglite") await ensureOwnNodeId();
}


type GateAnswer = { status: number; error: string | null };
/** GET /api/snapshot as `actor`, with `ticket` in its header when there is one: the status, and the refusal's code. */
async function getSnapshot(actor: ActorCtx | null, ticket?: string): Promise<GateAnswer> {
  const res = await snapshotApp(actor).request("/api/snapshot", { headers: ticket ? { [FRESH_PROOF_HEADER]: ticket } : {} });
  if (res.status === 200) { await res.text(); return { status: 200, error: null }; }
  return { status: res.status, error: ((await res.json()) as { error: string }).error };
}
const unspent = async (actor: ActorCtx) => (await q<{ used_at: string | null }>(`SELECT used_at FROM fresh_proofs WHERE actor_id = $1`, [actor.id])).rows.map((r) => r.used_at === null);
async function readinessRoute(actor: ActorCtx | null): Promise<unknown> {
  return (await snapshotApp(actor).request("/api/snapshot/readiness")).json();
}
const counts = async () => Object.fromEntries(await Promise.all(["sync_join", "workspaces", "content_nodes", "sync_stamps", "actors", "domain_events", "fresh_proofs"].map(async (t) => [t, (await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`)).rows[0]!.n] as const)));

/** What the ticket gate of GET /api/snapshot does (services/freshProof.ts says what a ticket is; the answers are checked in stampedSnapshotTwoProcess.integration.test.ts). */
async function gateCases(world: Awaited<ReturnType<typeof buildSourceWorld>>) {
  const noTicket = await getSnapshot(world.owner);
  const ticket = await ticketWithoutEvidence(world.owner);
  const spent = await getSnapshot(world.owner, ticket);
  const again = await getSnapshot(world.owner, ticket);
  const unknown = await getSnapshot(world.owner, "not-a-ticket");
  const old = await ticketWithoutEvidence(world.owner);
  await q(`UPDATE fresh_proofs SET expires_at = now() - interval '1 second' WHERE actor_id = $1 AND used_at IS NULL`, [world.owner.id]);
  const expired = await getSnapshot(world.owner, old);
  const friendTicket = await ticketWithoutEvidence(world.friend);
  const friend = await getSnapshot(world.friend, friendTicket);
  const friendUnspent = await unspent(world.friend);
  const token = await getSnapshot({ ...world.owner, tokenScope: { access: "read", allowedTools: [], tokenId: "t" } as never }, await ticketWithoutEvidence(world.owner));
  const ownerTicket = await ticketWithoutEvidence(world.owner);
  const ownerTicketAsFriend = await getSnapshot(world.friend, ownerTicket);
  const ownerAfterFriend = await getSnapshot(world.owner, ownerTicket);
  return { noTicket, spent, again, unknown, expired, friend, friendUnspent, token, ownerTicketAsFriend, ownerAfterFriend, readiness: { owner: await readinessRoute(world.owner), friend: (await snapshotApp(world.friend).request("/api/snapshot/readiness")).status } };
}

async function exportHalf(out: string): Promise<void> {
  await start();
  const world = await buildSourceWorld(null);
  // Rows nothing has stamped (what a boot seed leaves): the export stamps them as genesis, and the copy still matches. Made here by taking
  // away the stamps of the workspace row and of one space.
  const unstamped = (await q(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND (table_name = 'workspaces' OR (table_name = 'spaces' AND row_key = $2)) RETURNING table_name`, [world.ws, world.spaceA])).rows.length;
  // One unit with two heads (migration 205): a note written here, and a value it had before stamps that this write never saw (the merge keeps it as a head).
  const root = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = 'Grandchild'`, [world.ws])).rows[0]!.id;
  await world.call("PATCH", `/api/nodes/${root}`, { title: "Grandchild, written here" });
  const merged = await mergeUnitsIntoWorkspace(world.ws, [{ address: { table: "content_nodes", row: root, field: "title" }, unit: [{ stamp: { origin: "genesis", seq: 0, wall: 0, counter: 0, author: null, device: null }, saw: {}, deleted: false, value: "Grandchild, from a backup" }] }]);
  if (merged.events[0]?.result.outcome !== "conflict") throw new Error("the source world has no unit with two heads");
  const cap = await capture(null, world, 12_000);
  const res = await exportAs(world.owner);
  if (res.status !== 200) throw new Error(`GET /api/snapshot answered ${res.status}`);
  const stream = await res.text();
  const hidden = await outOfScopeIds(null, world);
  writeFileSync(out, JSON.stringify({
    world: { ws: world.ws, owner: world.owner, secretNote: world.secretNote }, headNote: root,
    summary: cap.summary, unstamped, pages: cap.pages.length, stream, hidden, pagesRaw: cap.pages, gates: await gateCases(world),
    rows: await rowsOf(null, world), stamps: await stampsOfWorkspace(null, world, hidden), heads: await headsOfWorkspace(null, world),
    // WHOLE tables, hashed by SQL that does not use the digest or the snapshot's selection: what the receiver may lack is only what is left out on purpose
    wholeTables: await independentRowHashes(notCarriedOnPurpose(world)),
    // a second export after one edit: pages of two exports mixed are refused
    second: await (async () => {
      await world.call("PATCH", `/api/nodes/${firstRootId(cap.pages)}`, { title: "Edited between the two exports" });
      const again = await capture(null, world, 12_000);
      return { pages: again.pages, summary: again.summary };
    })(),
  }));
}

function firstRootId(pages: StampedPage[]): string {
  for (const p of pages) for (const i of p.items) if (i.kind === "row" && i.table === "content_nodes" && i.values.title === "Root") return String(i.values.id);
  throw new Error("no Root note");
}

type Case = { name: string; direct?: boolean; pages: StampedPage[]; summary: { source: string; former: Record<string, number>; cut: number; pages: number; digest: TableDigest[] } };

async function refuseHalf(from: string, out: string): Promise<void> {
  await start();
  const input = JSON.parse(readFileSync(from, "utf8")) as { world: { ws: string; owner: { id: string; name: string; type: "human" } }; cases: Case[] };
  const world = { ws: input.world.ws, owner: input.world.owner as unknown as Parameters<typeof fillFrom>[1]["owner"] };
  const results: unknown[] = [];
  for (const c of input.cases) {
    let refusal: { code: string | null; message: string } | null = null;
    try {
      if (c.direct) {
        // the pages are applied one by one (a page that cannot be applied is skipped), then the finish is asked for on its own
        await startJoin({ workspaceId: world.ws, sourceNode: c.summary.source, cutSeq: c.summary.cut, personActorId: world.owner.id });
        for (const page of c.pages) await applyJoinPage(page).catch(() => undefined);
        await markJoinDone(world.ws, { pages: c.summary.pages, digest: c.summary.digest }, null);
      } else await fillFrom(null, world, { pages: c.pages, summary: c.summary });
    } catch (e) {
      refusal = { code: (e as { code?: string }).code ?? null, message: String((e as Error).message) };
      if (c.direct) await abandonJoin(world.ws);
    }
    const left: Record<string, string> = {};
    for (const table of ["workspaces", "content_nodes", "spaces", "actors", "sync_stamps", "sync_clock", "sync_join"]) {
      left[table] = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${table === "workspaces" ? "id" : "workspace_id"} = $1`, [world.ws])).rows[0]!.n;
    }
    results.push({ name: c.name, refusal, left });
  }
  writeFileSync(out, JSON.stringify(results));
}

async function importHalf(from: string, out: string): Promise<void> {
  await start();
  const source = JSON.parse(readFileSync(from, "utf8")) as { world: { ws: string; owner: { id: string; name: string; type: "human" } }; headNote: string; stream: string; hidden: string[] };
  const ws = await getWorkspaceId();
  // the one local person of an empty database: the owner of it, with the sign-in of this device
  const local = await persistActor(ws, { id: "", name: "Local", role: "admin", type: "human" });
  await seedQ(`UPDATE actors SET external_id = 'login-of-local' WHERE id = $1`, [local.id]);
  // The first line names the data shape: a file with none, another one, or one that is not a number is refused at that line, before a join starts.
  const lines = source.stream.trim().split("\n");
  const hello = JSON.parse(lines[0]!) as Record<string, unknown>;
  const withHello = (edit: (h: Record<string, unknown>) => void) => { const h = { ...hello }; edit(h); return [JSON.stringify(h), ...lines.slice(1)].join("\n") + "\n"; };
  const post = async (body: string): Promise<GateAnswer> => { const r = await snapshotApp(local).request("/api/snapshot", { method: "POST", body }); return { status: r.status, error: ((await r.json()) as { error: string }).error }; };
  const countsBefore = await counts();
  const readyBefore = await readinessRoute(local);
  const shape = {
    none: await post(withHello((h) => { delete h.dataShape; })),
    other: await post(withHello((h) => { h.dataShape = Number(h.dataShape) + 1; })),
    text: await post(withHello((h) => { h.dataShape = String(h.dataShape); })),
    changed: JSON.stringify(await counts()) !== JSON.stringify(countsBefore),
    readyAfter: await readinessRoute(local),
  };
  const res = await snapshotApp(local).request("/api/snapshot", { method: "POST", body: source.stream });
  const answer = await res.json();
  if (res.status !== 200) throw new Error(`POST /api/snapshot answered ${res.status}: ${JSON.stringify(answer)}`);
  const world = { ws: source.world.ws, owner: source.world.owner as never };
  writeFileSync(out, JSON.stringify({
    status: res.status, answer,
    join: (await q(`SELECT state, applied_through FROM sync_join WHERE workspace_id = $1`, [world.ws])).rows,
    digest: await digestAs(null, world.ws, world.owner),
    rows: await rowsOf(null, world), stamps: await stampsOfWorkspace(null, world, source.hidden), heads: await headsOfWorkspace(null, world),
    wholeTables: await independentRowHashes(null),
    node: (await q<{ node_id: string }>(`SELECT node_id FROM sync_node`)).rows[0]!.node_id,
    login: (await q<{ external_id: string | null }>(`SELECT external_id FROM actors WHERE id = $1`, [source.world.owner.id])).rows[0]?.external_id ?? null,
    shape, readyBefore, hello,
    // a device that joined: its probe says so, and it cannot make a file (its rows carry the source's stamps); the ticket is not spent by that refusal
    joinedProbe: await readinessRoute(source.world.owner as never),
    foreign: await (async () => { const answered = await getSnapshot(source.world.owner as never, await ticketWithoutEvidence(source.world.owner as never)); return { ...answered, unspent: await unspent(source.world.owner as never) }; })(),
    // last, because it writes: the receiver goes on as a node of its own, and its write has seen both heads of the unit (the value it was written over and the one from before stamps)
    settled: await (async () => {
      await makeCaller(source.world.owner as never)("PATCH", `/api/nodes/${source.headNote}`, { title: "Grandchild, settled on the copy" });
      const unit = (await readUnit(world.ws, { table: "content_nodes", row: source.headNote, field: "title" }))!;
      return { units: unit.length, conflicts: conflictsOf(unit).length, saw: Object.keys(unit[0]!.saw), headsLeft: (await q(`SELECT 1 FROM sync_stamp_heads WHERE workspace_id = $1 AND row_key = $2`, [world.ws, source.headNote])).rows.length };
    })(),
  }));
}

class RollBack extends Error {}

/** Whether `startJoin` would accept this database now: null when it would, else the code it refuses with. Always rolled back. */
async function askJoin(ws: string, person: string | null): Promise<string | null> {
  let answer: string | null = null;
  try {
    // a savepoint (inside a transaction already) or a transaction: either way what startJoin did is undone when it is left
    await withSavepoint(async () => {
      try { await startJoin({ workspaceId: "00000000-0000-4000-8000-0000000000b1", sourceNode: "50e0e000-0000-4000-8000-0000000000b2" /* a node id that is not this node */, cutSeq: 1, personActorId: person ?? ws, shellPersonId: person }); }
      catch (e) { answer = (e as { code?: string }).code ?? String(e); }
      throw new RollBack();
    });
  } catch (e) { if (!(e instanceof RollBack)) throw e; }
  return answer;
}

/** The first sign-in of a fresh install, the product's own: the person's row, their personal space and the ACTOR_CREATED event. */
async function signIn(login: string) {
  const { actorForSession } = await import("../../services/actors.js");
  return actorForSession({ id: login, name: "Local", email: `${login}@example.test` }, await getWorkspaceId());
}

async function shellsHalf(out: string): Promise<void> {
  await start();
  const { SHELL_CASES } = await import("./stampedShellCases.js");
  const ws = await getWorkspaceId();
  const fresh = { noPerson: await askJoin(ws, null) };
  const person = await signIn("login-of-local");
  // A database built from db/schema.sql (what a fresh deploy is) has none of the rows the early migrations seed (the built-in tags, the Site
  // Config note): a case that needs one makes it, as the install would, and the case is only counted when the database with just that row is
  // still an empty shell (its `baseline`), so a case cannot be refused for the fixture it needed.
  const builtin = new Set(["admin-only", "person", "workspace-config", "meeting", "archive", "book", "project", "task", "page"]);
  const titled = async (title: string) => {
    const found = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2 ORDER BY created_at LIMIT 1`, [ws, title])).rows[0];
    if (found) return found.id;
    if (!builtin.has(title) && title !== "Site Config") throw new Error(`no fixture for ${title}`);
    const system = title === "Site Config";
    return (await q<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES ($1, $2, $3, $4, $5, '', $6) RETURNING id::text`,
      [ws, system ? "system" : "manual", system ? "content" : "class_tag", title, system ? "_workspace_config" : title, system ? defaultSpace : null])).rows[0]!.id;
  };
  const defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
  const systemActor = (await q<{ id: string }>(`SELECT id::text FROM actors WHERE type = 'agent' AND external_id = 'system'`)).rows[0]?.id ?? null;
  const ctx = { ws, caller: person.id, defaultSpace, systemActor, tag: titled, siteConfig: () => titled("Site Config") };
  const withPerson = await askJoin(ws, person.id);
  // the probe (GET /api/snapshot/readiness) on the clean shell: ready, nothing of a person's own held, and nothing changed by asking
  const countsBefore = await counts();
  const readiness = await (async () => {
    const clean = await readinessRoute(person);
    const unchanged = JSON.stringify(await counts()) === JSON.stringify(countsBefore);
    let noLogin: unknown = null;
    try {
      await withTransaction(async () => { await q(`UPDATE actors SET external_id = NULL WHERE id = $1`, [person.id]); noLogin = await readinessRoute(person); throw new RollBack(); });
    } catch (e) { if (!(e instanceof RollBack)) throw e; }
    return { clean, unchanged, noLogin };
  })();
  const results: { name: string; table: string; baseline: string | null; refusal: string | null; probe?: unknown; error?: string }[] = [];
  for (const c of SHELL_CASES) {
    try {
      await withTransaction(async () => {
        // what the case needs to point at (a built-in tag, the Site Config note) is made first; the database with only those is still empty
        const needs = /book|task|siteConfig|tag\(/.test(c.seed.toString());
        if (needs) { await titled("book"); await titled("task"); await titled("Site Config"); await titled("workspace-config"); }
        const baseline = await askJoin(ws, person.id);
        await c.seed(ctx);
        const refusal = await askJoin(ws, person.id);
        results.push({ name: c.name, table: c.reason, baseline, refusal, probe: await databaseJoinReadiness() });
        throw new RollBack();
      });
    } catch (e) { if (!(e instanceof RollBack)) results.push({ name: c.name, table: c.reason, baseline: null, refusal: null, error: String((e as Error).message ?? e) }); }
  }
  // the database is as it was: the same person, one workspace, still accepted
  const after = { persons: (await q<{ n: string }>(`SELECT count(*)::text AS n FROM actors WHERE type = 'human'`)).rows[0]!.n, again: await askJoin(ws, person.id) };
  writeFileSync(out, JSON.stringify({ fresh, withPerson, readiness, results, after }));
}

/** A person signs in, a join starts and one page is applied; then the process dies without giving up. */
async function halfHalf(from: string, out: string): Promise<void> {
  await start();
  const source = JSON.parse(readFileSync(from, "utf8")) as { world: { ws: string; owner: { id: string } }; pagesRaw: StampedPage[]; summary: { source: string; cut: number } };
  const person = await signIn("login-of-local");
  await startJoin({ workspaceId: source.world.ws, sourceNode: source.summary.source, cutSeq: source.summary.cut, personActorId: source.world.owner.id, shellPersonId: person.id });
  await applyJoinPage(source.pagesRaw[0]!);
  // while the workspace is being joined, an ordinary write to it is refused (rolled back whatever happens)
  let write: { status?: number; code?: string } = {};
  try {
    await withTransaction(async () => {
      try { await withEventTransaction(source.world.ws, () => stampTransaction(source.world.ws, source.world.owner.id)); write = { status: 200 }; }
      catch (e) { write = { status: (e as { status?: number }).status, code: (e as { code?: string }).code }; }
      throw new RollBack();
    });
  } catch (e) { if (!(e instanceof RollBack)) throw e; }
  // while it runs, the probe answers anyone with the one fact and nothing else (the shell's owner is gone by now)
  const running = { noOne: await readinessRoute(null), person: await readinessRoute(person) };
  writeFileSync(out, JSON.stringify({ person: person.id, write, running }));
  if (process.env.ONDEN_DB_DRIVER === "pglite") process.exit(0); // an in-memory database cannot outlive its process: see the test
  process.kill(process.pid, "SIGKILL");
}

async function bootHalf(out: string): Promise<void> {
  await start();
  const ws = await getWorkspaceId();
  const people = (await q<{ id: string; external_id: string | null; owner: boolean }>(`SELECT a.id::text, a.external_id, (w.owner_actor_id = a.id) AS owner FROM actors a JOIN workspaces w ON w.id = a.workspace_id WHERE a.type = 'human'`)).rows;
  const state = {
    ws, people, joins: (await q(`SELECT state FROM sync_join`)).rows.length,
    workspaces: (await q<{ n: string }>(`SELECT count(*)::text AS n FROM workspaces`)).rows[0]!.n,
    accepts: await askJoin(ws, people[0]?.id ?? null),
  };
  writeFileSync(out, JSON.stringify(state));
}

try {
  if (mode === "shells" && first) await shellsHalf(first);
  else if (mode === "half" && first && second) await halfHalf(first, second);
  else if (mode === "boot" && first) await bootHalf(first);
  else if (mode === "export" && first) await exportHalf(first);
  else if (mode === "import" && first && second) await importHalf(first, second);
  else if (mode === "refuse" && first && second) await refuseHalf(first, second);
  else throw new Error("usage: export <out.json> | import <export.json> <out.json> | refuse <cases.json> <out.json>");
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
