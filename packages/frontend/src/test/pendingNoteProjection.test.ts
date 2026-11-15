import { describe, expect, it } from "vitest";
import type { ContentNode } from "../lib/api";
import type { PendingWrite } from "../lib/localDb";
import { missingPendingNoteCreations, projectPendingNoteText } from "../lib/pendingNoteProjection";

const note: ContentNode = { id: "n", title: "Server title", markdown: "server", slug: "n", source_type: "manual", node_type: "content" };
const write = (body: unknown, changes: Partial<PendingWrite> = {}): PendingWrite => ({
  id: 1, method: "PATCH", path: "/api/nodes/n", body: JSON.stringify(body), idem_key: "key", attempts: 0, ...changes,
});

describe("pending node text projection", () => {
  it("preserves only text fields on a node the remote response still contains", () => {
    const remote = { ...note, parent_id: "server-parent", class_tag_ids: ["restricted"] };
    const pending = [write({ title: "local", markdown: "draft", parent_id: null, class_tag_ids: [], base_markdown: "base" })];
    expect(projectPendingNoteText([remote], pending)).toEqual([{ ...remote, title: "local", markdown: "draft", body_len: 5 }]);
    expect(projectPendingNoteText([], pending)).toEqual([]);
    expect(remote.title).toBe("Server title");
  });

  it("uses replay order per field and accepts intentional empty text", () => {
    const pending = [write({ markdown: "first", title: "rename" }), write({ markdown: "" }, { id: 2 })];
    expect(projectPendingNoteText([note], pending)).toEqual([{ ...note, title: "rename", markdown: "", body_len: 0 }]);
  });

  it("ignores unrelated routes, invalid JSON, non-string values and base markdown", () => {
    const pending = [
      write({ markdown: "wrong" }, { path: "/api/nodes/n/promote" }),
      write({ markdown: "wrong" }, { method: "DELETE" }),
      write({ markdown: "wrong" }, { path: "/api/nodes/other" }),
      write(null, { body: "{" }), write(["not an object"]),
      write({ markdown: null, title: 3, base_markdown: "not input" }),
    ];
    expect(projectPendingNoteText([note], pending)).toEqual([note]);
  });

  it("reconstructs only explicit own creation input, never cached policy or relationships", () => {
    expect(missingPendingNoteCreations([], [
      write({ id: "new", title: "Own title", markdown: "draft", parent_id: "secret", attrs: { ink: "private" }, class_tag_ids: ["secret"] }, { method: "POST", path: "/api/nodes" }),
      write({ markdown: "secret-id", id: "not-a-create" }),
      write({ id: "tag-id" }, { method: "POST", path: "/api/tags" }),
      write({ id: "" }, { method: "POST", path: "/api/nodes" }),
      write({ id: "no-title" }, { method: "POST", path: "/api/nodes" }),
      write({ id: "invalid", title: "Invalid", markdown: {} }, { method: "POST", path: "/api/nodes" }),
    ])).toEqual([{ id: "new", title: "Own title", markdown: "draft", body_len: 5, slug: "own-title", source_type: "manual", node_type: "content" }]);
  });

  it("respects later text/empty edits and deletion without duplicating a remotely supplied note", () => {
    const creates = [write({ id: "n", title: "New", markdown: "start" }, { method: "POST", path: "/api/nodes" })];
    const edits = [...creates, write({ title: "Renamed", markdown: "" })];
    expect(missingPendingNoteCreations([], edits)).toEqual([expect.objectContaining({ title: "Renamed", markdown: "", body_len: 0 })]);
    expect(missingPendingNoteCreations([note], edits)).toEqual([]);
    expect(missingPendingNoteCreations([], [...edits, write(null, { method: "DELETE" })])).toEqual([]);
    expect(missingPendingNoteCreations([], [write({ markdown: "earlier" }), ...creates]))
      .toEqual([expect.objectContaining({ markdown: "start" })]);
  });
});
