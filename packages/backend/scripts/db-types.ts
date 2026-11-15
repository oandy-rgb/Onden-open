// npm run db:types — migrates an empty in-memory PGlite and writes src/dbSchema.generated.ts.
// `--out <file>` writes there instead (the guard test compares it with the committed file; stdout carries migrate logs).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.ONDEN_DB_DRIVER = "pglite";
process.env.ONDEN_PGLITE_DIR = "memory://";
delete process.env.ONDEN_PGLITE_SNAPSHOT;

const { migrate, pool } = await import("../src/db.js");
const { generateDbTypes } = await import("../src/test/dbTypesGenerator.js");
await migrate({ seedNativeActor: false });
const text = await generateDbTypes();
const outIndex = process.argv.indexOf("--out");
writeFileSync(outIndex >= 0 ? process.argv[outIndex + 1]! : fileURLToPath(new URL("../src/dbSchema.generated.ts", import.meta.url)), text);
await pool.end();
