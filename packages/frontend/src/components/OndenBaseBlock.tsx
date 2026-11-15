// F3.4 — Bases embed via fenced code block.
//
//   ```onden-base
//   filters:
//     and: ['file.hasTag("project")']
//   views:
//     - type: cards
//       name: Projects
//   ```
//
// Mirrors OndenQueryBlock's surface: the YAML body is parsed +
// evaluated in-browser, then rendered through BaseRenderer.
//
// `this` context propagation: when a markdown body that contains an
// onden-base block is rendered with a known host node, that node's id is
// passed in via the optional `thisNodeId` prop. The eval layer (F3.5)
// will substitute `this` references inside filter expressions.
//
// Future: extend remark wikilink to handle `![[name.base#view]]` — for
// now, embedding requires authoring the YAML inline (or pointing a view
// at a class-tag scope, which is the cleaner pattern anyway).

import type { ContentNode } from "../lib/api";
import BaseRenderer from "./views/BaseRenderer";

type Props = {
  source: string;
  nodes: ContentNode[];
  /** Host node id when this base is embedded inside another note's body. */
  thisNodeId?: string | null;
  onSelectNode?: (id: string) => void;
};

export default function OndenBaseBlock({ source, nodes, thisNodeId, onSelectNode }: Props) {
  // F3-fix H4: resolve `this` to the host node's title, which is what
  // file.hasLink(this) / file.hasTag(this) want per SKILL.md §"The `this`
  // Keyword". Title (not id) because Bases predicates take strings.
  const thisTitle = thisNodeId
    ? nodes.find((n) => n.id === thisNodeId)?.title
    : undefined;
  return <BaseRenderer source={source} nodes={nodes} thisTitle={thisTitle} onSelectNode={onSelectNode} />;
}
