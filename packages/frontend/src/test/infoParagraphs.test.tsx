// 「本篇的段落」 in the info panel and the words of 獨立出去 / 收回原文: shown only where the server has paragraph
// anchors on; grouped by topic and nested; a standing paragraph opens its note; a lost one is listed apart and can be
// pointed at a paragraph again; offline the note's own text answers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import InfoParagraphs from "../components/InfoParagraphs";
import type { ContentNode } from "../lib/api";
import { setBlockAnchorsEnabled } from "../lib/blockAnchorStore";
import { holdAnchored } from "./helpers/anchoredText";
import { toolLabel, SELECTION_TOOLS } from "../lib/toolbarLayout";
import type { NoteParagraph } from "@onden/contract";

const served = vi.hoisted(() => ({ rows: null as unknown, reassign: vi.fn(async () => true) }));
vi.mock("../lib/data", async (original) => ({
  ...await original<typeof import("../lib/data")>(),
  reads: { notes: { paragraphs: vi.fn(async () => served.rows) } },
  blockChildWriter: { reassign: served.reassign },
}));
const reveal = vi.hoisted(() => vi.fn());
vi.mock("../lib/noteReveal", () => ({ revealBlockInNote: reveal }));

const node = (markdown: string) => ({ id: "n1", title: "T", markdown, node_type: "content" }) as unknown as ContentNode;
const row = (over: Partial<NoteParagraph> & { id: string }): NoteParagraph => ({
  parentId: null, label: over.id, topics: [], where: "here", noteId: null, anchorStatus: "valid", blockRef: `r-${over.id}`, ...over,
});

beforeEach(() => { served.rows = null; reveal.mockClear(); served.reassign.mockClear(); });
afterEach(() => { setBlockAnchorsEnabled(false); });

describe("InfoParagraphs", () => {
  it("shows nothing where anchors are off", () => {
    setBlockAnchorsEnabled(false);
    const { container } = render(<InfoParagraphs node={node("二分搜尋 {演算法} ^abc123\n")} canEdit onOpen={vi.fn()} />);
    expect(container.textContent).toBe("");
  });

  it("lists paragraphs under their topic, nested, and opens the note at the one clicked", async () => {
    setBlockAnchorsEnabled(true);
    served.rows = [
      row({ id: "a", label: "二分搜尋先排序", topics: ["演算法"] }),
      row({ id: "b", label: "邊界要用 lo <= hi", topics: ["演算法"], parentId: "a" }),
      row({ id: "c", label: "只是任務" }),
    ];
    const onOpen = vi.fn();
    render(<InfoParagraphs node={node("x")} canEdit onOpen={onOpen} />);
    await screen.findByText("二分搜尋先排序");
    expect(screen.getByText("演算法")).toBeTruthy();
    expect(screen.getByText("No topic")).toBeTruthy();
    const nested = screen.getByText("邊界要用 lo <= hi").closest("button")!;
    expect(nested.style.getPropertyValue("--depth")).toBe("1");
    fireEvent.click(nested);
    expect(reveal).toHaveBeenCalledWith("n1", "r-b");
    expect(onOpen).toHaveBeenCalledWith("n1");
  });

  it("a paragraph standing alone is marked and opens its own note; without the right to open it, it is only listed", async () => {
    setBlockAnchorsEnabled(true);
    served.rows = [
      row({ id: "s", label: "獨立的一段", where: "standing", noteId: "kid", topics: ["考點"] }),
      row({ id: "p", label: "進不去的一段", where: "standing", noteId: null, topics: ["考點"] }),
    ];
    const onOpen = vi.fn();
    render(<InfoParagraphs node={node("x")} canEdit onOpen={onOpen} />);
    fireEvent.click((await screen.findByText("獨立的一段")).closest("button")!);
    expect(onOpen).toHaveBeenCalledWith("kid");
    expect(screen.getAllByText("Its own note")).toHaveLength(2);
    expect((screen.getByText("進不去的一段").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("a paragraph whose place was lost is listed apart and can be pointed at another paragraph", async () => {
    setBlockAnchorsEnabled(true);
    served.rows = [row({ id: "l", label: "不見的一段", where: "lost", anchorStatus: "lost", topics: ["考點"] })];
    const body = "第一段文字。\n\n第二段文字。\n";
    render(<InfoParagraphs node={node(body)} canEdit onOpen={vi.fn()} />);
    await screen.findByText("Paragraphs not found");
    expect(screen.getByText("不見的一段")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Point it at"), { target: { value: String(body.indexOf("第二段")) } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Point here" })); });
    expect(served.reassign).toHaveBeenCalledWith("n1", "l", body.indexOf("第二段"), body);
    // A read-only reader sees the list but no way to change it.
  });

  it("offline (the server cannot answer) the note's own text is listed", async () => {
    setBlockAnchorsEnabled(true);
    served.rows = null;
    // The anchors this device holds (the text carries no id): the first paragraph has one, the second does not yet.
    const body = holdAnchored("n1", "二分搜尋先排序再比較 {演算法} ^abc123\n\n雜湊表用鍵算出位置 {演算法}\n");
    render(<InfoParagraphs node={node(body)} onOpen={vi.fn()} />);
    expect(await screen.findByText("二分搜尋先排序再比較")).toBeTruthy();
    // A paragraph with no anchor yet has no identity to open, so it is not listed.
    expect(screen.queryByText("雜湊表用鍵算出位置")).toBeNull();
  });
});

describe("the words of the two menu entries", () => {
  it("are 獨立出去 / 收回原文 with anchors on, and the old words with them off — same buttons either way", () => {
    const toChild = SELECTION_TOOLS.find((t) => t.id === "toChild")!;
    const expand = SELECTION_TOOLS.find((t) => t.id === "expand")!;
    setBlockAnchorsEnabled(false);
    expect([toolLabel(toChild), toolLabel(expand)]).toEqual(["Turn into a child note", "Expand back into the text"]);
    setBlockAnchorsEnabled(true);
    expect([toolLabel(toChild), toolLabel(expand)]).toEqual(["Stand alone as its own note", "Take back into the text"]);
    expect(toolLabel(SELECTION_TOOLS.find((t) => t.id === "bold")!)).toBe("Bold");
  });
});
