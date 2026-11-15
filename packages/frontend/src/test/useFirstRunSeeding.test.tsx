// First run on a fresh workspace: example notes are written exactly once, the
// feature picker is for the owner only and waits until the examples are in.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const create = vi.hoisted(() => vi.fn());
vi.mock("../lib/data/domainWriters", async (original) => ({
  ...await original<typeof import("../lib/data/domainWriters")>(),
  noteWriter: { create },
}));
vi.mock("../data/exampleNotes", () => ({
  getExampleNotes: () => [{ title: "One", markdown: "a" }, { title: "Two", markdown: "b" }],
}));

import { useFirstRunSeeding } from "../hooks/useFirstRunSeeding";
import { noWorkspaceData } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";

function freshWorkspace(extra: Partial<typeof noWorkspaceData> = {}) {
  setAppState({
    bootstrapped: true, online: true, membershipGated: false,
    data: { ...noWorkspaceData, nodes: [], example_seed_eligible: true, actor_is_owner: true, ...extra },
  });
}

beforeAll(() => { bindAccountStorage("owner-1", "https://onden.example/"); });
beforeEach(() => {
  localStorage.clear();
  resetAppState();
  create.mockReset().mockResolvedValue({ node: { id: "n" }, status: "synced" });
});

describe("useFirstRunSeeding", () => {
  it("writes the examples once (features are imported in Settings › Modules, not on first run)", async () => {
    freshWorkspace();
    const refresh = vi.fn(async () => {});
    const { rerender } = renderHook(() => useFirstRunSeeding({ refresh }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(create.mock.calls.map(([input]) => input.title)).toEqual(["One", "Two"]);
    expect(localStorage.getItem("onden.exampleSeeded")).toBe("1");
    rerender();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("never seeds again once the guard is set, or when opted out", async () => {
    localStorage.setItem("onden.exampleSeeded", "1");
    freshWorkspace();
    renderHook(() => useFirstRunSeeding({ refresh: async () => {} }));
    localStorage.clear();
    localStorage.setItem("onden.exampleSeed", "off");
    renderHook(() => useFirstRunSeeding({ refresh: async () => {} }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(create).not.toHaveBeenCalled();
  });

  it("does not seed a workspace that has notes", async () => {
    freshWorkspace({ actor_is_owner: false, nodes: [{ id: "x", title: "x", slug: "x", markdown: "", source_type: "manual", node_type: "content" }] });
    renderHook(() => useFirstRunSeeding({ refresh: async () => {} }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(create).not.toHaveBeenCalled();
  });
});
