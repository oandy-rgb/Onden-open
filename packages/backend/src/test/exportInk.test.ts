import { describe, expect, it } from "vitest";
import { encodeInk, type InkDocument } from "@onden/markdown/ink";
import { noteInkFiles } from "../services/exportInk.js";

// 深入審查 ink-3：白板筆記的 board_ink（筆畫層）與 ink_data（筆記自己的手寫頁）各是一張圖，兩者都有時都要匯出。
const doc = (x: number): InkDocument => ({
  version: 1, erased: {}, page: { width: 1000 },
  strokes: [{ id: `s${x}`, color: "#d33", size: 4, toolId: "pen", points: [[x, 40], [x + 60, 90], [x + 180, 140]] }],
});
const board = [{ id: "v1", name: "Canvas", layout: "canvas", layout_config: {} }];
const note = { id: "aaaaaaaa-0000-4000-8000-000000000001", node_type: "content", collection_views: board };

describe("noteInkFiles：白板筆記", () => {
  it("board_ink 與 ink_data 都有：兩張圖，筆畫層在前", () => {
    const files = noteInkFiles(note, [{ key: "board_ink", value: encodeInk(doc(-300)) }, { key: "ink_data", value: encodeInk(doc(10)) }], new Set());
    expect(files.map((f) => f.name)).toEqual(["ink-aaaaaaaa-1.svg", "ink-aaaaaaaa-2.svg"]);
    expect(files[0]!.svg).not.toBe(files[1]!.svg);
  });
  it("只有 board_ink：一張圖；只有 ink_data：也一張", () => {
    expect(noteInkFiles(note, [{ key: "board_ink", value: encodeInk(doc(-300)) }], new Set())).toHaveLength(1);
    expect(noteInkFiles(note, [{ key: "ink_data", value: encodeInk(doc(10)) }], new Set())).toHaveLength(1);
    expect(noteInkFiles(note, [], new Set())).toHaveLength(0);
  });
});

describe("noteInkFiles：筆畫層的各種內容（掃描 08 #1/#2）", () => {
  const shapesOnly: InkDocument = { version: 1, erased: {}, page: { width: 1000 }, strokes: [], shapes: [{ id: "h1", kind: "rectangle", start: [-300, -200], end: [-100, 0], color: "#aa1100", size: 4 }] };
  const empty: InkDocument = { version: 1, erased: {}, page: { width: 1000 }, strokes: [] };
  const own = encodeInk({ ...doc(10), strokes: [{ ...doc(10).strokes[0]!, color: "#00bb11" }] });
  const colors = (svg: string) => ["#aa1100", "#d33", "#00bb11"].filter((c) => svg.toLowerCase().includes(c));

  it("只有形狀的筆畫層也匯出，並與手寫頁分開（第一張是白板的、第二張是手寫頁的）", () => {
    const files = noteInkFiles(note, [{ key: "board_ink", value: encodeInk(shapesOnly) }, { key: "ink_data", value: own }], new Set());
    expect(files).toHaveLength(2);
    expect(colors(files[0]!.svg)).toEqual(["#aa1100"]);
    expect(colors(files[1]!.svg)).toEqual(["#00bb11"]);
  });
  it("空的筆畫層不產生圖；手寫頁仍是手寫頁，不會被當成白板的筆畫", () => {
    const files = noteInkFiles(note, [{ key: "board_ink", value: encodeInk(empty) }, { key: "ink_data", value: own }], new Set());
    expect(files).toHaveLength(1);
    expect(colors(files[0]!.svg)).toEqual(["#00bb11"]);
  });
  it("白板只有 ink_data 時不會把它當成白板筆畫層重複輸出", () => {
    expect(noteInkFiles(note, [{ key: "ink_data", value: own }], new Set())).toHaveLength(1);
  });
});

describe("noteInkFiles：手寫分頁（note_ink）", () => {
  const tab = [{ id: "v2", name: "Handwriting", layout: "handwriting", layout_config: {} }];
  const plain = { id: "bbbbbbbb-0000-4000-8000-000000000002", node_type: "content" };
  it("有分頁才匯出它的頁；拿掉分頁後筆畫還在、但不匯出", () => {
    const attributes = [{ key: "note_ink", value: encodeInk(doc(20)) }];
    expect(noteInkFiles({ ...plain, collection_views: tab }, attributes, new Set())).toHaveLength(1);
    expect(noteInkFiles({ ...plain, collection_views: [] }, attributes, new Set())).toHaveLength(0);
  });
});
