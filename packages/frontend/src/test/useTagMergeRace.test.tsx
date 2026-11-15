// Merging is destructive: a slow preview for an earlier pick must never decide what is merged.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tag, TagMergePreview } from "../lib/api";
import { fetchTagMergePreview } from "../lib/api";
import { mergeTag } from "../lib/data";
import { useTagMerge } from "../components/tagPage/useTagMerge";

vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), fetchTagMergePreview: vi.fn() }));
vi.mock("../lib/data", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/data")>()), mergeTag: vi.fn() }));

const tag = (id: string, name: string) => ({ id, name, reserved_key: null }) as unknown as Tag;
const SRC = tag("src", "source"), A = tag("a", "alpha"), B = tag("b", "beta");
const previewFor = (t: Tag) => ({ source: { id: SRC.id, name: SRC.name }, target: { id: t.id, name: t.name } }) as unknown as TagMergePreview;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("useTagMerge when previews answer out of order", () => {
  beforeEach(() => { vi.mocked(fetchTagMergePreview).mockReset(); vi.mocked(mergeTag).mockReset(); });

  it("only the preview of the tag picked last is shown and confirmed", async () => {
    const first = deferred<TagMergePreview>(), second = deferred<TagMergePreview>();
    vi.mocked(fetchTagMergePreview).mockImplementation((_s, id) => (id === A.id ? first.promise : second.promise));
    vi.mocked(mergeTag).mockResolvedValue({ members_gained_target: 0 } as never);
    const { result } = renderHook(() => useTagMerge({ tag: SRC, allTags: [SRC, A, B] }));
    let pickA!: Promise<void>, pickB!: Promise<void>;
    act(() => { pickA = result.current.pickTarget(A.id); });
    act(() => { pickB = result.current.pickTarget(B.id); });
    await act(async () => { second.resolve(previewFor(B)); await pickB; });
    await act(async () => { first.resolve(previewFor(A)); await pickA; }); // A answers late
    expect(result.current.targetId).toBe(B.id);
    expect(result.current.preview?.target.id).toBe(B.id);
    await act(async () => { await result.current.confirm(); });
    expect(mergeTag).toHaveBeenCalledWith(SRC.id, B.id);
  });

  it("cannot confirm while the shown preview is for a different tag than the picked one", async () => {
    const first = deferred<TagMergePreview>(), second = deferred<TagMergePreview>();
    vi.mocked(fetchTagMergePreview).mockImplementation((_s, id) => (id === A.id ? first.promise : second.promise));
    const { result } = renderHook(() => useTagMerge({ tag: SRC, allTags: [SRC, A, B] }));
    let pickA!: Promise<void>;
    act(() => { pickA = result.current.pickTarget(A.id); });
    act(() => { void result.current.pickTarget(B.id); });
    await act(async () => { first.resolve(previewFor(A)); await pickA; }); // B's preview is still loading
    expect(result.current.preview).toBeNull();
    await act(async () => { await result.current.confirm(); });
    expect(mergeTag).not.toHaveBeenCalled();
  });
});
