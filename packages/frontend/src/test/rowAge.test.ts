import { describe, expect, it } from "vitest";
import { isOlderCopy } from "../lib/rowAge";
import { applySyncDelta } from "../lib/data/storeOps";
import { noWorkspaceData, type ContentNode } from "../lib/api";

// A sync answer can reach the device after a newer copy of a row did (lib/rowAge.ts). The store keeps the newer one.
const note = (markdown: string, updated_at?: string): ContentNode =>
  ({ id: "n1", title: "T", slug: "n1", markdown, node_type: "content", source_type: "manual", ...(updated_at ? { updated_at } : {}) });
const answer = (...upsert: ContentNode[]) => ({
  last_event_id: 0, nodes: { upsert, delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] },
  attributes: { upsert: [], delete: [] }, workspace: null,
}) as unknown as Parameters<typeof applySyncDelta>[1];

describe("a copy of a row from before the one held", () => {
  it("is older only when both carry the server's time and it is strictly earlier", () => {
    expect(isOlderCopy({ updated_at: "2026-11-16T05:50:56.000Z" }, { updated_at: "2026-11-16T05:50:58.000Z" })).toBe(true);
    expect(isOlderCopy({ updated_at: "2026-11-16T05:50:58.000Z" }, { updated_at: "2026-11-16T05:50:58.000Z" })).toBe(false);
    expect(isOlderCopy({ updated_at: "2026-11-16T05:51:00.000Z" }, { updated_at: "2026-11-16T05:50:58.000Z" })).toBe(false);
    expect(isOlderCopy({ updated_at: "2026-11-16T05:50:56.000Z" }, undefined)).toBe(false);
    expect(isOlderCopy({}, { updated_at: "2026-11-16T05:50:58.000Z" })).toBe(false);
    expect(isOlderCopy({ updated_at: "2026-11-16T05:50:56.000Z" }, { updated_at: null })).toBe(false);
    expect(isOlderCopy({ updated_at: "not a time" }, { updated_at: "2026-11-16T05:50:58.000Z" })).toBe(false);
  });

  it("does not replace the row in the store; a newer or an equal one does, and so does one for a row with no time yet", () => {
    const held = { ...noWorkspaceData, nodes: [note("saved at :58", "2026-11-16T05:50:58.000Z")] };
    expect(applySyncDelta(held, answer(note("from :56", "2026-11-16T05:50:56.000Z"))).nodes[0]!.markdown).toBe("saved at :58");
    expect(applySyncDelta(held, answer(note("from :59", "2026-11-16T05:50:59.000Z"))).nodes[0]!.markdown).toBe("from :59");
    expect(applySyncDelta(held, answer(note("same time", "2026-11-16T05:50:58.000Z"))).nodes[0]!.markdown).toBe("same time");
    const fresh = { ...noWorkspaceData, nodes: [note("made here, not answered yet")] };
    expect(applySyncDelta(fresh, answer(note("the server's", "2026-11-16T05:50:56.000Z"))).nodes[0]!.markdown).toBe("the server's");
  });
});
