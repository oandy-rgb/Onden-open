// F3.2 — Bases filter evaluator: the ONE copy, shared by the app (frontend
// lib/basesEval.ts, which supplies its link and system-node rules) and the
// server, which evaluates an `onden-base` block when a note is published or
// exported (D113, backend modules/website/publishing/queryBlocks.ts).
//
// SECURITY NOTE — presentational only.
//   This evaluator filters rows the CALLER already decided to release.
//   It does not, and must not, enforce permission boundaries. Predicates
//   read fields off BaseEvalNode that the caller populated; some callers
//   (BaseRenderer) run in the browser, so a user with DevTools can set
//   `recent_actors: ["admin"]` on the node objects the renderer sees.
//   Never use file.modifiedBy / file.lastActor / file.eventsSince to
//   decide what a viewer is allowed to see. Backend permission checks
//   (readPolicy) are the trust boundary.
//
// Evaluates a parsed BaseSpec against a node set, returning the rows that
// pass every layer of filter (global + per-view). Filter EXPRESSIONS (the
// leaf strings like `file.hasTag("X")`) are parsed lazily here — the
// supported subset is small enough that a hand-rolled scanner beats
// embedding a full expression engine.
//
// Supported leaf shape (MVP):
//   file.hasTag("X")        — node is a member of a tag named X (case-insensitive):
//                             tagged with it, a child tag or a tag extending it
//                             (BaseEvalContext.tagMembers), as the backend counts it
//   file.hasLink("X")       — BaseEvalContext.linksTo decides (the app: one of
//                             the node's wikilinks reaches a note named X, or
//                             names X while X is no note it reaches)
//   file.inFolder("X")      — always false (no folder model in Onden)
//   note.KEY == "V"         — frontmatter KEY equals V
//   KEY == "V"              — shorthand for note.KEY == V
//   KEY != "V"              — negation
//   KEY > 5, KEY >= "2026-10-01", …
//                           — the attribute value rule (D49): typed by the
//                             value's storage type (value_types) as the
//                             server's filters and sorts read it
//                             (compareAttribute / compareAttributeOrder); an
//                             unquoted 5 is a number, a quoted "5" text
//   true / false            — literal
//
// Compound shapes (and / or / not) come from the parsed FilterNode tree.

import { ATTRIBUTE_KEY } from "./attributeKey.js";
import {
  compareAttribute, compareAttributeOrder, inferFromValue, serializeValue,
  type AttributeComparison, type AttributeValueType,
} from "./attributeValue.js";
import { wikilinkBodies } from "./text.js";
import type { BaseSpec, FilterNode, ViewDef } from "./basesParser.js";

// `note.KEY <op> <value>`: KEY in the one attribute key grammar (D44,
// attributeKey.ts), so `作者 == "王"` and `reading-list == "x"` compare. A key
// can't hold a blank, `=`, `!`, `<` or `>`, so it ends at the operator.
const KEY_COMPARISON_RE = new RegExp(String.raw`^(?:note\.)?(${ATTRIBUTE_KEY})\s*(==|!=|>=|<=|>|<)\s*("[^"]*"|'[^']*'|-?\d+(?:\.\d+)?)$`, "u");
const HAS_TAG_RE = [/^file\.hasTag\(\s*"([^"]*)"\s*\)$/, /^file\.hasTag\(\s*'([^']*)'\s*\)$/];

export type BaseEvalNode = {
  id: string;
  title: string;
  markdown: string;
  node_type: string;
  /** The note's space: file.hasLink resolves its links within it, as the
   *  server's wikilink edges do. Undefined = unknown (not filtered). */
  space_id?: string | null;
  /** "system" marks machinery (the Site Config note): never a result row. */
  source_type?: string;
  class_tag_names?: string[];     // resolved before eval; basesParser doesn't touch these
  /** The note's tag ids: with BaseEvalContext.tagMembers, file.hasTag counts
   *  child and extending tags too, as the backend's views do. */
  tag_ids?: string[];
  frontmatter?: Record<string, unknown>;
  /** The storage type (node_attributes.value_type) of each frontmatter value.
   *  A key without one is typed by its value: a JS number or boolean as such,
   *  a string by the number/date grammar. */
  value_types?: Record<string, AttributeValueType>;
  /** F3.5 — event-targeting fields. Absent means "treat as unknown"
   *  (predicate returns false). */
  last_actor?: string;
  last_modified_at?: string;
  /** Actor names (not ids) for the recent events touching this node. */
  recent_actors?: string[];
};

/** What the evaluator needs from its host. */
export type BaseEvalContext = {
  /** `this` in a filter (SKILL.md §"The `this` Keyword"): the host note's
   *  title when the base is embedded in a note. */
  thisTitle?: string;
  /** The ids a tag NAME stands for: every tag with that name and their
   *  members. Without it file.hasTag compares the note's own tag names. */
  tagMembers?: (name: string) => ReadonlySet<string>;
  /** file.hasLink(name). Without it no node links anywhere. */
  linksTo?: (node: BaseEvalNode, name: string) => boolean;
  /** System machinery, never a result row. Default: source_type "system". */
  isSystem?: (node: BaseEvalNode) => boolean;
};

