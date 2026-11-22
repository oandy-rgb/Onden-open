import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ContentNode } from "../lib/api";
import { mergeInk, noteDoc, notePages, type InkDocument, type InkPages } from "@onden/markdown/ink";
import { INK_COLORS } from "../components/InkToolbar";
import { INK_SIZES } from "../lib/inkSizes";
import { useInkPen } from "../hooks/useInkPen";
import { idleBoardHistory } from "./helpers/boardHistory";
// 每個測試重新載入模組：寫入通道、離線佇列與保存狀態是模組內的，不能從上一個測試帶過來。
import { memoryQueue } from "./helpers/memoryQueue";

// 深入審查 ink-1（docs/archive/deep-review-ink-2026-11-11.md）：存檔的 base 是「伺服器最後收下的內容」，不是「最後送出的內容」。
// 這裡走真的存檔管線（InkSaver → saveInk → 寫入佇列 → 傳輸），傳輸端是一台照 mergeInk 合併的假伺服器，
// 手寫頁（OverviewEditor）、「手寫」分頁（HandwritingPane）、白板筆層（CanvasInkLayer）各跑同一組情境：
// 畫一筆、那次存檔沒被收下、再畫一筆、存檔成功、重新載入，兩筆都要在。

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn(), api: apiMock }));
vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(),
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  addPendingWrite: vi.fn(async () => null),
  getPendingWrites: vi.fn(async () => []),
  clearPendingWrite: vi.fn(async () => {}),
  bumpPendingWriteAttempt: vi.fn(async () => {}),
  rejectPendingWrite: vi.fn(async () => { throw new Error("set by the test that needs it"); }),
  upsertAttribute: vi.fn(async () => null),
  removeAttribute: vi.fn(async () => null),
}));
vi.mock("../lib/ink/store", async (original) => ({
  ...await original<typeof import("../lib/ink/store")>(),
  loadInkPage: vi.fn(async () => (hostLoad.board)),
}));
const hostLoad = vi.hoisted(() => ({ board: null as unknown }));

const stroke = (id: string) => ({ id, points: [[0, 0, 0.5], [10, 10, 0.5]] as Array<[number, number, number]>, color: "#000", size: 2, toolId: "pen" });
const doc = (...ids: string[]) => ({ version: 1, strokes: ids.map(stroke), erased: {}, page: { width: 1000 } }) as InkDocument;
const idsOf = (text: string): string[] => (JSON.parse(text) as InkDocument).strokes.map((s) => s.id).sort();

vi.mock("../components/InkNodeView", () => ({
  default: ({ initialPages, onPagesChange }: { initialPages: InkPages; onPagesChange: (pages: InkPages) => void }) => (
    <>
      <button onClick={() => onPagesChange(notePages(doc("a", "b")))}>draw 1</button>
      <button onClick={() => onPagesChange(notePages(doc("a", "b", "c")))}>draw 2</button>
      <span>{noteDoc(initialPages)?.strokes.length} loaded</span>
    </>
  ),
}));

/** The server: one stored text per attribute path, saves merged into it by their base the way services/attributeWrites.ts does. */
class Server {
  stored: string;
  puts = 0;
  /** The strokes of the newest drawing a host sent: what the person sees (the sent value may hold a merge, so the newest is what they drew last). */
  shown: string[] = [];
  /** What the next PUTs do, in order: "ok", "refuse" (403), "drop" (no answer: the transport fails), or a function that decides later. */
  script: Array<"ok" | "refuse" | "drop" | Promise<"ok" | "refuse">> = [];
  constructor(initial: string) { this.stored = initial; }
  put(body: { value: string; base_value?: string }): { value: string } {
    const { value, base_value: base } = body;
    this.stored = base === undefined || this.stored === "" || this.stored === base || this.stored === value ? value : mergeInk(base, this.stored, value).value;
    return { value: this.stored };
  }
  /** Another device's save, made from what it loaded. */
  otherDevice(strokeId: string): void {
    const loaded = this.stored;
    const next = JSON.parse(loaded) as InkDocument;
    next.strokes = [...next.strokes, stroke(strokeId)];
    this.put({ value: JSON.stringify(next), base_value: loaded });
  }
}

let server: Server;
const attrPath = (id: string, attr: string) => `/api/nodes/${id}/attributes/${attr}`;
function wire(nodeId: string, attr: string, initial: string): void {
  server = new Server(initial);
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method !== "PUT" || path !== attrPath(nodeId, attr)) return [];
    server.puts++;
    server.shown = JSON.parse(JSON.parse(String(init.body)).value).strokes.map((s: { id: string }) => s.id);
    const step = await (server.script.shift() ?? "ok");
    if (step === "refuse") throw new (await import("../lib/api")).ApiError(403, JSON.stringify({ error: "forbidden" }));
    if (step === "drop") throw new TypeError("Failed to fetch");
    return server.put(JSON.parse(String(init.body)));
  });
}

