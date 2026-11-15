// Precompiled diagrams on the publish path (docs/architecture/precompiled-diagrams.md).
// The author's browser lays a ```mermaid flowchart or state diagram out and
// uploads the layout as data; this file decides what of that a snapshot keeps.
// The data is untrusted, so every layout is checked against the block it
// claims to be of (@onden/markdown validateDiagramLayout) before it is stored
// or reused, and the site draws the SVG itself (diagramSvg.ts).
//
// The snapshot's `payload.diagrams` is `[{ source, layout }]`, one per block
// text. The previous snapshot's list is the cache: a block whose text did not
// change keeps its layout without the browser laying it out again.

import { diagramKindOf, diagramsBySource, mermaidSources, validateDiagramLayout, DIAGRAM_LIMITS, type DiagramLayout, type PrecompiledDiagram } from "@onden/markdown";
import { q } from "../../../db.js";

/** What a publish request carries per diagram; `layout` is unchecked. */
export type SubmittedDiagram = { source: string; layout: unknown };

/** The supported blocks of these notes, once per distinct text, in page order. */
export function precompilableSources(nodes: ReadonlyArray<{ markdown?: unknown }>): string[] {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (typeof node.markdown !== "string") continue;
    for (const source of mermaidSources(node.markdown)) if (diagramKindOf(source) && source.length <= DIAGRAM_LIMITS.sourceChars) seen.add(source);
  }
  return [...seen];
}

export type CandidateDiagrams = {
  /** What the snapshot will carry: checked layouts for blocks of the published notes. */
  diagrams: PrecompiledDiagram[];
  /** Supported blocks still without a layout: what the app is asked to lay out. */
  needed: string[];
  /** Uploaded diagrams that did not check out or matched no block (not stored). */
  rejected: number;
};

/** The latest snapshot's diagrams, each checked again on the way out. */
async function lastSnapshotDiagrams(workspaceId: string): Promise<Map<string, DiagramLayout>> {
  const r = await q<{ diagrams: unknown }>(
    `SELECT payload->'diagrams' AS diagrams FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId],
  );
  return diagramsBySource(r.rows[0]?.diagrams);
}

/** The diagrams of the candidate's notes (already redacted, so the block
 *  text is what readers will get): an uploaded layout that checks out wins,
 *  else the last snapshot's for the same text. */
export async function candidateDiagrams(
  workspaceId: string, nodes: ReadonlyArray<{ markdown?: unknown }>, submitted: readonly SubmittedDiagram[] = [],
): Promise<CandidateDiagrams> {
  const sources = precompilableSources(nodes);
  const wanted = new Set(sources);
  const uploaded = new Map<string, DiagramLayout>();
  let rejected = 0;
  for (const item of submitted.slice(0, DIAGRAM_LIMITS.perPublish)) {
    const check = wanted.has(item.source) ? validateDiagramLayout(item.layout, item.source) : null;
    if (check?.ok) uploaded.set(item.source, check.layout); else rejected++;
  }
  rejected += Math.max(0, submitted.length - DIAGRAM_LIMITS.perPublish);
  const cached = sources.some((s) => !uploaded.has(s)) ? await lastSnapshotDiagrams(workspaceId) : new Map<string, DiagramLayout>();
  const diagrams: PrecompiledDiagram[] = [];
  const needed: string[] = [];
  for (const source of sources) {
    const layout = uploaded.get(source) ?? cached.get(source);
    if (layout) diagrams.push({ source, layout }); else needed.push(source);
  }
  return { diagrams, needed: needed.slice(0, DIAGRAM_LIMITS.perPublish), rejected };
}

/** A snapshot's diagrams kept to blocks the notes still show: a takedown or a
 *  later redaction can change a block's text, and a diagram holds that text
 *  (its source), so it must not outlive the page that showed it. */
export function keepServedDiagrams(list: unknown, nodes: ReadonlyArray<{ markdown?: unknown }>): PrecompiledDiagram[] {
  const shown = new Set(precompilableSources(nodes));
  return [...diagramsBySource(list)].filter(([source]) => shown.has(source)).map(([source, layout]) => ({ source, layout }));
}
