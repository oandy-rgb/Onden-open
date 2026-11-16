// The answer side of the review screen: where the card comes from, the four
// visible actions (open, edit, tomorrow, stop), and each grade's next interval
// as the server computed it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReviewCard } from "@onden/contract";
import ReviewPanel from "./ReviewPanel";
import { resetAppState } from "../../lib/appStore";

vi.mock("../../lib/liveEvents", () => ({
  isLiveConnected: () => false,
  subscribeLiveTicks: (_listener: unknown, connection?: (connected: boolean) => void) => { connection?.(false); return () => {}; },
}));
vi.mock("../../components/MarkdownRenderer", () => ({
  default: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));
const reveal = vi.hoisted(() => vi.fn());
vi.mock("../../lib/noteReveal", () => ({ revealBlockInNote: reveal }));
// The sheet is the editor's own (components/EmbedEditSheet, tested there); here only what the screen hands it.
vi.mock("./ReviewEditSheet", () => ({
  default: (props: { nodeId: string; blockRef: string | null; onClose: () => void }) => (
    <div role="dialog" aria-label="edit sheet" data-node={props.nodeId} data-block={props.blockRef ?? ""}>
      <button onClick={props.onClose}>close sheet</button>
    </div>
  ),
}));

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let queued: ReviewCard[] = [];
let writeStatus = 200;
let stopped: Array<{ node_id: string; title: string; lapses: number; block: { id: string; ref: string } | null }> = [];
beforeEach(() => {
  calls = []; resetAppState(); writeStatus = 200; stopped = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/queue")) return new Response(JSON.stringify({ cards: queued, total: queued.length }));
    if (url.endsWith("/stopped")) return new Response(JSON.stringify({ stopped }));
    return new Response(JSON.stringify(writeStatus === 200 ? { ok: true } : { error: "database_exploded: stack at db.ts:12" }), { status: writeStatus });
  }) as unknown as typeof fetch;
});
afterEach(() => { vi.restoreAllMocks(); reveal.mockClear(); });

const noteCard = (n: number, over: Partial<ReviewCard> = {}): ReviewCard => ({
  node_id: `note-${n}`, title: `Card ${n}`, markdown: `body ${n}`, ink_data: null, state: null, block: null,
  next_days: { 1: 1, 2: 3, 3: 6, 4: 15 },
  context: { source_title: "Computer organization", before: null, after: null },
  ...over,
});
const blockCard = (): ReviewCard => noteCard(0, {
  node_id: "note-7", title: "What is a register?", markdown: "A small fast store.", block: { id: "blk-1", ref: "ref-1" },
  context: { source_title: "Architecture notes", before: "The CPU has several parts.", after: "A cache sits between them." },
});
const showAnswer = async () => userEvent.click(await screen.findByRole("button", { name: /Show answer/ }));

