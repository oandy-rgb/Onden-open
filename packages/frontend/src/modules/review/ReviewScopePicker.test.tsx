// 「範圍」 on the review page: the picker lists the same groups as the status page with their counts, a pick changes the
// queue in place (and the address), the choice is remembered for the account, and the status page follows it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReviewGroups, ReviewStatus } from "@onden/contract";
import ReviewScreen from "./ReviewScreen";
import ReviewPanel from "./ReviewPanel";
import { formatPlace, parsePlace, scopeQuery } from "./reviewPlace";
import { reviewScopePref } from "./reviewScopePref";
import { resetAppState } from "../../lib/appStore";
import { getModuleAddress, setModuleAddress } from "../../lib/moduleAddress";
import { takeHistoryIntent } from "../../lib/historyIntent";

vi.mock("../../lib/liveEvents", () => ({
  isLiveConnected: () => false,
  subscribeLiveTicks: (_listener: unknown, connection?: (connected: boolean) => void) => { connection?.(false); return () => {}; },
}));
vi.mock("../../components/MarkdownRenderer", () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));

const TAG_A = "11111111-1111-4111-8111-111111111111";
const NOTE_A = "22222222-2222-4222-8222-222222222222";
const status: ReviewStatus = {
  today_date: "2026-11-15", overdue: 0, today: 0, new_available: 0, rolled_over: 0, reviews_per_day: null, reviewed_today: 0,
  forecast: [], forgotten_min: 4, forgotten: [], stopped: [],
};
const answers: Record<"tag" | "note", ReviewGroups> = {
  tag: { by: "tag", groups: [{ id: TAG_A, title: "試用課程", due: 3, new: 1 }, { id: null, title: "", due: 1, new: 0 }] },
  note: { by: "note", groups: [{ id: NOTE_A, title: "作業系統", due: 2, new: 2 }] },
};
let calls: Array<{ url: string; method: string }> = [];
let savedScope: string | null = null;

beforeEach(() => {
  calls = []; savedScope = null; resetAppState(); setModuleAddress(null); takeHistoryIntent();
  localStorage.clear(); reviewScopePref.store.forget();
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/api/review/groups")) return new Response(JSON.stringify(answers[url.includes("by=note") ? "note" : "tag"]));
    if (url.includes("/api/review/status")) return new Response(JSON.stringify(status));
    if (url.includes("/queue")) return new Response(JSON.stringify({ cards: [], total: 0 }));
    if (url.includes("/stats")) return new Response(JSON.stringify({ due: 4, new: 1, learned: 0, new_available: 1 }));
    if (url.includes("/stopped")) return new Response(JSON.stringify({ stopped: [] }));
    if (url.includes("/api/me/prefs/reviewScope")) return new Response(JSON.stringify({ value: savedScope }));
    if (url.includes("/api/me/prefs")) return new Response(JSON.stringify({ value: null }));
    return new Response(JSON.stringify({ ok: true }));
  }) as unknown as typeof fetch;
});
afterEach(() => { vi.restoreAllMocks(); setModuleAddress(null); });

const screenOpen = () => render(<ReviewScreen online target={null} onOpenNode={() => {}} onRefresh={() => {}} onImmersiveChange={() => {}} />);
const queueUrls = () => calls.filter((call) => call.url.includes("/queue")).map((call) => call.url);

describe("the review 範圍 picker", () => {
  it("starts on all cards, lists notes and tags with their counts, and a pick changes the queue in place", async () => {
    screenOpen();
    await waitFor(() => expect(getModuleAddress()).toBe("all"));
    expect(queueUrls().at(-1)).toBe("/api/review/queue");
    await userEvent.click(await screen.findByRole("button", { name: /Review scope/ }));
    const sheet = await screen.findByRole("dialog", { name: "Review scope" });
    expect(await within(sheet).findByText("作業系統")).toBeInTheDocument();
    expect(within(sheet).getByText("2 due · 2 new")).toBeInTheDocument();
    expect(within(sheet).getByText("#試用課程")).toBeInTheDocument();
    expect(within(sheet).getByText("4 to review")).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: /試用課程/ }));
    expect(getModuleAddress()).toBe(`tag.${TAG_A}`);
    expect(takeHistoryIntent()).toBe("push");
    await waitFor(() => expect(queueUrls().at(-1)).toBe(`/api/review/queue?tag_id=${TAG_A}`));
    // The empty scope says so and leads back to all.
    await userEvent.click(await screen.findByRole("button", { name: "Review all cards" }));
    expect(getModuleAddress()).toBe("all");
  });

  it("remembers the last choice for the account and opens on it next time", async () => {
    screenOpen();
    await userEvent.click(await screen.findByRole("button", { name: /Review scope/ }));
    await userEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: /作業系統/ }));
    expect(getModuleAddress()).toBe(`root.${NOTE_A}`);
    await waitFor(() => expect(calls.some((call) => call.method === "PUT" && call.url.includes("/api/me/prefs/reviewScope"))).toBe(true));
    // A new visit with no address: the remembered scope fills it in, and the queue is that scope's.
    setModuleAddress(null);
    await waitFor(() => expect(getModuleAddress()).toBe(`root.${NOTE_A}`));
    await waitFor(() => expect(queueUrls().at(-1)).toBe(`/api/review/queue?root=${NOTE_A}`));
  });

  it("the status page counts the chosen scope", async () => {
    setModuleAddress(`tag.${TAG_A}`);
    screenOpen();
    await waitFor(() => expect(queueUrls().at(-1)).toBe(`/api/review/queue?tag_id=${TAG_A}`));
    await userEvent.click(await screen.findByRole("button", { name: "Review status" }));
    await waitFor(() => expect(calls.some((call) => call.url === `/api/review/status?tag_id=${TAG_A}`)).toBe(true));
  });
});

