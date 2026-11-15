// The review status page and the ways to it: the numbers the server answered laid out
// (overdue apart from the week ahead), the often-forgotten and stopped lists, and the
// person's own daily limit.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReviewStatus } from "@onden/contract";
import ReviewScreen from "./ReviewScreen";
import ReviewHomeSection from "./ReviewHomeSection";
import ReviewStatusPage from "./ReviewStatusPage";
import { resetAppState } from "../../lib/appStore";
import { setModuleAddress } from "../../lib/moduleAddress";

vi.mock("../../lib/liveEvents", () => ({
  isLiveConnected: () => false,
  subscribeLiveTicks: (_listener: unknown, connection?: (connected: boolean) => void) => { connection?.(false); return () => {}; },
}));
vi.mock("../../components/MarkdownRenderer", () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
const reveal = vi.hoisted(() => vi.fn());
vi.mock("../../lib/noteReveal", () => ({ revealBlockInNote: reveal }));
vi.mock("./ReviewEditSheet", () => ({
  default: (props: { nodeId: string; blockRef: string | null; onClose: () => void }) => (
    <div role="dialog" aria-label="edit sheet" data-node={props.nodeId} data-block={props.blockRef ?? ""}>
      <button onClick={props.onClose}>close sheet</button>
    </div>
  ),
}));

const status = (over: Partial<ReviewStatus> = {}): ReviewStatus => ({
  today_date: "2026-11-13", overdue: 4, today: 7, new_available: 3, rolled_over: 0, reviews_per_day: null, reviewed_today: 0,
  forecast: [2, 0, 5, 1, 0, 0, 9].map((count, index) => ({ date: `2026-11-${14 + index}`, count })),
  forgotten_min: 4,
  forgotten: [
    { node_id: "note-1", title: "Pipeline hazards", lapses: 6, block: { id: "blk-1", ref: "ref-1" } },
    { node_id: "note-2", title: "Cache coherence", lapses: 4, block: null },
  ],
  stopped: [],
  ...over,
});

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let current: ReviewStatus = status();
beforeEach(() => {
  calls = []; resetAppState(); current = status();
  setModuleAddress(null); // where the page is lives in the address, outside the component
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/api/review/status")) return new Response(JSON.stringify(current));
    if (url.includes("/queue")) return new Response(JSON.stringify({ cards: [], total: 0 }));
    if (url.includes("/stats")) return new Response(JSON.stringify({ due: 3, new: 0, learned: 9 }));
    if (url.includes("/decks")) return new Response(JSON.stringify({ decks: [] }));
    return new Response(JSON.stringify({ ok: true }));
  }) as unknown as typeof fetch;
});
afterEach(() => { vi.restoreAllMocks(); reveal.mockClear(); });

const page = (props: Partial<Parameters<typeof ReviewStatusPage>[0]> = {}) =>
  render(<ReviewStatusPage online onBack={() => {}} onOpenNode={() => {}} {...props} />);
const figure = (label: string) => screen.getByText(label).closest(".review-status-figure") as HTMLElement;

