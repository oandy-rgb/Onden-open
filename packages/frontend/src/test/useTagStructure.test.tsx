import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTagStructure } from "../components/tagPage/structure/useTagStructure";
import { api, ApiError, type Tag } from "../lib/api";
import { getAppState, resetAppState, setAppState } from "../lib/appStore";
// Online decisions check the local write queue first (onlineWrite.ts); jsdom has no DB worker.
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));

// The structure editor's state (docs/architecture/module-library.md): a
// function switch shows its new position at once, the extends write settles it,
// and a refused write returns the switch to the saved state.

const course: Tag = { id: "course", name: "Course", color: "", schema_id: null, schema_extends: [], effective_modules: [] };
const reviewTag: Tag = { id: "review-tag", name: "複習", color: "", schema_id: "review-tag",
  schema_module: "review", schema_extends: [], effective_modules: ["review"] };

let calls: Array<{ method: string; fn: string }>;
let refuse: Error | null;
let release: (() => void) | null;
let hold: boolean;
beforeEach(() => {
  resetAppState();
  const { data } = getAppState();
  setAppState({ data: { ...data, tags: [course, reviewTag] } });
  calls = [];
  refuse = null;
  release = null;
  hold = false;
  vi.mocked(api).mockReset().mockImplementation(async (path, init) => {
    if (path === "/api/tags") return [{ ...course, schema_fields: [], schema_behaviour: {} }] as never;
    const match = /\/api\/tags\/[^/]+\/functions\/([^/]+)$/.exec(path);
    if (match) {
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      if (refuse) throw refuse;
      calls.push({ method: init?.method ?? "GET", fn: decodeURIComponent(match[1]!) });
      return { id: course.id, function_id: match[1] } as never;
    }
    return {} as never;
  });
});

const setup = (tag: Tag, extra: { onFunctionRemoved?: (id: string) => void; onSaved?: () => void } = {}) =>
  renderHook(() => useTagStructure({ tag, online: true, ...extra }));

describe("useTagStructure: the tasks module's switch-only functions", () => {
  it("removeFunction takes only that function off", async () => {
    const withSwitch = { ...course, functions: [{ id: "skills", source_tag_id: course.id, ref_id: "ref" }], effective_modules: ["skills"] };
    const hook = setup(withSwitch);
    await act(() => hook.result.current.removeFunction("skills"));
    expect(calls).toEqual([{ method: "DELETE", fn: "skills" }]);
  });
});

const having = (): Tag => ({ ...course, functions: [{ id: "review", source_tag_id: reviewTag.id, ref_id: "ref" }], effective_modules: ["review"] });

describe("useTagStructure", () => {
  it("removeFunction deletes the reference and tells the page", async () => {
    const having = { ...course, functions: [{ id: "review", source_tag_id: reviewTag.id, ref_id: "ref" }], effective_modules: ["review"] };
    const onFunctionRemoved = vi.fn();
    const hook = setup(having, { onFunctionRemoved });
    await act(() => hook.result.current.removeFunction("review"));
    expect(calls).toEqual([{ method: "DELETE", fn: "review" }]);
    expect(onFunctionRemoved).toHaveBeenCalledWith("review");
  });

  it("taking a function off while the write runs holds the page busy, then settles", async () => {
    hold = true;
    const hook = setup(having());
    let done!: Promise<void>;
    act(() => { done = hook.result.current.removeFunction("review"); });
    await waitFor(() => expect(release).not.toBeNull());
    expect(hook.result.current.busy).toBe(true);
    expect(hook.result.current.changeDisabled).toBe(true);
    await act(async () => { release!(); await done; });
    expect(hook.result.current.busy).toBe(false);
    expect(calls).toEqual([{ method: "DELETE", fn: "review" }]);
  });

  it("a refused write changes nothing and reports it once", async () => {
    refuse = new ApiError(403, "forbidden");
    const onSaved = vi.fn();
    const hook = setup(having(), { onSaved });
    await act(() => hook.result.current.removeFunction("review"));
    expect(hook.result.current.busy).toBe(false);
    expect(calls).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
    expect(getAppState().toasts.filter((toast) => toast.kind === "error")).toHaveLength(1);
  });
});
