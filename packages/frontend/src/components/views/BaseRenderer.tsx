// F3.3 — Bases view renderer.
//
// Takes a BaseSpec (parsed Bases YAML) + the workspace node set, runs the
// active view's filter chain, and renders one of: Table, Cards, List. A `map` view is
// parsed (Bases ships it) but not drawn: the file says it is unsupported.
//
// Eval happens in-browser against the already-fetched node list, mirroring
// how OndenQueryBlock works today. F3.5 plugs in event-targeting predicates;
// for now the eval module only sees frontmatter + class_tag_names.

import { useMemo } from "react";
import type { ContentNode, SchemaField } from "../../lib/api";
import { parseBaseSpec } from "@onden/markdown";
import {
  applyView, attributeValueTypes, linkTargetsResolver, type EvalNode,
} from "../../lib/basesEval";
import { useTagRows } from "../../lib/appStore";
import { BasesTable } from "./BasesTable";
import { BasesCards } from "./BasesCards";
import { BasesList } from "./BasesList";
import { nodeTagIds, tagMembersResolver } from "../../lib/nodeTags";
import { tagsById } from "../../lib/systemNodes";
import "./BaseRenderer.css";
import { useT } from "../../lib/i18n";
import { tagFields } from "../../lib/tagFields";
import EmptyState from "../EmptyState";
import { isTag, isNote } from "@onden/markdown/contract";

type Props = {
  /** YAML body of the base node. */
  source: string;
  /** Active view index; defaults to 0. */
  viewIndex?: number;
  /** Workspace nodes available for evaluation. */
  nodes: ContentNode[];
  /** Host note's title when this base is embedded inside another note's
   *  body. Substituted for the `this` keyword in filter expressions
   *  per SKILL.md §"The `this` Keyword". */
  thisTitle?: string;
  /** Click-through. */
  onSelectNode?: (id: string) => void;
};

function toEvalNode(
  n: ContentNode, classTagNames: Map<string, string>, fieldsOf: (tagId: string) => SchemaField[] | null | undefined,
): EvalNode {
  // Label tags (#toread) are class_tag nodes too, so file.hasTag sees both.
  const tagIds = nodeTagIds(n);
  const tagNames = tagIds
    .map((id) => classTagNames.get(id))
    .filter((s): s is string => typeof s === "string");
  return {
    id: n.id,
    title: n.title,
    markdown: n.markdown,
    node_type: n.node_type,
    space_id: n.space_id,
    source_type: n.source_type,
    class_tag_names: tagNames,
    tag_ids: tagIds,
    frontmatter: n.attrs,
    // Comparisons and sorts read values typed as the server stored them (D49).
    value_types: attributeValueTypes(n.attrs, tagIds, fieldsOf),
    last_actor: n.last_actor ?? undefined,
    last_modified_at: n.last_modified_at ?? undefined,
    recent_actors: n.recent_actors ?? undefined,
  };
}

export default function BaseRenderer({ source, viewIndex = 0, nodes, thisTitle, onSelectNode }: Props) {
  const t = useT();
  // file.hasTag counts child and extending tags, as the backend's views do.
  const tags = useTagRows();
  const catalog = useMemo(() => tagsById(tags), [tags]);
  const tagMembers = useMemo(() => {
    // The store's tags (with what they extend), plus class-tag rows among the
    // given nodes that it lacks (name and parent only).
    const known = new Set((tags ?? []).map((tag) => tag.id));
    const fromNodes = nodes
      .filter((n) => isTag(n) && !known.has(n.id))
      .map((n) => ({ id: n.id, name: n.title, parent_id: n.parent_id ?? null }));
    return tagMembersResolver([...(tags ?? []), ...fromNodes]);
  }, [tags, nodes]);
  const { spec, error } = useMemo(() => {
    try {
      return { spec: parseBaseSpec(source), error: false };
    } catch {
      return { spec: null, error: true };
    }
  }, [source]);

  // file.hasLink resolves link names over every given note and tag.
  const linkTargets = useMemo(() => linkTargetsResolver(nodes), [nodes]);

  const evalNodes = useMemo(() => {
    const classTagNames = new Map<string, string>();
    // The catalog first: a hidden tag's own row is left out of note lists,
    // and file.hasTag must still find it (D104).
    for (const tag of tags ?? []) classTagNames.set(tag.id, tag.name);
    for (const n of nodes) {
      if (isTag(n)) classTagNames.set(n.id, n.title);
    }
    const fields = new Map((tags ?? []).map((tag) => [tag.id, tagFields(tag)] as const));
    // Exclude class_tag rows from result sets — tags appear in queries
    // via `file.hasTag("X")` predicates, not as result rows themselves.
    return nodes
      .filter((n) => isNote(n))
      .map((n) => toEvalNode(n, classTagNames, (id) => fields.get(id)));
  }, [nodes, tags]);

  if (error) return <div className="base-renderer-error">{t("This base file can't be read. Check its view settings.")}</div>;
  if (!spec || spec.views.length === 0) return <EmptyState size="inline" as="div" title={t("No views defined.")} />;

  const view = spec.views[Math.max(0, Math.min(viewIndex, spec.views.length - 1))];
  const rows = applyView(evalNodes, spec, view, { ...(thisTitle ? { thisTitle } : {}), tagMembers, tags: catalog, linkTargets });

  switch (view.type) {
    case "cards": return <BasesCards rows={rows} view={view} onSelectNode={onSelectNode} />;
    case "list":  return <BasesList  rows={rows} view={view} onSelectNode={onSelectNode} />;
    case "map":   return <EmptyState size="inline" as="div" title={t("Map view is not supported.")} />;
    case "table":
    default:      return <BasesTable rows={rows} view={view} onSelectNode={onSelectNode} />;
  }
}