function substituteThis(expr: string, thisTitle: string | undefined): string {
  if (!thisTitle) return expr;
  // Replace bare `this` token inside file.X(this) calls. Word-boundary
  // anchored so it doesn't touch identifiers like `thisYear`.
  const q = thisTitle.replace(/"/g, '\\"');
  return expr.replace(/\bthis\b/g, `"${q}"`);
}

function hasTagName(expr: string): string | null {
  for (const re of HAS_TAG_RE) {
    const m = re.exec(expr);
    if (m) return m[1]!;
  }
  return null;
}

function matchesLeaf(node: BaseEvalNode, expr: string, ctx?: BaseEvalContext): boolean {
  const t = substituteThis(expr, ctx?.thisTitle).trim();
  if (t === "true") return true;
  if (t === "false") return false;

  // file.hasTag("X")
  const tag = hasTagName(t);
  if (tag !== null) {
    if (ctx?.tagMembers && node.tag_ids) {
      const members = ctx.tagMembers(tag);
      return node.tag_ids.some((id) => members.has(id));
    }
    const target = tag.toLowerCase();
    return (node.class_tag_names ?? []).some((n) => n.toLowerCase() === target);
  }

  // file.hasLink("X")
  const hasLink = /^file\.hasLink\(\s*"([^"]*)"\s*\)$/.exec(t)
              ?? /^file\.hasLink\(\s*'([^']*)'\s*\)$/.exec(t);
  if (hasLink) return ctx?.linksTo?.(node, hasLink[1]!) ?? false;

  if (/^file\.inFolder\(/.test(t)) return false;

  // F3.5 — Onden-extension predicates.
  // file.modifiedBy("X")
  const modifiedBy = /^file\.modifiedBy\(\s*"([^"]*)"\s*\)$/.exec(t)
                 ?? /^file\.modifiedBy\(\s*'([^']*)'\s*\)$/.exec(t);
  if (modifiedBy) {
    const target = modifiedBy[1]!.toLowerCase();
    return (node.recent_actors ?? []).some((a) => a.toLowerCase() === target);
  }
  // file.eventsSince("YYYY-MM-DD")
  const eventsSince = /^file\.eventsSince\(\s*"([^"]*)"\s*\)$/.exec(t)
                  ?? /^file\.eventsSince\(\s*'([^']*)'\s*\)$/.exec(t);
  if (eventsSince) {
    const after = Date.parse(eventsSince[1]!);
    if (!Number.isFinite(after)) return false;
    if (!node.last_modified_at) return false;
    const ts = Date.parse(node.last_modified_at);
    return Number.isFinite(ts) && ts >= after;
  }
  // file.lastActor == "X" (string equality on a built-in property)
  const lastActorEq = /^file\.lastActor\s*(==|!=)\s*("[^"]*"|'[^']*')$/.exec(t);
  if (lastActorEq) {
    const op = lastActorEq[1];
    const valStr = lastActorEq[2]!.slice(1, -1);
    const eq = (node.last_actor ?? "") === valStr;
    return op === "==" ? eq : !eq;
  }

  // note.KEY <op> <value>   or   KEY <op> <value>
  // Operators: == != > < >= <=   Value: quoted string OR number literal
  const cmpMatch = KEY_COMPARISON_RE.exec(t);
  if (cmpMatch) {
    const rhsRaw = cmpMatch[3]!;
    const rhs = rhsRaw.startsWith('"') || rhsRaw.startsWith("'") ? rhsRaw.slice(1, -1) : Number(rhsRaw);
    const { value, valueType } = attributeOf(node, cmpMatch[1]!);
    return compareAttribute(value, valueType, cmpMatch[2] as AttributeComparison, rhs);
  }

  // Unknown leaf → treat as false so unsupported expressions don't
  // accidentally let everything through.
  return false;
}

/** A node's attribute as the stored string and its storage type. A value the
 *  caller left as a JS number or boolean is serialized and typed by its JS
 *  type; a string without a value_types entry is typed by its grammar
 *  (undefined: the number pattern and the date grammar decide). */
function attributeOf(node: BaseEvalNode, key: string): { value: string | undefined; valueType: string | undefined } {
  const raw = node.frontmatter?.[key];
  if (raw == null) return { value: undefined, valueType: undefined };
  return {
    value: serializeValue(raw),
    valueType: node.value_types?.[key] ?? (typeof raw === "string" ? undefined : inferFromValue(raw)),
  };
}

