import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Lint-style test for the workspace_id perimeter.
//
// Onden's data model treats `workspace_id` as the single tenancy boundary.
// Every row in the tables listed below carries it. We do NOT enforce the
// boundary with Postgres RLS — that mechanism would not extend to the
// offline sql.js mirror, so a server-only RLS would leave a silent gap.
// Instead, the boundary is enforced by:
//   1. Centralized `getWorkspaceId()` in db.ts (currently single-tenant).
//   2. This lint: every direct query against a workspace-bearing table
//      must visibly anchor to a workspace-scoped identifier — either
//      `workspace_id`, a `node_id` filter (satellite tables inherit via
//      content_nodes FK), an `actor_id` filter (agent_tokens inherits via
//      actors), or a point lookup by primary key (`id = $`). Queries with
//      a fully-dynamic WHERE (`${where…}`) are skipped because static
//      detection can't see through interpolation — those handlers are
//      audited in HTTP integration tests instead.
//
// If a query against a workspace-bearing table is missing every marker,
// either add the missing filter or — for a deliberate cross-workspace
// admin query — add the snippet to ALLOWLIST with a one-line reason.
//
// See db/schema.sql header for the single-tenant assumption rationale.

const WORKSPACE_TABLES = new Set([
  "content_nodes",
  "node_attributes",
  "node_tags",
  "node_edges",
  // (node_tasks dropped by migration 062 — tasks are content_nodes now,
  // linted like every other node query.)
  "domain_events",
  // (collection_schemas dropped by migration 076 — a tag's schema is content_nodes
  // .tag_schema jsonb now, linted like every other node query.)
  "ai_suggestions",
  "publish_snapshots",
  // (rss_items / rss_sources dropped by migration 061 — subscriptions and
  // articles are content_nodes now, linted like every other node query.)
  "actors",
  "agent_tokens",
  "workspace_config",
]);

// Substrings any of which, if present in the SQL, satisfy the lint.
// In order from most-to-least preferred:
//   workspace_id    - canonical, direct boundary
//   node_id         - satellite tables (node_attributes, node_tags, ...) inherit via FK
//   actor_id        - agent_tokens inherits via actors which is workspace-scoped
//   tag_id          - lookups on tags-keyed satellites; tag is workspace-scoped
//   "id ="          - point lookup by primary key (caller had workspace context to obtain id)
//   "${where"       - dynamic WHERE built outside the literal; integration-tested separately
//   pg_catalog      - introspection queries against system tables
const SAFE_MARKERS = [
  "workspace_id",
  "node_id",
  "actor_id",
  "tag_id",
  "id =",
  "id=",
  "${where",
  "pg_catalog",
];

// File-specific allowlist for SQL that is intentionally cross-workspace
// (e.g. admin sweep, retention pruner). Format: { file, snippet, reason }.
const ALLOWLIST: Array<{ file: string; snippet: string; reason: string }> = [
  { file: "src/services/purgedContent.ts", snippet: "WHERE r.hash = ANY($1::text[])",
    reason: "blobs are shared by content across workspaces: a purge keeps a blob any workspace's event still references" },
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(SRC_ROOT, "..");
const DIRS_TO_LINT = ["routes", "services", "modules"];

function walkTs(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

function extractSqlStrings(source: string): string[] {
  // Match backtick template literals containing SQL keywords. Avoids interpolation
  // breakage by treating the literal as a flat string — ${} fragments stay as-is.
  const out: string[] = [];
  const re = /`([^`]*\b(SELECT|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b[^`]*)`/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

function leadingTable(sql: string): string | null {
  // Strip leading SQL comments / whitespace; pick the first FROM / UPDATE /
  // INSERT INTO / DELETE FROM. Subqueries deeper in the string are out of
  // scope for the lint — typical case is the outermost statement.
  const re = /\b(FROM|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+([a-z_]+)/i;
  const m = re.exec(sql);
  return m ? m[2].toLowerCase() : null;
}

function violates(sql: string): boolean {
  for (const marker of SAFE_MARKERS) {
    if (sql.includes(marker)) return false;
  }
  return true;
}

describe("workspace_id boundary — routes/services lint", () => {
  it("every direct query against a workspace-bearing table filters by workspace_id", () => {
    const files: string[] = [];
    for (const dir of DIRS_TO_LINT) walkTs(join(SRC_ROOT, dir), files);
    expect(files.length).toBeGreaterThan(0);

    const violations: Array<{ file: string; table: string; sql: string }> = [];

    for (const file of files) {
      const rel = file.replace(REPO_ROOT + "/", "");
      const source = readFileSync(file, "utf-8");
      const sqls = extractSqlStrings(source);

      for (const sql of sqls) {
        const table = leadingTable(sql);
        if (!table || !WORKSPACE_TABLES.has(table)) continue;
        if (!violates(sql)) continue;
        const allowed = ALLOWLIST.some((e) => e.file === rel && sql.includes(e.snippet));
        if (allowed) continue;
        violations.push({
          file: rel,
          table,
          sql: sql.replace(/\s+/g, " ").trim().slice(0, 180),
        });
      }
    }

    if (violations.length > 0) {
      const lines = violations.map((v) => `  ${v.file}  [${v.table}]\n    ${v.sql}`);
      throw new Error(
        `Found ${violations.length} workspace-boundary violation(s) — SQL against a workspace-bearing table without workspace_id filter:\n${lines.join("\n")}\n\n` +
          `If this query is intentionally cross-workspace (admin sweep, denormalized FK join), add an ALLOWLIST entry with a reason.`,
      );
    }
  });
});
