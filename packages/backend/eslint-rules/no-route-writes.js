// Onden custom rule: no-route-writes (depth audit D2)
//
// A route parses the request, calls the domain operation, and answers. The
// write itself — INSERT / UPDATE / DELETE, with the authority, event and
// transaction rules around it — belongs to the service that owns the row
// (services/**, or a module's own service files), so every entry point that
// changes a row goes through one place and the write rules have one owner.
// This is the write-side twin of require-read-gate.js.
//
// Flags any string or template literal in routes/** or modules/*/routes.ts
// that holds an SQL write statement. Template literals are joined with a
// placeholder for their ${…} parts, so `UPDATE ${table} SET` still counts.
//
// ALLOWLIST: route files that may still write, with the reason. It is EMPTY
// and should stay so — move the write into a service instead.

const WRITE_SQL = /\b(INSERT\s+INTO|UPDATE\s+(ONLY\s+)?[\w."]+(\s+(AS\s+)?\w+)?\s+SET|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO)\b/i;

/** rel path (from src/) → reason. Keep empty. */
export const ALLOWLIST = {};

/** Whether `rel` (a path relative to backend/src) is a route file. */
export function isRouteFile(rel) {
  return /^routes\/.+\.ts$/.test(rel) || /^modules\/[^/]+\/routes\.ts$/.test(rel);
}

/** The SQL write in `text`, if any. */
export function sqlWriteIn(text) {
  const m = WRITE_SQL.exec(text);
  return m ? m[0].replace(/\s+/g, " ") : null;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Routes don't write SQL; the service that owns the row does (depth audit D2)." },
    schema: [],
  },
  create(context) {
    const filename = (context.filename || context.getFilename()).replace(/\\/g, "/");
    const m = /[\\/]backend[\\/]src[\\/](.+\.ts)$/.exec(filename);
    if (!m) return {};
    const rel = m[1];
    if (rel.endsWith(".test.ts") || !isRouteFile(rel) || ALLOWLIST[rel]) return {};
    const report = (node, statement) => context.report({
      node,
      message:
        `${rel} writes SQL in a route (${statement}). Move the write into the service that owns the row ` +
        `(services/** or the module's own files) and call it; the route parses, calls and answers. ` +
        `See eslint-rules/no-route-writes.js.`,
    });
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        const statement = sqlWriteIn(node.value);
        if (statement) report(node, statement);
      },
      TemplateLiteral(node) {
        const statement = sqlWriteIn(node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" x "));
        if (statement) report(node, statement);
      },
    };
  },
};
