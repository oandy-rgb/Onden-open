import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ body: vi.fn() }));
vi.mock("../lib/data", () => ({ reads: { notes: { body: h.body } } }));
vi.mock("../lib/appStore", () => ({ useOnline: () => true }));
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ canEdit: (n: { space_id?: string }) => n.space_id !== "ro" }),
}));

import { useLinkTargets } from "../hooks/useLinkTargets";
import type { ContentNode } from "../lib/api";

const node = (id: string, title: string, extra: Partial<ContentNode> = {}) => ({ id, title, markdown: "", ...extra }) as ContentNode;
const nodes = [node("cur", "Current"), node("a", "Alpha"), node("ro", "Locked", { space_id: "ro" })];
const opts = (text = "My own text\n\n# Own heading") => ({ nodes, currentId: "cur", currentText: () => text });
const kinds = (rows: Array<{ target: { kind: string; text: string } }> | undefined) => rows?.map((r) => r.target.text);

beforeEach(() => h.body.mockReset());

describe("useLinkTargets", () => {
  it("is null until the typed text names a note", () => {
    const { result } = renderHook(() => useLinkTargets("Alp", opts()));
    expect(result.current).toBeNull();
    expect(renderHook(() => useLinkTargets(null, opts())).result.current).toBeNull();
  });

  it("lists another note's targets from the data layer, loading first", async () => {
    h.body.mockResolvedValue("# Plan\n\nStep one");
    const { result } = renderHook(() => useLinkTargets("Alpha#", opts()));
    expect(result.current?.status).toBe("loading");
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    expect(kinds(result.current?.rows)).toEqual(["Plan", "Step one"]);
    expect(result.current?.rows.every((r) => r.writable && !r.sameNote)).toBe(true);
  });

  it("reads what the offline copy has (reads.notes.body answers from it)", async () => {
    h.body.mockResolvedValue("only the mirror has this");
    const { result } = renderHook(() => useLinkTargets("Alpha#^", opts()));
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    expect(kinds(result.current?.rows)).toEqual(["only the mirror has this"]);
  });

  it("says so when the body cannot be read at all", async () => {
    h.body.mockResolvedValue(null);
    const { result } = renderHook(() => useLinkTargets("Alpha#", opts()));
    await waitFor(() => expect(result.current?.status).toBe("unavailable"));
  });

  it("marks a note the person may not edit as not writable", async () => {
    h.body.mockResolvedValue("para");
    const { result } = renderHook(() => useLinkTargets("Locked#^", opts()));
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    expect(result.current?.rows[0]?.writable).toBe(false);
  });

  it("[[# reads the editor's own text, not the data layer", () => {
    const { result } = renderHook(() => useLinkTargets("#", opts()));
    expect(h.body).not.toHaveBeenCalled();
    expect(kinds(result.current?.rows)).toEqual(["My own text", "Own heading"]);
    expect(result.current?.rows.every((r) => r.short && r.sameNote)).toBe(true);
  });

  it("filters as the query grows without reading the note again", async () => {
    h.body.mockResolvedValue("# Plan\n\nStep one\n\nStep two");
    const { result, rerender } = renderHook(({ q }) => useLinkTargets(q, opts()), { initialProps: { q: "Alpha#" } });
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    rerender({ q: "Alpha#two" });
    expect(kinds(result.current?.rows)).toEqual(["Step two"]);
    expect(h.body).toHaveBeenCalledTimes(1);
  });
});
