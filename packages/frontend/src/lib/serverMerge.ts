// Reconnect merge — runs when the user saves server settings (SettingsModal's
// onConnect) after a stretch of local-only work. Extracted from an inline JSX
// prop in BuilderApp.
//
// The caller drains the queued-write layer (sync()) first, so every local edit
// has already been offered to the server through the write queue. What can
// still differ afterwards is NOT local intent: the server may hold newer edits
// from another device, or this mirror may hold slim rows whose bodies were
// never loaded (markdown ""). This pass therefore never overwrites a note the
// server already has. It only creates notes the server is missing, and only
// from complete local copies.
//
// "Missing" is judged against the slim bootstrap (?bodies=none), which lists
// every readable note; the full bootstrap is capped and would make notes past
// the cap look missing. "local-" ids are skipped: those are optimistic rows
// whose real ids the write queue mints; POSTing them here would double-create.
//
// Per-node failures do NOT abort the loop — one unwritable node (e.g. a
// policy-gated one) must not strand the rest of the merge. They are counted
// and reported to the caller instead of vanishing into a bare catch.

import { nodeNeedsBody, type ContentNode } from "./api";
import { reads, writersFor } from "./data";

// The merge reports one count; individual failures are not toasted.
const mergeWriter = writersFor({ notify: () => {} }).note;

export async function mergeLocalNodesToServer(
  localNodes: ContentNode[],
): Promise<{ failed: number }> {
  const serverBoot = await reads.workspace.slimBootstrap();
  const onServer = new Set(serverBoot.nodes.map((n) => n.id));
  let failed = 0;
  for (const node of localNodes) {
    if (node.id.startsWith("local-") || onServer.has(node.id)) continue;
    // A slim row has no body here; creating it would publish an empty note.
    if (nodeNeedsBody(node)) continue;
    // The local id is kept (and is the Idempotency-Key): a retried merge
    // cannot create the note twice.
    await mergeWriter.create({ id: node.id, title: node.title, markdown: node.markdown, source_type: node.source_type === "ai" ? "ai" : "manual" })
      .catch(() => { failed += 1; });
  }
  return { failed };
}
