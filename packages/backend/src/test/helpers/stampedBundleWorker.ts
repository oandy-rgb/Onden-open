// One node of the two-process change-bundle test (stampedBundleTwoProcess.integration.test.ts): a process with ONE database (DATABASE_URL, or its own PGlite), driven line by line over
// stdin/stdout the way a device is driven by its peer. Each line is {id, cmd, args}; the answer is `@@{id, ok, result | error}` (anything else on stdout is a log line).
//   init                        migrate, take a node id of its own; → {node}
//   world                       build the everyday world and 14 shared notes (this node is the centre); → {ws, owner, spaceA}
//   snapshot                    read the owner's snapshot; → {pages, summary}
//   join {world, cap, name}     fill this empty database from a snapshot, become peer `name`
//   admit {node}                the centre admits a node
//   write {seed, count, aheadMs?}   random writes through the routes (helpers/stampedBundleWorld.ts)
//   have                        what this node holds (the `have` of a request)
//   bundle {have}               the bundle for a receiver that holds `have`
//   apply {bundle, aheadMs?}    take a bundle; → {report} or {refused: code}
//   state                       digest, stamps and heads of the node, as JSON text hashes and the digest
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { getWorkspaceId, migrate } from "../../db.js";
import { ensureOwnNodeId } from "../../browser/nodeIdentity.js";
import { capture, buildSourceWorld, fillFrom } from "./stampedWorld.js";
import { admit, bundleFor, makeRng, markWorld, peerOf, peerStateOf, take, withClockAhead, writeFor, type Peer } from "./stampedBundleWorld.js";
import { readHave } from "../../spine/stampedBundle.js";
import { admitSyncNode } from "../../spine/stampedImport.js";
import { localNodeId } from "../../spine/stamps.js";

let world: { ws: string; owner: never; spaceA: string } | null = null;
let me: Peer | null = null;
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

const commands: Record<string, (args: any) => Promise<unknown>> = {
  async init() {
    await migrate();
    if (process.env.ONDEN_DB_DRIVER === "pglite") await ensureOwnNodeId();
    return { node: await localNodeId() };
  },
  async world() {
    const w = await buildSourceWorld(null);
    world = { ws: w.ws, owner: w.owner as never, spaceA: w.spaceA };
    me = peerOf("A", null, w);
    await markWorld(me);
    await writeFor(me, makeRng(900), 14, { weights: { title: 0, body: 0, move: 0, reorder: 0, trash: 0, undelete: 0, purge: 0, recreate: 0 } });
    return { ws: w.ws, owner: w.owner, spaceA: w.spaceA };
  },
  async snapshot() { const c = await capture(null, { ws: world!.ws, owner: world!.owner }, 12_000); return c; },
  async join(args) {
    world = args.world;
    await fillFrom(null, { ws: args.world.ws, owner: args.world.owner }, args.cap);
    me = peerOf(args.name, null, args.world);
    await markWorld(me); // this process has its own memory: the notes that have rows in tables a bundle does not carry are found again here
    return { ws: world!.ws, node: await localNodeId() };
  },
  async admit(args) { await admitSyncNode(world!.ws, args.node); return {}; },
  async write(args) {
    const run = () => writeFor(me!, makeRng(args.seed), args.count, args.weights ? { weights: args.weights } : {});
    return args.aheadMs ? withClockAhead(args.aheadMs, run) : run();
  },
  async have() { return readHave(world!.ws); },
  async bundle(args) {
    const from = me!;
    const stub = { ...from } as Peer;
    // read as the owner in one snapshot, as services/stampedBundle.ts does
    const { readChangeBundle } = await import("../../services/stampedBundle.js");
    const { bundleOf } = await import("../../spine/stampedBundle.js");
    void stub;
    return bundleOf(JSON.parse(JSON.stringify(await readChangeBundle(from.owner, from.ws, args.have))));
  },
  async apply(args) {
    const { applyChangeBundle } = await import("../../spine/stampedImport.js");
    const run = () => applyChangeBundle(world!.ws, args.bundle);
    try {
      const report = await (args.aheadMs ? withClockAhead(args.aheadMs, run) : run());
      return { report: { stored: report.stored, created: report.created, removed: report.removed, rejected: report.rejected.length, advanced: report.advanced } };
    } catch (e) { return { refused: (e as { code?: string }).code ?? String(e) }; }
  },
  async rows() {
    const { rowsOf } = await import("./stampedWorld.js");
    return (await rowsOf(null, { ws: world!.ws, owner: world!.owner })).content_nodes;
  },
  async rowinfo(args) {
    const { q } = await import("../../db.js");
    return { stamps: (await q(`SELECT field, origin, seq::text, hlc_wall::text FROM sync_stamps WHERE row_key LIKE $1 AND table_name = 'content_nodes' ORDER BY field`, [`${args.id}%`])).rows, row: (await q(`SELECT id::text, title, updated_at, created_at FROM content_nodes WHERE id::text LIKE $1`, [`${args.id}%`])).rows, node: await localNodeId() };
  },
  async state() {
    const s = await peerStateOf(me!);
    return { digest: s.digest, stamps: hash(s.stamps), heads: hash(s.heads), conflicts: s.conflicts.length, ws: await getWorkspaceId() };
  },
};
void admit; void bundleFor; void take;

const rl = createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0)); // the test ended (or died): this process and its database go with it
rl.on("line", (line) => {
  const { id, cmd, args } = JSON.parse(line) as { id: number; cmd: string; args: unknown };
  commands[cmd]!(args).then(
    (result) => process.stdout.write(`@@${JSON.stringify({ id, ok: true, result })}\n`),
    (error) => process.stdout.write(`@@${JSON.stringify({ id, ok: false, error: String((error as Error)?.stack ?? error) })}\n`));
});