describe("the session across re-renders and missing scopes", () => {
  it("a host re-render with an equal scope does not read the queue again", async () => {
    setModuleAddress(`tag.${TAG_A}`);
    const element = <ReviewScreen online target={null} onOpenNode={() => {}} onRefresh={() => {}} onImmersiveChange={() => {}} />;
    const { rerender } = render(element);
    await waitFor(() => expect(queueUrls()).toHaveLength(1));
    rerender(<ReviewScreen online target={null} onOpenNode={() => {}} onRefresh={() => {}} onImmersiveChange={() => {}} />);
    rerender(<ReviewScreen online target={null} onOpenNode={() => {}} onRefresh={() => {}} onImmersiveChange={() => {}} />);
    await new Promise((done) => setTimeout(done, 200));
    expect(queueUrls()).toHaveLength(1);
  });

  it("the session itself keeps its place when the scope arrives as a new, equal object", async () => {
    const { rerender } = render(<ReviewPanel online onOpenNode={() => {}} scope={{ kind: "tag", id: TAG_A }} />);
    await waitFor(() => expect(queueUrls()).toHaveLength(1));
    rerender(<ReviewPanel online onOpenNode={() => {}} scope={{ kind: "tag", id: TAG_A }} />);
    await new Promise((done) => setTimeout(done, 200));
    expect(queueUrls()).toHaveLength(1);
  });

  it("opened from the home line it shows all cards, not the remembered scope", async () => {
    savedScope = `tag.${TAG_A}`;
    reviewScopePref.store.stage(`tag.${TAG_A}`);
    render(<ReviewScreen online target={{ page: "all" }} onOpenNode={() => {}} onRefresh={() => {}} onImmersiveChange={() => {}} />);
    await waitFor(() => expect(getModuleAddress()).toBe("all"));
    await waitFor(() => expect(queueUrls().at(-1)).toBe("/api/review/queue"));
  });

  it("a remembered tag that is gone returns to all cards instead of an error", async () => {
    setModuleAddress(`tag.${TAG_A}`);
    const fetchMock = global.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) =>
      url.includes(`/queue?tag_id=${TAG_A}`) ? new Response(JSON.stringify({ error: "tag not found" }), { status: 404 }) : fetchMock(url, init)) as unknown as typeof fetch;
    screenOpen();
    await waitFor(() => expect(getModuleAddress()).toBe("all"));
    await waitFor(() => expect(queueUrls().at(-1)).toBe("/api/review/queue"));
    expect(screen.queryByText(/Could not load the review queue/)).toBeNull();
  });

  it("with no address it waits for the account's remembered scope, then opens on it", async () => {
    savedScope = `tag.${TAG_A}`;
    screenOpen();
    await waitFor(() => expect(getModuleAddress()).toBe(`tag.${TAG_A}`));
    expect(queueUrls().every((url) => url.includes(TAG_A))).toBe(true);
  });
});

describe("a scope as an address and as a request", () => {
  it("round-trips all, and gives each scope its one query string", () => {
    expect(parsePlace(formatPlace({ kind: "all" }))).toEqual({ kind: "all" });
    expect(scopeQuery({ kind: "all" })).toBe("");
    expect(scopeQuery({ kind: "untagged" })).toBe("?untagged=true");
    expect(scopeQuery({ kind: "tag", id: TAG_A })).toBe(`?tag_id=${TAG_A}`);
    expect(scopeQuery({ kind: "root", id: NOTE_A })).toBe(`?root=${NOTE_A}`);
  });
});
