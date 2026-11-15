// Shared by the benchmark seed and runner: which database may be touched, the
// schema loader for a Postgres without pgroonga / vector, the PRNG.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertDisposableDatabase } from "../../../../scripts/lib/disposableDb.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = resolve(here, "../../db/schema.sql");

export const DEFAULT_BENCH_URL = "postgres://onden:onden@localhost:5432/onden_bench";

/** The connection string the benchmark uses. Never DATABASE_URL on its own:
 *  that one usually names the real database. */
export function benchDatabaseUrl(): string {
  return process.env.BENCH_DATABASE_URL ?? DEFAULT_BENCH_URL;
}

/** Refuses any database whose name does not end in `_bench`: the seed drops and
 *  rewrites everything in it. */
export function assertBenchDatabase(url: string): string {
  return assertDisposableDatabase(url, "bench");
}

export type SchemaSkips = { extensions: string[]; objects: string[] };

/** What the stripped schema leaves out, listed in the PR body and bench-results.json. */
export const SCHEMA_SKIPS: SchemaSkips = {
  extensions: ["pgroonga", "vector"],
  objects: [
    "index content_nodes_pgroonga_idx",
    "index node_embeddings_hnsw",
    "node_embeddings.embedding stored as real[] instead of vector(384)",
    "SET transaction_timeout (Postgres 17 setting)",
  ],
};

/** db/schema.sql without what a plain Postgres 16 cannot load. */
export async function strippedSchemaSql(): Promise<string> {
  const text = await readFile(SCHEMA_PATH, "utf-8");
  return text.split("\n").filter((line) => !line.startsWith("\\") && !line.includes("transaction_timeout")).join("\n")
    .replace(/CREATE EXTENSION IF NOT EXISTS (pgroonga|vector) [^;]*;/g, "")
    .replace(/COMMENT ON EXTENSION (pgroonga|vector) [^;]*;/g, "")
    .replace(/CREATE INDEX content_nodes_pgroonga_idx[^;]*;/, "")
    .replace(/CREATE INDEX node_embeddings_hnsw[^;]*;/, "")
    .replace(/public\.vector\(384\)/g, "real[]");
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(name)}`;
  return u.toString();
}

/** Drops and recreates the (_bench) database and loads the stripped schema. */
export async function recreateBenchDatabase(url: string): Promise<void> {
  const name = assertBenchDatabase(url);
  const admin = new pg.Client({ connectionString: withDatabase(url, "postgres") });
  await admin.connect();
  try {
    const ident = `"${name.replace(/"/g, '""')}"`;
    await admin.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${ident}`);
  } finally { await admin.end(); }
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try { await db.query(await strippedSchemaSql()); } finally { await db.end(); }
}

/** mulberry32: a small seeded PRNG, so the same seed gives the same workspace. */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const hex = (n: number): string => Array.from({ length: n }, () => int(16).toString(16)).join("");
  /** A v4-shaped uuid from the generator. */
  const uuid = (): string => `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + int(4)).toString(16)}${hex(3)}-${hex(12)}`;
  return { next, int, pick, uuid };
}
export type Rng = ReturnType<typeof makeRng>;