const node: ContentNode = { id: "n1", title: "Page", slug: "page", markdown: "", node_type: "content", source_type: "manual" };
const settle = () => new Promise((r) => setTimeout(r, 50));
const B0 = JSON.stringify(doc("a"));

type Host = { attr: string; mount: () => Promise<void>; draw: (n: 1 | 2) => Promise<void>; shown: () => string[] | null };

async function loadAttrs(attr: string): Promise<void> {
  const { apiFetch } = await import("../lib/api");
  vi.mocked(apiFetch).mockImplementation(async (path) => new Response(JSON.stringify(String(path).startsWith(`/api/nodes/${node.id}/attributes?`) ? [{ key: attr, value: B0 }] : []), { status: 200 }));
}

const overview: Host = {
  attr: "ink_data",
  mount: async () => {
    await loadAttrs("ink_data");
    const { default: OverviewEditor } = await import("../components/OverviewEditor");
    render(<OverviewEditor node={node} titleDraft="Page" onTitleChange={() => {}} draft="" onDraftChange={() => {}}
      view="edit" setView={() => {}} saveStatus="saved" onSave={() => {}} online nodes={[node]}
      onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} />);
    await screen.findByRole("button", { name: "draw 1" }, { timeout: 25_000 });
  },
  draw: async (n) => { fireEvent.click(screen.getByRole("button", { name: `draw ${n}` })); await settle(); },
  shown: () => null,
};
const pane: Host = {
  attr: "note_ink",
  mount: async () => {
    await loadAttrs("note_ink");
    const { default: HandwritingPane } = await import("../modules/handwriting/HandwritingPane");
    render(<HandwritingPane node={node} canEdit onOpenNode={() => {}} />);
    await screen.findByRole("button", { name: "draw 1" }, { timeout: 25_000 });
  },
  draw: overview.draw,
  shown: () => null,
};

