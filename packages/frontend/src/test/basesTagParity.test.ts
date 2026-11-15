// Bases file.hasTag counts a tag's members the way the backend's views and
// /api/query do (tagHierarchy.memberTagIds): the tag, its child tags and the
// tags extending it, every tag with the name. The same fixture is checked on
// the backend (packages/backend/src/test/tagMembershipParity.integration.test.ts).
// System machinery (a source_type='system' note, the workspace-config tag) never
// lists, even when it matches.

import { describe, it, expect } from "vitest";
import fixture from "./fixtures/tagMembershipParity.json";
import { applyView, type EvalNode } from "../lib/basesEval";
import { tagMembersResolver } from "../lib/nodeTags";
import { parseBaseSpec } from "@onden/markdown";
import { tagsById } from "../lib/systemNodes";
import type { Tag } from "../lib/api";

const id = (key: string) => `id-${key}`;
const tags = fixture.tags.map((t) => ({
  id: id(t.key), name: t.name,
  parent_id: "parent" in t && t.parent ? id(t.parent) : null,
  schema_extends: "extends" in t && t.extends ? t.extends.map(id) : null,
  view_module: "viewModule" in t && !!t.viewModule,
}));
const nameOf = (k: string) => fixture.tags.find((t) => t.key === k)!.name;
const nodes: EvalNode[] = [
  ...fixture.notes.map((n) => ({
    id: id(n.key), title: n.key, markdown: "", node_type: "content",
    ...("system" in n && n.system ? { source_type: "system" } : {}),
    tag_ids: n.tags.map(id),
    class_tag_names: n.tags.map(nameOf),
  })),
  // Tag rows that carry tags themselves (the workspace-config tag): applyView
  // must drop the system one even though file.hasTag would match it.
  ...fixture.tags.flatMap((t) => "tags" in t && t.tags ? [{
    id: id(t.key), title: t.key, markdown: "", node_type: "class_tag",
    tag_ids: t.tags.map(id), class_tag_names: t.tags.map(nameOf),
  }] : []),
];
const catalog = tagsById(fixture.tags.map((t) => ({
  id: id(t.key), name: t.name, ...("reserved" in t ? { reserved_key: t.reserved } : { reserved_key: null }),
})) as Tag[]);

describe("Bases file.hasTag matches the backend's tag membership", () => {
  const tagMembers = tagMembersResolver(tags);
  for (const [name, expected] of Object.entries(fixture.expect)) {
    it(`file.hasTag("${name}")`, () => {
      const spec = parseBaseSpec(`views:\n  - type: table\n    name: t\n    filters: 'file.hasTag("${name}")'\n`);
      const rows = applyView(nodes, spec, spec.views[0]!, { tagMembers, tags: catalog });
      expect(rows.map((r) => r.title).sort()).toEqual([...expected].sort());
    });
  }
});
