// The typed query builder: `db` is Kysely<DB> whose driver hands every statement to db.ts q().
// So `db` joins the open withTransaction()/mutate() transaction exactly as q() does (and uses the pool
// outside one), runs on real Postgres and PGlite alike, and every check that wraps q() has one place.
// Row types come from dbSchema.generated.ts; after a migration run `npm run db:types`.
// How to write a query: docs/architecture/portable-backend.md §9 "怎麼寫新查詢".
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from "kysely";
import { q } from "./db.js";
import type { DB } from "./dbSchema.generated.js";

class QConnection implements DatabaseConnection {
  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const { rows, rowCount } = await q(query.sql, [...query.parameters]);
    return { rows: rows as R[], ...(rowCount === null ? {} : { numAffectedRows: BigInt(rowCount) }) };
  }
  // eslint-disable-next-line require-yield
  async *streamQuery(): AsyncIterableIterator<never> {
    throw new Error("db.stream() is not supported: q() returns whole result sets");
  }
}

const connection = new QConnection();

/** One shared connection object: which client runs a statement is decided per call by q(), not by the driver. */
class QDriver implements Driver {
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> { return connection; }
  async beginTransaction(): Promise<void> {
    throw new Error("db.transaction() is not supported: open the transaction with withTransaction() or mutate(); db joins it");
  }
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

export const qDialect: Dialect = {
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => new QDriver(),
  createIntrospector: (kysely) => new PostgresIntrospector(kysely),
  createQueryCompiler: () => new PostgresQueryCompiler(),
};

/** Typed SQL for every table. `await db.selectFrom("workspaces").select("id").where("slug", "=", "default").executeTakeFirst()`.
 *  Inside withTransaction()/mutate() it runs in that transaction; elsewhere on the pool. */
export const db = new Kysely<DB>({ dialect: qDialect });
