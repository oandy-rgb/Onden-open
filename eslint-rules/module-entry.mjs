// Onden custom rule: module-entry
//
// A directory one level below a layer (src/modules/website/publishing/, src/lib/data/,
// src/modules/rss/, src/components/collections/) is a module. Code outside it
// imports the directory itself (its index), never a file inside it, so the
// module can change what it hides without its callers noticing. Files inside
// the module import each other freely; flat files (src/lib/api.ts) are their
// own entry.
//
// Imports that broke this before the rule existed are listed in the package's
// eslint-rules/module-entry-allowlist.json as { importer: [target, ...] },
// paths relative to src/ without extension. Remove an entry when you fix it;
// never add one. Tests are exempt in the eslint configs.
//
// Shared by packages/backend and packages/frontend (see their eslint.config.js).

import { dirname, relative, resolve, sep } from "node:path";

/** The module directory `target` sits inside, if `importer` reaches into it
 *  past its entry; null when the import is allowed. Paths relative to src/. */
export function reachedModule(importer, target) {
  const parts = target.split("/");
  if (parts.length < 3) return null;            // a layer file or a module's directory itself
  const moduleDir = `${parts[0]}/${parts[1]}`;
  if (importer.startsWith(`${moduleDir}/`)) return null;
  if (parts.length === 3 && parts[2] === "index") return null;
  return moduleDir;
}

/** `spec` imported from `file`, relative to `src`, without extension; null
 *  for a package import. */
export function resolveImport(src, file, spec) {
  if (!spec.startsWith(".")) return null;
  const abs = resolve(dirname(file), spec).replace(/\.(js|mjs|ts|tsx)$/, "");
  const rel = relative(src, abs).split(sep).join("/");
  return rel.startsWith("..") ? null : rel;
}

export const stripExt = (path) => path.replace(/\.(ts|tsx)$/, "");

export default {
  meta: {
    type: "problem",
    docs: { description: "Import a module directory through its entry, not a file inside it" },
    schema: [{
      type: "object",
      properties: { src: { type: "string" }, allow: { type: "object" } },
      required: ["src"],
      additionalProperties: false,
    }],
    messages: {
      internal:
        "{{target}} is inside the module {{module}}/ — import {{module}} (its index) instead. " +
        "If the entry lacks what you need, add it there. See eslint-rules/module-entry.mjs.",
    },
  },
  create(context) {
    const { src, allow = {} } = context.options[0];
    const importer = stripExt(relative(src, context.filename).split(sep).join("/"));
    const allowed = new Set(allow[importer] ?? []);
    function check(node, source) {
      if (!source || typeof source.value !== "string") return;
      const target = resolveImport(src, context.filename, source.value);
      if (!target || allowed.has(target)) return;
      const module = reachedModule(importer, target);
      if (module) context.report({ node, messageId: "internal", data: { target, module } });
    }
    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
    };
  },
};
