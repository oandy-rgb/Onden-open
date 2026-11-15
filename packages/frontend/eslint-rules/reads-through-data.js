// Onden custom rule: reads-through-data
//
// Server reads go through the data layer (depth audit D11), like writes do
// (writes-through-data). A component or hook that imports the transport —
// api(), apiFetch(), postRead(), postReadResponse() from lib/api — and builds
// its own /api/... URL owns a copy of that endpoint's shape, its parsing and
// its offline fallback. Flags
//   import { api } from "../lib/api";
// outside the data layer. Use a read from lib/data instead:
//   import { reads } from "../lib/data";
//   const trash = await reads.trash();
// Exempt in eslint.config.js: lib/data/**, lib/api.ts and a documented
// allowlist for boot and auth plumbing. A module's reads are lib/data too
// (reads.modules, lib/data/moduleReads.ts). Type-only imports from lib/api are fine.

const TRANSPORT = new Set(["api", "apiFetch", "postRead", "postReadResponse"]);

function isApiModule(source) {
  return /(^|\/)lib\/api$/.test(source) || source === "./api" || source === "../api";
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Read server data through the data layer (lib/data), not the raw api()/apiFetch() transport" },
    schema: [],
    messages: {
      raw:
        "{{name}}() from lib/api is the data layer's transport. Add a read to lib/data/reads.ts (or use an existing one) " +
        "and call reads.<name>() instead; keep any offline fallback inside the read.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.importKind === "type" || !isApiModule(node.source.value)) return;
        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier" || spec.importKind === "type") continue;
          const name = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
          if (TRANSPORT.has(name)) context.report({ node: spec, messageId: "raw", data: { name } });
        }
      },
    };
  },
};
