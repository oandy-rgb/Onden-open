// Onden custom rule: writes-through-data
//
// A write (POST/PUT/PATCH/DELETE) sent with a raw api()/apiFetch()/fetch()
// call skips what the data layer gives every write: an Idempotency-Key (a
// retried request applies once), the offline queue where it applies, ordering
// with queued edits, and the shared failure messages. Flags
//   api(path, { method: "PATCH", ... })
//   apiFetch(path, { method: "POST", ... })
// outside the data layer. Use instead:
//   - sendWrite(method, path, body)       lib/data/onlineWrite (online write)
//   - submitWrite / sendOrQueue            lib/data/writeQueue (offline-safe)
//   - a domain writer (noteWriter, taskWriter, …) or uploadMedia
//   - postRead / postReadResponse          lib/api (a POST that changes nothing)
// The data layer itself (lib/data, lib/api, the sync engine) is exempt in
// eslint.config.js.

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CALLEES = new Set(["api", "apiFetch", "fetch"]);

function methodOf(objectExpression) {
  for (const prop of objectExpression.properties) {
    if (prop.type !== "Property") continue;
    const key = prop.key.type === "Identifier" ? prop.key.name : prop.key.value;
    if (key !== "method") continue;
    const v = prop.value;
    if (v.type === "Literal" && typeof v.value === "string") return v.value.toUpperCase();
    if (v.type === "TemplateLiteral" && v.expressions.length === 0) return v.quasis[0].value.cooked.toUpperCase();
  }
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Send writes through the data layer (lib/data), not raw api()/apiFetch()" },
    schema: [],
    messages: {
      raw:
        "{{method}} through a raw {{callee}}() skips the data layer (Idempotency-Key, offline queue, write order, failure messages). " +
        "Use sendWrite() from lib/data/onlineWrite, a domain writer, uploadMedia(), or postRead() for a POST that changes nothing.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || !CALLEES.has(node.callee.name)) return;
        const init = node.arguments[1];
        if (!init || init.type !== "ObjectExpression") return;
        const method = methodOf(init);
        if (method && WRITE_METHODS.has(method)) {
          context.report({ node, messageId: "raw", data: { method, callee: node.callee.name } });
        }
      },
    };
  },
};