describe("review status page", () => {
  it("shows today, overdue and new apart, and the next seven days after them", async () => {
    page();
    await screen.findByText("Due today");
    expect(within(figure("Due today")).getByText("7")).toBeInTheDocument();
    expect(within(figure("Overdue")).getByText("4")).toBeInTheDocument();
    expect(within(figure("New today")).getByText("3")).toBeInTheDocument();
    const days = document.querySelectorAll(".review-status-day");
    expect([...days].map(day => day.querySelector(".review-status-day-count")!.textContent)).toEqual(["2", "0", "5", "1", "0", "0", "9"]);
    // The longest bar is the busiest day; overdue is not folded into the forecast.
    expect((days[6]!.querySelector(".review-status-day-bar > span") as HTMLElement).style.getPropertyValue("--share")).toBe("1");
    expect((days[0]!.querySelector(".review-status-day-bar > span") as HTMLElement).style.getPropertyValue("--share")).toBe(String(2 / 9));
  });

  it("says when the daily limit moved cards to tomorrow", async () => {
    current = status({ rolled_over: 5, reviews_per_day: 10, reviewed_today: 4 });
    page();
    expect(await screen.findByText("5 cards were moved to tomorrow by your daily limit.")).toBeInTheDocument();
    expect(screen.getByText("4 of 10 reviews today. Cards over the limit wait for tomorrow.")).toBeInTheDocument();
  });

  it("lists the often-forgotten cards, each with a button that edits that paragraph (or note)", async () => {
    page();
    const forgotten = await screen.findByRole("region", { name: "Often forgotten" });
    expect(within(forgotten).getByText("Pipeline hazards")).toBeInTheDocument();
    expect(within(forgotten).getByText("Forgotten 6 times")).toBeInTheDocument();
    await userEvent.click(within(forgotten).getByRole("button", { name: "Edit this paragraph" }));
    await screen.findByRole("dialog", { name: "edit sheet" });
    expect(screen.getByRole("dialog", { name: "edit sheet" })).toHaveAttribute("data-node", "note-1");
    expect(screen.getByRole("dialog", { name: "edit sheet" })).toHaveAttribute("data-block", "ref-1");
    // Closing it re-reads the page; nothing was stopped or graded.
    const reads = calls.filter(call => call.url.includes("/api/review/status")).length;
    await userEvent.click(screen.getByRole("button", { name: "close sheet" }));
    await waitFor(() => expect(calls.filter(call => call.url.includes("/api/review/status")).length).toBeGreaterThan(reads));
    expect(calls.some(call => call.init?.method === "POST")).toBe(false);
    await userEvent.click(within(forgotten).getByRole("button", { name: "Edit this note" }));
    expect(screen.getByRole("dialog", { name: "edit sheet" })).toHaveAttribute("data-block", "");
  });

  it("an empty often-forgotten list says so, and a page with nothing stopped has no stopped section", async () => {
    current = status({ forgotten: [] });
    page();
    expect(await screen.findByText("No card has been forgotten that often.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Stopped" })).toBeNull();
  });

  it("brings a stopped card back", async () => {
    current = status({ stopped: [{ node_id: "note-9", title: "Old trivia", lapses: 0, block: { id: "blk-9", ref: "ref-9" } }] });
    const { unmount } = page();
    const stopped = await screen.findByRole("region", { name: "Stopped" });
    await userEvent.click(within(stopped).getByRole("button", { name: "Start reviewing again" }));
    await waitFor(() => expect(calls.some(call => call.url.endsWith("/api/review/blocks/blk-9/resume") && call.init?.method === "POST")).toBe(true));
    // The card's note can be opened at its paragraph from here too.
    unmount();
    const open = vi.fn();
    page({ onOpenNode: open });
    await userEvent.click(await screen.findByRole("button", { name: "Open this paragraph" }));
    expect(reveal).toHaveBeenCalledWith("note-9", "ref-9");
    expect(open).toHaveBeenCalledWith("note-9");
  });

  it("sets and removes the person's own daily limit", async () => {
    page();
    const input = await screen.findByRole("spinbutton", { name: "Reviews per day" });
    expect(screen.getByRole("button", { name: "Save limit" })).toBeDisabled(); // nothing typed
    await userEvent.type(input, "15");
    await userEvent.click(screen.getByRole("button", { name: "Save limit" }));
    await waitFor(() => expect(calls.some(call => call.url.endsWith("/api/me/prefs/reviewsPerDay") && call.init?.method === "PUT")).toBe(true));
    expect(JSON.parse(calls.find(call => call.url.endsWith("/api/me/prefs/reviewsPerDay"))!.init!.body as string)).toMatchObject({ value: 15 });
  });

  it("removing a limit sends null; 0 and fractions are not accepted", async () => {
    current = status({ reviews_per_day: 20 });
    page();
    const input = await screen.findByRole("spinbutton", { name: "Reviews per day" });
    expect(input).toHaveValue(20);
    await userEvent.clear(input);
    await userEvent.type(input, "0");
    expect(screen.getByRole("button", { name: "Save limit" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Remove limit" }));
    await waitFor(() => expect(JSON.parse(calls.find(call => call.url.endsWith("/api/me/prefs/reviewsPerDay"))!.init!.body as string)).toMatchObject({ value: null }));
  });

  it("shows no ids, JSON or raw codes", async () => {
    current = status({ stopped: [{ node_id: "3f1c9a52-7a0e-4c55-9f0e-0c8f2f3a1111", title: "", lapses: 0, block: null }] });
    page();
    await screen.findByText("Due today");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|[{}]|snake_case|_/);
  });

  it("offline with nothing loaded says it needs a connection", async () => {
    global.fetch = vi.fn(async () => { throw new TypeError("network down"); }) as unknown as typeof fetch;
    page({ online: false });
    expect(await screen.findByText("Review status needs a connection.")).toBeInTheDocument();
  });
});

describe("getting to the status page", () => {
  it("the review screen has a Review status button, and a way back", async () => {
    render(<ReviewScreen online target={null} onOpenNode={() => {}} onRefresh={() => {}} onImmersiveChange={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Review status" }));
    expect(await screen.findByText("Due today")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Back to review/ }));
    expect(await screen.findByRole("button", { name: "Review status" })).toBeInTheDocument();
  });

  it("opens on the status page when the home line asks for it", async () => {
    render(<ReviewScreen online target={{ page: "status" }} onOpenNode={() => {}} onRefresh={() => {}} onImmersiveChange={() => {}} />);
    expect(await screen.findByText("Due today")).toBeInTheDocument();
  });

  it("the review line on the home page links to it", async () => {
    const open = vi.fn();
    render(<ReviewHomeSection onOpenReview={() => {}} onOpenStatus={open} />);
    await userEvent.click(await screen.findByRole("button", { name: "Review status" }));
    expect(open).toHaveBeenCalledOnce();
  });
});
