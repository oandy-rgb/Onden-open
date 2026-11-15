import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import OverviewEditor from "../components/OverviewEditor";
import { apiFetch, ApiError, type ContentNode } from "../lib/api";
import { setOnline } from "../lib/appStore";
import { mergeInk, noteDoc, notePages, type InkDocument, type InkPages } from "@onden/markdown/ink";

// 深入審查 ink-1（docs/archive/deep-review-ink-2026-11-11.md）：走真的存檔管線（saveInk → 寫入佇列 → 傳輸），
// 注入「這次寫入被永久拒絕」。下一次存檔的 base 不能是那次沒被收下的內容，否則伺服器的三向合併
// 會把那次獨有的筆畫判成「另一邊刪掉了」。

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn(), api: apiMock }));
vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(),
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  addPendingWrite: vi.fn(async () => null),
  getPendingWrites: vi.fn(async () => []),
  upsertAttribute: vi.fn(async () => null),
  removeAttribute: vi.fn(async () => null),
}));

const stroke = (id: string) => ({ id, points: [[0, 0], [10, 10]], color: "#000", size: 2, toolId: "pen" });
const doc = (...ids: string[]) => ({ version: 1, strokes: ids.map(stroke), erased: {}, page: { width: 1000 } }) as InkDocument;

vi.mock("../components/InkNodeView", () => ({
  default: ({ initialPages, onPagesChange }: { initialPages: InkPages; onPagesChange: (pages: InkPages) => void }) => (
    <>
      <button onClick={() => onPagesChange(notePages(doc("a", "b")))}>draw b</button>
      <button onClick={() => onPagesChange(notePages(doc("a", "b", "c")))}>draw c</button>
      <span>{noteDoc(initialPages)?.strokes.length} loaded</span>
    </>
  ),
}));

const node: ContentNode = { id: "n1", title: "Page", slug: "page", markdown: "", node_type: "content", source_type: "manual" };
const settle = () => new Promise((r) => setTimeout(r, 50));
const saves = () => apiMock.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => JSON.parse(String(init.body)) as { value: string; base_value: string });

describe("ink-1：被永久拒絕的存檔不讓後面的存檔把它的筆畫判成已刪除", () => {
  it("第一次存檔被拒絕後，第二次存檔的 base 仍是載入時的內容，伺服器合併後三筆都在", { timeout: 20_000 }, async () => {
    const B0 = doc("a");
    vi.mocked(apiFetch).mockImplementation(async (path) => new Response(JSON.stringify(String(path).startsWith(`/api/nodes/${node.id}/attributes?`) ? [{ key: "ink_data", value: JSON.stringify(B0) }] : []), { status: 200 }));
    apiMock.mockReset();
    setOnline(true);
    let puts = 0;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method !== "PUT" || !path.endsWith("/attributes/ink_data")) return [];
      if (puts++ === 0) throw new ApiError(403, JSON.stringify({ error: "forbidden" }));
      return {};
    });
    render(<OverviewEditor node={node} titleDraft="Page" onTitleChange={() => {}} draft="" onDraftChange={() => {}}
      view="edit" setView={() => {}} saveStatus="saved" onSave={() => {}} online nodes={[node]}
      onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "draw b" }, { timeout: 10_000 }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "draw c" }));
    await settle();
    expect(saves()).toHaveLength(2);
    expect(JSON.parse(saves()[1]!.base_value).strokes.map((s: { id: string }) => s.id)).toEqual(["a"]);
    // 伺服器仍是 B0（第一次被拒）：用它的合併規則確認 b 沒有被丟掉。
    const { value, base_value } = saves()[1]!;
    const merged = JSON.parse(mergeInk(base_value, JSON.stringify(B0), value).value) as InkDocument;
    expect(merged.strokes.map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
  });
});