describe("review screen: after the answer", () => {
  it("shows the source's name and the paragraphs before and after a paragraph card", async () => {
    queued = [blockCard()];
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await showAnswer();
    const context = screen.getByRole("region", { name: "Where this card comes from" });
    expect(within(context).getByText("From Architecture notes")).toBeInTheDocument();
    expect(within(context).getByText("The CPU has several parts.")).toBeInTheDocument();
    expect(within(context).getByText("A cache sits between them.")).toBeInTheDocument();
  });

  it("names the parent for a whole-note card, with no neighbouring text", async () => {
    queued = [noteCard(1)];
    render(<ReviewPanel online onOpenNode={() => {}} />);
    expect(screen.queryByRole("region", { name: "Where this card comes from" })).toBeNull(); // not before the answer
    await showAnswer();
    const context = screen.getByRole("region", { name: "Where this card comes from" });
    expect(within(context).getByText("Inside Computer organization")).toBeInTheDocument();
    expect(context.querySelectorAll(".review-context-near")).toHaveLength(0);
  });

  it("offers open, edit, tomorrow and stop as buttons in plain sight, not in a menu", async () => {
    queued = [blockCard()];
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await showAnswer();
    for (const name of ["Open this paragraph", "Edit this paragraph", "Tomorrow", "Stop reviewing this"]) {
      expect(screen.getByRole("button", { name })).toBeVisible();
    }
    expect(document.querySelector("[aria-haspopup]")).toBeNull();
  });

  it("each grade button shows the interval the server answered, in words", async () => {
    queued = [noteCard(1, { next_days: { 1: 2, 2: 9, 3: 40, 4: 400 } })];
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await showAnswer();
    expect(screen.getByRole("button", { name: /Again/ })).toHaveTextContent("in 2 days");
    expect(screen.getByRole("button", { name: /Hard/ })).toHaveTextContent("in 9 days");
    expect(screen.getByRole("button", { name: /Good/ })).toHaveTextContent("in 1 month");
    expect(screen.getByRole("button", { name: /Easy/ })).toHaveTextContent("in 1.1 years");
  });

  it("open goes to the source at that paragraph; a whole-note card just opens the note", async () => {
    const open = vi.fn();
    queued = [blockCard()];
    const { unmount } = render(<ReviewPanel online onOpenNode={open} />);
    await showAnswer();
    await userEvent.click(screen.getByRole("button", { name: "Open this paragraph" }));
    expect(reveal).toHaveBeenCalledWith("note-7", "ref-1");
    expect(open).toHaveBeenCalledWith("note-7");
    unmount();
    reveal.mockClear();
    queued = [noteCard(2)];
    render(<ReviewPanel online onOpenNode={open} />);
    await showAnswer();
    await userEvent.click(screen.getByRole("button", { name: "Open the note" }));
    expect(reveal).not.toHaveBeenCalled();
    expect(open).toHaveBeenLastCalledWith("note-2");
  });

  it("edit opens the editor's sheet on that paragraph, and closing it re-reads the queue", async () => {
    queued = [blockCard()];
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await showAnswer();
    await userEvent.click(screen.getByRole("button", { name: "Edit this paragraph" }));
    const sheet = await screen.findByRole("dialog", { name: "edit sheet" });
    expect(sheet).toHaveAttribute("data-node", "note-7");
    expect(sheet).toHaveAttribute("data-block", "ref-1");
    const reads = calls.filter(call => call.url.includes("/queue")).length;
    queued = [{ ...blockCard(), markdown: "A small, fast store inside the CPU." }];
    await userEvent.click(screen.getByRole("button", { name: "close sheet" }));
    await waitFor(() => expect(document.querySelector(".review-card-body")).toHaveTextContent("A small, fast store inside the CPU."));
    expect(calls.filter(call => call.url.includes("/queue")).length).toBeGreaterThan(reads);
    expect(screen.queryByRole("dialog", { name: "edit sheet" })).toBeNull();
  });

  it("a whole-note card is edited as the whole note", async () => {
    queued = [noteCard(3)];
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await showAnswer();
    await userEvent.click(screen.getByRole("button", { name: "Edit this note" }));
    expect(await screen.findByRole("dialog", { name: "edit sheet" })).toHaveAttribute("data-block", "");
  });

  it.each([
    ["Tomorrow", "tomorrow", "Put off until tomorrow."],
    ["Stop reviewing this", "suspend", "Stopped. You can bring it back from Review status."],
  ])("%s grades nothing, moves on to the next card and says so", async (label, route, notice) => {
    queued = [noteCard(1), noteCard(2)];
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await showAnswer();
    await userEvent.click(screen.getByRole("button", { name: label }));
    await screen.findByText("Card 2");
    expect(screen.getByRole("status")).toHaveTextContent(notice);
    expect(calls.some(call => call.url.endsWith(`/api/review/note-1/${route}`) && call.init?.method === "POST")).toBe(true);
    expect(calls.some(call => call.url.includes("/grade"))).toBe(false);
    expect(screen.queryByRole("button", { name: "Undo last grade" })).toBeNull(); // nothing was graded
  });

  it("works on a paragraph card's own route", async () => {
    queued = [blockCard()];
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await showAnswer();
    await userEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    await waitFor(() => expect(calls.some(call => call.url.endsWith("/api/review/blocks/blk-1/tomorrow"))).toBe(true));
  });

  it("a refused request keeps the card and shows a plain message, never the server's text", async () => {
    queued = [noteCard(1)];
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await showAnswer();
    writeStatus = 500;
    await userEvent.click(screen.getByRole("button", { name: "Stop reviewing this" }));
    const message = await waitFor(() => { const el = document.querySelector(".review-error"); expect(el).not.toBeNull(); return el!; });
    expect(message.textContent).not.toMatch(/database_exploded|stack|db\.ts/);
    expect(screen.getByText("Card 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop reviewing this" })).toBeEnabled();
  });

  it("offline, edit, tomorrow and stop cannot be used", async () => {
    queued = [noteCard(1)];
    render(<ReviewPanel online={false} onOpenNode={() => {}} />);
    await act(async () => {});
    // Offline the queue still came from the mock; the buttons that write are off.
    await showAnswer();
    for (const name of ["Edit this note", "Tomorrow", "Stop reviewing this"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open the note" })).toBeEnabled();
  });

  it("still draws the grade buttons when the server sent no intervals (an older server)", async () => {
    queued = [{ ...noteCard(1), next_days: undefined } as unknown as ReviewCard];
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await showAnswer();
    for (const name of [/Again/, /Hard/, /Good/, /Easy/]) expect(screen.getByRole("button", { name })).toBeEnabled();
    expect(document.querySelector(".review-grade-next")).toBeNull();
  });

  it.each([
    ["Tomorrow", "tomorrow"],
    ["Stop reviewing this", "suspend"],
  ])("%s can be taken back: the card returns and the hold is cleared", async (label) => {
    queued = [noteCard(1)];
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await showAnswer();
    await userEvent.click(screen.getByRole("button", { name: label }));
    await userEvent.click(await screen.findByRole("button", { name: "Bring it back" }));
    expect(calls.some(call => call.url.endsWith("/api/review/note-1/resume") && call.init?.method === "POST")).toBe(true);
    await screen.findByText("Card 1");
    expect(screen.queryByRole("button", { name: "Bring it back" })).toBeNull();
  });

  it("a grade refused because the card was stopped elsewhere says so in plain words", async () => {
    queued = [noteCard(1), noteCard(2)];
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await showAnswer();
    writeStatus = 409;
    await userEvent.click(screen.getByRole("button", { name: /Good/ }));
    const message = await waitFor(() => { const el = document.querySelector(".review-error"); expect(el).not.toBeNull(); return el!; });
    expect(message.textContent).toBe("This card changed on another device, so it was not graded.");
    expect(message.textContent).not.toMatch(/database_exploded|stack/);
  });
});

describe("a note's own review: cards stopped in it", () => {
  const inNote = [
    { node_id: "note-5", title: "Pipelines", lapses: 0, block: null },
    { node_id: "note-9", title: "Hazards", lapses: 0, block: { id: "blk-9", ref: "ref-9" } },
  ];

  it("reads the stopped cards once when it opens and offers each one back", async () => {
    stopped = inNote;
    queued = [];
    render(<ReviewPanel online onOpenNode={() => {}} rootId="note-root" rootTitle="Textbook" />);
    const here = await screen.findByRole("region", { name: "Stopped in this note" });
    expect(within(here).getByText("2 cards in this note are stopped.")).toBeInTheDocument();
    expect(calls.filter(call => call.url.endsWith("/api/review/note-root/stopped"))).toHaveLength(1);
    queued = [noteCard(5, { node_id: "note-5" })];
    await userEvent.click(within(here).getAllByRole("button", { name: "Start reviewing again" })[0]!);
    await waitFor(() => expect(calls.some(call => call.url.endsWith("/api/review/note-5/resume") && call.init?.method === "POST")).toBe(true));
    await screen.findByText("Card 5"); // the queue was read again
    expect(within(await screen.findByRole("region", { name: "Stopped in this note" })).getAllByRole("button", { name: "Start reviewing again" })).toHaveLength(1);
    // A paragraph card goes back by its own route.
    await userEvent.click(screen.getByRole("button", { name: "Start reviewing again" }));
    await waitFor(() => expect(calls.some(call => call.url.endsWith("/api/review/blocks/blk-9/resume"))).toBe(true));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Stopped in this note" })).toBeNull());
    expect(calls.filter(call => call.url.endsWith("/stopped"))).toHaveLength(1); // read once, not again
  });

  it("shows nothing when none are stopped, and reads nothing for the all-cards review", async () => {
    queued = [];
    const { unmount } = render(<ReviewPanel online onOpenNode={() => {}} rootId="note-root" rootTitle="Textbook" />);
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Stopped in this note" })).toBeNull();
    unmount();
    calls = [];
    render(<ReviewPanel online onOpenNode={() => {}} />);
    await act(async () => {});
    expect(calls.some(call => call.url.endsWith("/stopped"))).toBe(false);
  });

  it("offline it cannot start them again, and shows no ids", async () => {
    stopped = inNote;
    render(<ReviewPanel online={false} onOpenNode={() => {}} rootId="note-root" rootTitle="Textbook" />);
    const here = await screen.findByRole("region", { name: "Stopped in this note" });
    for (const button of within(here).getAllByRole("button", { name: "Start reviewing again" })) expect(button).toBeDisabled();
    expect(here.textContent).not.toMatch(/blk-9|ref-9|note-5/);
  });
});
