// Build time, on Node: the database a browser's first open starts from — every migration applied, the one local
// account made — written as a gzip tar (PGlite dumpDataDir). The browser then skips 150+ migrations (≈ 4 s) and
// loads this instead. `tsx src/browser/prepareSnapshot.ts <out.tar.gz>` (scripts/build-browser.mjs runs it).
import { writeFile } from "node:fs/promises";
import { setEnvironment } from "../config.js";

setEnvironment({
  NODE_ENV: "production",
  ONDEN_DB_DRIVER: "pglite",
  ONDEN_PGLITE_DIR: "memory://",
  BETTER_AUTH_SECRET: "build-time-only-never-used-to-sign-a-session",
  BETTER_AUTH_URL: "http://localhost",
  LOG_LEVEL: "warn",
});

const out = process.argv[2];
if (!out) throw new Error("usage: prepareSnapshot.ts <out.tar.gz>");

const { migrate, pglite } = await import("../db.js");
const { auth } = await import("../auth.js");
const { backfillModuleImports } = await import("../modules/index.js");
const { LOCAL_ACCOUNT } = await import("./localSession.js");

await migrate({ seedNativeActor: false });
await (await auth.$context).runMigrations();
await backfillModuleImports();
await auth.api.signUpEmail({ body: { ...LOCAL_ACCOUNT } });

// Modules that need a network or a server are off from the start: nothing of them shows, runs or writes
// (the library's own gate answers a write with module_not_imported). AI, RSS, the website and semantic search are
// confirm-once modules and already wait for a yes the browser app never asks.
const { q } = await import("../db.js");
await q(`UPDATE workspaces SET modules_off = $1::jsonb`, [JSON.stringify(["skills", "external_calendars"])]);

// Last: every copy starts from this file, so what it holds is stamped as genesis and it carries no node id
// (browser/nodeIdentity.ts).
const identity = await import("./nodeIdentity.js");
await identity.stampPackagedRowsAsGenesis();
await identity.forgetNodeId();

const database = await pglite!.database();
const dump = await database.dumpDataDir("gzip");
await writeFile(out, Buffer.from(await dump.arrayBuffer()));
process.stdout.write(`snapshot: ${(dump.size / 1024 / 1024).toFixed(2)} MiB → ${out}\n`);
await pglite!.end();
process.exit(0);