function pointer(type: string, o: { x: number; y: number; t: number }): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerId: 1, pointerType: "mouse", button: 0, clientX: o.x, clientY: o.y, pressure: 0.5, getCoalescedEvents: () => [] });
  Object.defineProperty(e, "timeStamp", { value: o.t });
  return e;
}
let capture: HTMLElement;
let strokesDrawn = 0;
const board: Host = {
  attr: "board_ink",
  mount: async () => {
    hostLoad.board = JSON.parse(B0);
    strokesDrawn = 0;
    const { default: CanvasInkLayer } = await import("../components/CanvasInkLayer");
    function Layer() {
      const pen = useInkPen({ color: INK_COLORS[0].value, sizeId: INK_SIZES[1].id });
      return <ReactFlowProvider><CanvasInkLayer boardHistory={idleBoardHistory} canvasId={node.id} penActive spaceHeld={false} pen={pen} /></ReactFlowProvider>;
    }
    const view = render(<Layer />);
    await waitFor(() => expect(view.container.querySelector("[data-ink-renderer]")?.getAttribute("data-ink-renderer")).toBeTruthy());
    capture = view.container.querySelector(".canvas-ink-capture") as HTMLElement;
    Object.assign(capture, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
  },
  // One stroke, then the leaving save (the engine's debounce would only fire later): the save is made now.
  draw: async () => {
    const y = 20 + 30 * strokesDrawn++;
    act(() => {
      capture.dispatchEvent(pointer("pointerdown", { x: 20, y, t: 1000 + y }));
      capture.dispatchEvent(pointer("pointermove", { x: 60, y: y + 20, t: 1020 + y }));
      capture.dispatchEvent(pointer("pointerup", { x: 60, y: y + 20, t: 1040 + y }));
    });
    act(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    act(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
  },
  shown: () => null,
};

const HOSTS: Array<[string, Host]> = [["手寫頁（OverviewEditor）", overview], ["「手寫」分頁（HandwritingPane）", pane], ["白板筆層（CanvasInkLayer）", board]];
/** Everything the person drew (the newest drawing a host sent, which includes the loaded stroke) is on the server. */
const everythingIsKept = (extra: string[] = []) => {
  const onServer = idsOf(server.stored);
  expect(server.shown.length).toBeGreaterThanOrEqual(3);
  for (const id of [...server.shown, ...extra]) expect(onServer, `stroke ${id} is missing on the server`).toContain(id);
};

beforeEach(async () => {
  vi.resetModules();
  (await import("../lib/appStore")).setOnline(true);
  hostLoad.board = null;
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, "visibilityState"); });

describe.each(HOSTS)("ink-1 走真的存檔路徑：%s", (_name, host) => {
  it("第一次存檔被拒絕（403），第二次存檔成功、重新載入：兩筆都在", { timeout: 60_000 }, async () => {
    wire(node.id, host.attr, B0);
    server.script = ["refuse", "ok"];
    await host.mount();
    await host.draw(1);
    expect(server.stored).toBe(B0);
    await host.draw(2);
    expect(server.puts).toBeGreaterThanOrEqual(2);
    // 重新載入看到的就是伺服器現在的內容：載入時的 a 加上這次畫的兩筆。
    everythingIsKept();
  });

  it("第一次存檔還沒有回應時畫了第二筆，之後第一次被拒絕：兩筆都在（第二次不能把第一次的筆畫判成已刪除）", { timeout: 60_000 }, async () => {
    wire(node.id, host.attr, B0);
    let refuseFirst!: (v: "refuse") => void;
    server.script = [new Promise<"refuse">((resolve) => { refuseFirst = resolve; }), "ok", "ok", "ok"];
    await host.mount();
    await host.draw(1); // 沒有回應
    await host.draw(2);
    refuseFirst("refuse");
    await settle(); await settle();
    everythingIsKept();
  });

  it("兩台裝置：這台第一次存檔被拒絕的時候，另一台已存了一筆：三方都留下", { timeout: 60_000 }, async () => {
    wire(node.id, host.attr, B0);
    server.script = ["refuse", "ok", "ok"];
    await host.mount();
    await host.draw(1);
    server.otherDevice("x");
    await host.draw(2);
    everythingIsKept(["x"]);
  });

  it("伺服器一直沒回應（連線失敗）：兩次存檔都留在離線佇列，依序送出後兩筆都在", { timeout: 60_000 }, async () => {
    const { addPendingWrite, getPendingWrites, clearPendingWrite } = await import("../lib/localDb");
    const queue = memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
    wire(node.id, host.attr, B0);
    server.script = ["drop", "drop"];
    await host.mount();
    await host.draw(1);
    await host.draw(2);
    expect(server.stored).toBe(B0);
    expect(queue.rows.length).toBeGreaterThanOrEqual(2);
    // 佇列自己重送（真的 writeQueue 的排空）：依序、每筆帶著自己的 base。
    await waitFor(() => expect(queue.rows).toHaveLength(0), { timeout: 20_000 });
    everythingIsKept();
  });

  // 審查 2026-11-20（#1910）：只有離線佇列握著存檔時，InkSaver 把它當成已收下並把 base 移過去（surfaceSaver 的 `stored === null`）。
  // 佇列送出時第一筆被拒絕，writeQueue 的 drain 處理下一列：第二筆帶著 base＝被拒絕的那一份，伺服器合出
  // mergeInk(V1, 現存, V2)，V1 獨有的筆畫在伺服器上不見、畫面上還在，InkSaver 不會被告知。
  // 已重現（三個宿主都是），還沒修：這是「離線佇列」這條路的 ink-1，連線存檔的 ink-1 已結案。
  // 被拒絕的那一筆的內容進了「被拒絕」區（使用者會看到「已排隊的變更被拒絕」），所以不是無聲地丟，但伺服器上少了那一筆、
  // 之後的存檔也不會補。修好後把 `.fails` 拿掉。修法要放在 InkSaver／writeQueue 的同一處，不要各入口補（見 PR #1910 說明）。
  it.fails("離線佇列送出時第一筆被拒絕、第二筆被收下：畫面上的兩筆都在伺服器上", { timeout: 60_000 }, async () => {
    const { addPendingWrite, getPendingWrites, clearPendingWrite } = await import("../lib/localDb");
    memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
    // 被拒的那一列離開佇列、進「被拒絕」區（真的 localDb 在 worker 裡一起做）。
    const local = await import("../lib/localDb");
    vi.mocked(local.rejectPendingWrite).mockImplementation(async (write, reason) => {
      await local.clearPendingWrite(write.id, write.idem_key);
      return { ...write, rejection: reason } as unknown as Awaited<ReturnType<typeof local.rejectPendingWrite>>;
    });
    wire(node.id, host.attr, B0);
    // 第一筆：連線失敗進佇列；佇列送出時被拒絕；第二筆（base＝第一筆）被收下。
    server.script = ["drop", "refuse", "ok", "ok", "ok"];
    await host.mount();
    await host.draw(1);
    await host.draw(2);
    await waitFor(() => expect(server.puts).toBeGreaterThanOrEqual(3), { timeout: 20_000 });
    await settle();
    everythingIsKept();
  });
});
