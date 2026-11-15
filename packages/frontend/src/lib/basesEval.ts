// F3.2 — Bases filter evaluation in the app. The evaluator itself is
// @onden/markdown basesEval.ts (shared with the server, which evaluates an
// `onden-base` block when a note is published or exported — D113); this file
// supplies what only the app knows: its wikilink rule (lib/wikilinks.ts) for
// file.hasLink, its tag catalog for system rows, and resolvers built from the
// store's tags and notes. Presentational only: see the evaluator's SECURITY
// NOTE.

import {
  applyView as applyBaseView, evalFilter as evalBaseFilter, storedValueType, wikilinkBodies,
  type AttributeField, type AttributeValueType, type BaseEvalContext, type BaseEvalNode,
  type BaseSpec, type FilterNode, type ViewDef,
} from "@onden/markdown";
import { linkNameTargets, wikilinkNamesTitle, wikilinkReaches, type WikilinkNode } from "./wikilinks";
import { isSystemNode, type tagsById } from "./systemNodes";

export type EvalNode = BaseEvalNode;

/** Context passed alongside the node — `this` substitution per SKILL.md
 *  §"The `this` Keyword" (the host note's title when the base is embedded),
 *  and the resolvers below. */
export type EvalContext = {
  thisTitle?: string;
  /** The ids a tag NAME stands for: every tag with that name and their
   *  members (lib/nodeTags.ts memberTagIds), as the backend's /api/query
   *  resolves `tags`. Without it file.hasTag compares the note's own tag
   *  names only. */
  tagMembers?: (name: string) => ReadonlySet<string>;
  /** The tag catalog by id, so isSystemNode finds the workspace-config tag by
   *  its reserved key whatever it is titled. */
  tags?: ReturnType<typeof tagsById>;
  /** The notes a link NAME stands for (linkTargetsResolver): file.hasLink
   *  checks whether the node's links reach one of them. Without it
   *  file.hasLink compares link names only. */
  linkTargets?: (name: string) => readonly WikilinkNode[];
};

/** file.hasLink(name): a link in the node reaches a note `name` names (the
 *  server's wikilink edge rule, lib/wikilinks.ts), or names `name` while that
 *  name reaches no note from here — a dangling link still links by name. */
function linksTo(node: EvalNode, name: string, ctx: EvalContext | undefined): boolean {
  if (!node.markdown.includes("[[")) return false;
  const targets = ctx?.linkTargets?.(name) ?? [];
  const dangling = !targets.some((t) => wikilinkReaches(name, node, t));
  return wikilinkBodies(node.markdown).some((body) =>
    targets.some((t) => wikilinkReaches(body, node, t)) || (dangling && wikilinkNamesTitle(body, name)));
}

function coreContext(ctx: EvalContext | undefined): BaseEvalContext {
  return {
    thisTitle: ctx?.thisTitle,
    tagMembers: ctx?.tagMembers,
    linksTo: (node, name) => linksTo(node, name, ctx),
    isSystem: (node) => isSystemNode(node, ctx?.tags),
  };
}

export function evalFilter(node: EvalNode, filter: FilterNode | undefined, ctx?: EvalContext): boolean {
  return evalBaseFilter(node, filter, coreContext(ctx));
}

export function applyView(nodes: EvalNode[], spec: BaseSpec, view: ViewDef, ctx?: EvalContext): EvalNode[] {
  return applyBaseView(nodes, spec, view, coreContext(ctx));
}

/** EvalContext.linkTargets over the notes and tags a base's links can reach
 *  (lib/wikilinks.ts linkNameTargets). */
export function linkTargetsResolver(nodes: readonly WikilinkNode[]): (name: string) => readonly WikilinkNode[] {
  return linkNameTargets(nodes);
}

/** EvalNode.value_types for a note's attrs: each value's storage type under
 *  the schema fields its tags declare for the key NOW (@onden/markdown
 *  storedValueType). The app's notes carry attributes as a flat string map
 *  without node_attributes.value_type, so the type is derived from the
 *  current tag schemas, not read. The server's stored type follows the same
 *  rule: attribute writes type what they store, and a tag or schema write
 *  that changes which field governs a key retypes the stored rows (backend
 *  services/attributeChange.ts retypeGoverned, D94). One difference: a
 *  free-form value keeps its writer's type on the server when it fits ("42"
 *  stored as text), which this cannot know — here it is freeFormType. */
export function attributeValueTypes(
  attrs: Record<string, string> | undefined,
  tagIds: readonly string[],
  fieldsOf: (tagId: string) => readonly AttributeField[] | null | undefined,
): Record<string, AttributeValueType> {
  const out: Record<string, AttributeValueType> = {};
  for (const [key, value] of Object.entries(attrs ?? {})) {
    out[key] = storedValueType(value, tagIds.flatMap((id) => (fieldsOf(id) ?? []).filter((f) => f.name === key)));
  }
  return out;
}