export function evalFilter(node: BaseEvalNode, filter: FilterNode | undefined, ctx?: BaseEvalContext): boolean {
  if (!filter) return true;
  switch (filter.kind) {
    case "leaf": return matchesLeaf(node, filter.expr, ctx);
    case "and":  return filter.items.every((f) => evalFilter(node, f, ctx));
    case "or":   return filter.items.some((f) => evalFilter(node, f, ctx));
    case "not":  return !filter.items.some((f) => evalFilter(node, f, ctx));
  }
}

/** The tag names `file.hasTag(…)` asks about in the spec and `view` (with
 *  `this` substituted), for a host that resolves tag members ahead of time. */
export function baseTagNames(spec: BaseSpec, view: ViewDef, thisTitle?: string): string[] {
  const names = new Set<string>();
  const walk = (f: FilterNode | undefined): void => {
    if (!f) return;
    if (f.kind === "leaf") {
      const name = hasTagName(substituteThis(f.expr, thisTitle).trim());
      if (name !== null) names.add(name);
      return;
    }
    f.items.forEach(walk);
  };
  walk(spec.filters);
  walk(view.filters);
  return [...names];
}

export function applyView<T extends BaseEvalNode>(nodes: T[], spec: BaseSpec, view: ViewDef, ctx?: BaseEvalContext): T[] {
  // System machinery (the workspace-config tag, source_type='system') is
  // never a result row, whatever the filter says: the backend's /api/query
  // and saved views drop the same rows (spine/reservedNodes).
  const isSystem = ctx?.isSystem ?? ((n: BaseEvalNode) => n.source_type === "system");
  const passed = nodes.filter((n) => !isSystem(n)
    && evalFilter(n, spec.filters, ctx) && evalFilter(n, view.filters, ctx));
  // Ordering / grouping / limit — minimal MVP implementation.
  let ordered = passed;
  if (view.order && view.order.length > 0) {
    const orderKey = view.order[0]!; // sort by first key only for MVP
    const desc = orderKey.startsWith("-");
    const k = desc ? orderKey.slice(1) : orderKey;
    const attr = attributeKey(k);
    ordered = [...passed].sort((a, b) => {
      if (attr !== null) {
        // The attribute value rule, as the server's attribute sort (D49):
        // numbers by value, then dates, then text; missing last.
        const av = attributeOf(a, attr);
        const bv = attributeOf(b, attr);
        return compareAttributeOrder(av.value, av.valueType, bv.value, bv.valueType, desc ? "desc" : "asc");
      }
      const av = pluck(a, k);
      const bv = pluck(b, k);
      if (av < bv) return desc ? 1 : -1;
      if (av > bv) return desc ? -1 : 1;
      return 0;
    });
  }
  if (view.limit !== undefined && view.limit > 0) ordered = ordered.slice(0, view.limit);
  return ordered;
}

// The sort keys pluck reads off the node itself; any other key but a
// formula.X is an attribute.
const BUILT_IN_SORT_KEYS = new Set([
  "file.name", "file.basename", "title", "id", "file.path", "file.folder", "file.ext", "file.size",
  "file.ctime", "file.mtime", "file.tags", "file.links", "file.backlinks", "file.embeds",
]);

/** The attribute a sort key reads (`note.KEY` or a bare KEY), or null for a
 *  built-in file.* property or a formula. */
function attributeKey(key: string): string | null {
  if (BUILT_IN_SORT_KEYS.has(key) || key.startsWith("formula.")) return null;
  return key.startsWith("note.") ? key.slice(5) : key;
}

/** The keys a table view shows as columns (BasesTable): its `order`, or the
 *  title alone. */
export function baseTableColumns(view: ViewDef): string[] {
  return view.order && view.order.length > 0 ? view.order : ["file.name"];
}

/** Whether a table column is the row's title (file.name / title). */
export function isTitleColumn(key: string): boolean {
  return key === "file.name" || key === "title";
}

function pluck(node: BaseEvalNode, key: string): string | number {
  // file.* properties per SKILL.md §"File Properties Reference".
  // Onden has no folder/path/ext/size/embeds model; those return "".
  // file.tags / file.links / file.backlinks are lists in Bases; for sort
  // purposes we collapse them to a comma-joined string so ordering is
  // deterministic without surfacing a List-typed sort key.
  switch (key) {
    case "file.name":
    case "file.basename":
    case "title":
      return node.title;
    case "id":
      return node.id;
    case "file.path":
    case "file.folder":
    case "file.ext":
      return "";
    case "file.size":
      return node.markdown.length;
    case "file.ctime":
    case "file.mtime":
      return node.last_modified_at ?? "";
    case "file.tags":
      return (node.class_tag_names ?? []).join(",");
    case "file.links":
      return wikilinkBodies(node.markdown).join(","); // linear (text.ts)
    case "file.backlinks":
    case "file.embeds":
      return "";
  }
  // MVP: formula.X keys render empty — formulas declared in BaseSpec are
  // parsed but not evaluated yet. order: [formula.X] silently sorts on "".
  // note.KEY / bare KEY sort by the attribute value rule (attributeKey).
  return "";
}
