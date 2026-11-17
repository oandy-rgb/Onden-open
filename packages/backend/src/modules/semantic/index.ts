import type { ModuleDefinition } from "../types.js";
import { PDF_TEXT_ATTR } from "@onden/markdown/contract";
import { db } from "../../dbKysely.js";
import { log } from "../../logger.js";
import { enqueueEffect, requireString, type OutboxEffect } from "../../services/outbox.js";
import { embedNode, semanticSearchNodes } from "../../services/embeddings.js";
import { workspaceHasModule } from "../../services/workspaceModules.js";
import { SEMANTIC_MODULE, embedBackfillEffect, withPdfText, refreshOwnerSuggestions, requestBackfill, resumeIndexing } from "./indexing.js";
import { semanticSearch } from "./semanticSearchTool.js";
import { suggestLinks } from "./suggestLinksTool.js";
import type { AgentTool } from "../../services/agentTools/index.js";
import { registerSemanticRoutes } from "./routes.js";

// Semantic search: a note's title and body are embedded after every content
// change, and a note can ask for related notes. An optional library module
// (user, 2026-10-18: 「語意搜尋要關」): it needs the local embedding model, so
// no workspace imports it by default. Not imported, no embed intents are
// filed (the hook is gated by hooksWhenImported), its route refuses writes,
// its agent tools refuse with ModuleNotImportedError and the AI harness
// searches by keyword only. Removing it leaves keyword search and links
// untouched; stored embeddings are kept and simply stop updating.

const embedEffect: OutboxEffect<{ workspaceId: string; nodeId: string; text: string }> = {
  kind: "embed",
  parse: (p) => ({ workspaceId: requireString(p, "workspaceId"), nodeId: requireString(p, "nodeId"), text: requireString(p, "text") }),
  // Compute + upsert the node's body embedding; embedNode skips an unchanged
  // body. An intent left from before the module was removed settles as done
  // without loading the model, so it cannot retry until it dies. Then the note's
  // related-note suggestions are refreshed on the server, so boards show them
  // without any client asking (indexing.ts).
  perform: async (p) => {
    if (!(await workspaceHasModule(p.workspaceId, SEMANTIC_MODULE))) return;
    await embedNode(p.workspaceId, p.nodeId, await withPdfText(p.workspaceId, p.nodeId, p.text));
    await refreshOwnerSuggestions(p.workspaceId, p.nodeId);
  },
};

export const semanticModule: ModuleDefinition = {
  id: SEMANTIC_MODULE,
  // The harness adds meaning to its keyword search (imported workspaces only).
  retrievalSource: (workspaceId, text, opts) => semanticSearchNodes(workspaceId, text, opts),
  registerRoutes: registerSemanticRoutes,
  // Writes here answer 409 module_not_imported while not imported.
  routePrefixes: ["/api/nodes/:id/suggested-links", "/api/semantic"],
  agentTools: [semanticSearch as AgentTool, suggestLinks as AgentTool],
  outboxEffects: [embedEffect, embedBackfillEffect],
  // Never under test. Files intents only; the outbox does the work (modules/types.ts startBackground).
  startBackground: () => {
    const start = setTimeout(() => { resumeIndexing().catch((err) => log.error("semantic", "could not resume indexing", { err })); }, 15_000);
    start.unref?.();
  },
  nodeHooks: {
    // A PDF's text is part of what the note says (indexing.ts withPdfText): the intent is filed again when it changes.
    attributeCommitted: async ({ workspaceId, nodeId, key }) => {
      if (key !== PDF_TEXT_ATTR) return;
      const note = await db.selectFrom("content_nodes").select(["title", "markdown"]).where("workspace_id", "=", workspaceId).where("id", "=", nodeId).executeTakeFirst();
      if (!note) return;
      await enqueueEffect({ workspaceId, kind: "embed", dedupKey: `embed:${nodeId}`, payload: { nodeId, workspaceId, text: `${note.title}\n\n${note.markdown ?? ""}` } });
    },
    // Rides the outbox in the write transaction: one pending intent per node,
    // collapsed by the dedup key, so a burst of edits embeds once.
    contentCommitted: async ({ workspaceId, nodeId, text, triggeredByEventId }) => {
      await enqueueEffect({
        workspaceId, kind: "embed", dedupKey: `embed:${nodeId}`,
        payload: { nodeId, workspaceId, text }, triggeredByEventId,
      });
    },
  },
  // Never in use by itself: it never worked on the server it shipped to, so
  // the first library run imports it nowhere. Settings › Modules imports it.
  // Spends compute and money on every note: on only after the owner agrees once.
  // Turning it on indexes the notes already there (indexing.ts); only edits were covered before.
  library: { confirmOnce: true, whenTurnedOn: requestBackfill },
};
