// Publishing lays out the diagrams the preview asked for, in this browser, and
// sends them with the publish; nothing asked for means nothing extra is sent,
// and a failed or empty layout never blocks the publish.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishPreview } from "@onden/contract";

const precompile = vi.fn();
vi.mock("../../lib/diagramPrecompile", () => ({ precompileDiagrams: (...a: unknown[]) => precompile(...a) }));

import { usePublishReview } from "./usePublishReview";

const body = { title: "S", presentation: {} };
// `undefined` stands for an older server that sends no `diagrams_needed`: the app still has to read it as none.
const previewOf = (diagrams_needed?: string[]): PublishPreview => ({
  hash: "h".repeat(64), site: { id: null, title: "S", home_node_id: null, event_cursor: 0, payload: {}, artifact_ref: "a", created_at: "2026-10-14T08:00:00.000Z" }, live: null,
  diff: { added: [], returning: [], changed: [], moved: [], links_changed: [], removed: [], settings_changed: false },
  private_links: [], blocked_media: [], new_media: [], large_videos: [], left_out: [], unpublished_refs: [], diagrams_needed: diagrams_needed as string[],
});

async function confirmWith(needed: string[] | undefined) {
  const publish = vi.fn(async () => ({ url: "/site" }));
  const writer = { previewPublish: vi.fn(async () => previewOf(needed)), publish };
  const { result } = renderHook(() => usePublishReview(writer));
  await act(async () => { await result.current.start(async () => body); });
  await act(async () => { await result.current.confirm(); });
  return publish;
}

describe("usePublishReview diagrams", () => {
  beforeEach(() => precompile.mockReset());

  it("sends the layouts made for the blocks the preview asked for", async () => {
    const made = [{ source: "flowchart TD\n  A --> B", layout: { version: 1 } }];
    precompile.mockResolvedValue(made);
    const publish = await confirmWith(["flowchart TD\n  A --> B"]);
    expect(precompile).toHaveBeenCalledWith(["flowchart TD\n  A --> B"]);
    expect(publish).toHaveBeenCalledWith({ ...body, diagrams: made, preview_hash: "h".repeat(64) });
  });

  it("adds nothing when no layout came back (not ready in time, or nothing asked for)", async () => {
    precompile.mockResolvedValue([]);
    const publish = await confirmWith(undefined); // an older server
    expect(precompile).toHaveBeenCalledWith([]);
    expect(publish).toHaveBeenCalledWith({ ...body, preview_hash: "h".repeat(64) });
  });

  it("keeps the dialog open after the publish with how it ended: when it went out, or why not", async () => {
    precompile.mockResolvedValue([]);
    const writer = { previewPublish: vi.fn(async () => previewOf([])), publish: vi.fn(async () => ({ url: "/site/" })) };
    const { result } = renderHook(() => usePublishReview(writer));
    await act(async () => { await result.current.start(async () => body); });
    await act(async () => { await result.current.confirm(); });
    expect(result.current.pending).not.toBeNull();
    expect(result.current.outcome).toEqual({ kind: "published", url: "/site/", at: expect.any(String) });
    act(() => result.current.cancel());
    expect(result.current.pending).toBeNull();
    expect(result.current.outcome).toBeNull();

    writer.publish.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await result.current.start(async () => body); });
    await act(async () => { await result.current.confirm(); });
    expect(result.current.outcome).toEqual({ kind: "failed", message: expect.any(String) });
  });
});
