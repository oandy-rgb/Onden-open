// Pressing 「確認並發布」 closes the dialog within a second; the answer is a notice that says it is publishing,
// then when it went out with a way to open the site, or that it did not (the writer's own error shows the reason).
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishPreview } from "@onden/contract";
import { getAppState, resetAppState } from "../../lib/appStore";
import { setLocalePref } from "../../lib/i18n";

vi.mock("../../lib/diagramPrecompile", () => ({ precompileDiagrams: async () => [] }));
import { usePublishReview } from "./usePublishReview";

const body = { title: "S", presentation: {} };
const preview: PublishPreview = {
  hash: "h".repeat(64), site: { id: null, title: "S", home_node_id: null, event_cursor: 0, payload: {}, artifact_ref: "a", created_at: "2026-10-14T08:00:00.000Z" }, live: null,
  diff: { added: [], returning: [], changed: [], moved: [], links_changed: [], removed: [], settings_changed: false },
  private_links: [], blocked_media: [], new_media: [], large_videos: [], left_out: [], unpublished_refs: [], diagrams_needed: [],
};
const notices = () => getAppState().toasts;

describe("publish feedback", () => {
  beforeEach(() => { setLocalePref("en"); resetAppState(); });

  it("shows 'publishing' while it runs, then when it went out and a way to open the site", async () => {
    let finish!: (value: { url: string }) => void;
    const writer = { previewPublish: async () => preview, publish: vi.fn(() => new Promise<{ url: string }>((resolve) => { finish = resolve; })) };
    const { result } = renderHook(() => usePublishReview(writer));
    await act(async () => { await result.current.start(async () => body); });
    let done!: Promise<unknown>;
    await act(async () => { done = result.current.confirm(); });
    expect(notices().map((n) => n.message)).toEqual(["Publishing the site…"]);
    expect(notices()[0]!.working).toBe(true);
    await act(async () => { finish({ url: "https://example.test/" }); await done; });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ kind: "success", inDialog: true });
    expect(notices()[0]!.message).toMatch(/^Published at /);
    expect(notices()[0]!.working).toBeUndefined();
    expect(notices()[0]!.action?.label).toBe("Open the site");
  });

  it("a publish that fails leaves no 'publishing' notice and keeps the preview for another try", async () => {
    const writer = { previewPublish: async () => preview, publish: vi.fn(async () => { throw new Error("down"); }) };
    const { result } = renderHook(() => usePublishReview(writer));
    await act(async () => { await result.current.start(async () => body); });
    let answer: unknown;
    await act(async () => { answer = await result.current.confirm(); });
    expect(answer).toBeNull();
    expect(notices().some((n) => n.message === "Publishing the site…")).toBe(false);
    expect(result.current.pending).not.toBeNull();
  });
});

describe("the words of the publish answer", () => {
  it("'Open the site' reads in Chinese without the website settings screen having been opened", async () => {
    // Only the shared late dictionary is loaded here, not modules/website/setup/strings.zh-TW.ts.
    setLocalePref("zh-TW");
    const { dictionariesReady } = await import("../../lib/i18n");
    await dictionariesReady();
    resetAppState();
    const writer = { previewPublish: async () => preview, publish: async () => ({ url: "https://example.test/" }) };
    const { result } = renderHook(() => usePublishReview(writer));
    await act(async () => { await result.current.start(async () => body); });
    await act(async () => { await result.current.confirm(); });
    expect(notices()[0]!.action?.label).toBe("開啟網站");
    expect(notices()[0]!.message).toMatch(/^網站已在 .* 發布。$/);
  });
});
