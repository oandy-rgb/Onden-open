// Notes a module adds to the harness's retrieval besides keyword matches
// (semantic search: related notes by meaning). Filled by registerModuleEffects
// from ModuleDefinition.retrievalSource — behind the module's import gate — so
// the harness names no module and asks nothing of one that is not imported.

import type { ActorCtx } from "../types.js";

export type RetrievalHit = { id: string; title: string; slug: string };
export type RetrievalSource = (
  workspaceId: string,
  text: string,
  opts: { actor?: ActorCtx | null; limit: number },
) => Promise<RetrievalHit[]>;

const sources: RetrievalSource[] = [];

export function registerRetrievalSource(source: RetrievalSource): void {
  if (!sources.includes(source)) sources.push(source);
}

/** Hits from every registered source, in registration order. */
export async function moduleRetrievalHits(
  workspaceId: string,
  text: string,
  opts: { actor?: ActorCtx | null; limit: number },
): Promise<RetrievalHit[]> {
  const hits: RetrievalHit[] = [];
  for (const source of sources) hits.push(...await source(workspaceId, text, opts));
  return hits;
}
