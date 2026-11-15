// 「分組」 on the review status page: the rows the server's one groups read gives, the switch between tags
// and notes (remembered), 「練這組」 opening the review session limited to that group, and the way back.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReviewGroups, ReviewStatus } from "@onden/contract";
import ReviewScreen from "./ReviewScreen";
import { formatPlace, parsePlace, placeOfGroup } from "./reviewPlace";
import { resetAppState } from "../../lib/appStore";
import { getModuleAddress, setModuleAddress } from "../../lib/moduleAddress";
import { takeHistoryIntent } from "../../lib/historyIntent";
import { reviewGroupByPref } from "./reviewGroupPref";

vi.mock("../../lib/liveEvents", () => ({
  isLiveConnected: () => false,
  subscribeLiveTicks: (_listener: unknown, connection?: (connected: boolean) => void) => { connection?.(false); return () => {}; },
}));
vi.mock("../../components/MarkdownRenderer", () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));

const TAG_A = "11111111-1111-4111-8111-111111111111";
const NOTE_A = "22222222-2222-4222-8222-222222222222";
const status: ReviewStatus = {
  today_date: "2026-11-15", overdue: 1, today: 2, new_available: 3, rolled_over: 0, reviews_per_day: null, reviewed_today: 0,
  forecast: [], forgotten_min: 4, forgotten: [], stopped: [],
};
const answers: Record<"tag" | "note", ReviewGroups> = {
  tag: { by: "tag", groups: [
    { id: TAG_A, title: "Algorithms", due: 3, new: 1 },
    { id: null, title: "", due: 1, new: 0 },
    { id: "33333333-3333-4333-8333-333333333333", title: "Done tag", due: 0, new: 0 },
  ] },
  note: { by: "note", groups: [{ id: NOTE_A, title: "Lecture 1", due: 2, new: 2 }] },
};
let calls: Array<{ url: string; method: string }> = [];
let groupsAnswer: (by: "tag" | "note") => ReviewGroups = (by) => answers[by];

beforeEach(() => {
  calls = []; resetAppState(); setModuleAddress(null); takeHistoryIntent();
  // The remembered choice of an earlier test must not carry over.
  localStorage.clear(); reviewGroupByPref.store.forget();
  groupsAnswer = (by) => answers[by];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/api/review/groups")) return new Response(JSON.stringify(groupsAnswer(url.includes("by=note") ? "note" : "tag")));
    if (url.includes("/api/review/status")) return new Response(JSON.stringify(status));
    if (url.includes("/queue")) return new Response(JSON.stringify({ cards: [], total: 0 }));
    if (url.includes("/stats")) return new Response(JSON.stringify({ due: 0, new: 0, learned: 0 }));
    if (url.includes("/stopped")) return new Response(JSON.stringify({ stopped: [] }));
    if (url.includes("/api/me/prefs")) return new Response(JSON.stringify({ value: null }));
    return new Response(JSON.stringify({ ok: true }));
  }) as unknown as typeof fetch;
});
afterEach(() => { vi.restoreAllMocks(); setModuleAddress(null); });

const screenOpen = () => render(<ReviewScreen online target={null} onOpenNode={() => {}} onRefresh={() => {}} onImmersiveChange={() => {}} />);
const section = async () => screen.findByRole("region", { name: "Groups" });

describe("the 「分組」 section", () => {
  it("lists a row per group with its numbers and a button; a row with nothing to do comes after, quieter", async () => {
    setModuleAddress("status");
    screenOpen();
    const groups = await section();
    const rows = await within(groups).findAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".review-group-name")!.textContent)).toEqual(["Algorithms", "No tag", "Done tag"]);
    expect(within(rows[0]!).getByText("3 due · 1 new")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("1 due · 0 new")).toBeInTheDocument();
    expect(rows.map((row) => row.getAttribute("data-quiet"))).toEqual(["false", "false", "true"]);
    expect(within(rows[2]!).getByRole("button", { name: "Practise this group" })).toBeDisabled();
    // One read for all the rows, not one per tag.
    expect(calls.filter((call) => call.url.includes("/api/review/groups"))).toHaveLength(1);
  });

  it("the switch asks for the notes and remembers the choice for the account", async () => {
    setModuleAddress("status");
    screenOpen();
    const groups = await section();
    await within(groups).findByText("Algorithms");
    await userEvent.click(within(groups).getByRole("radio", { name: "By note" }));
    expect(await within(groups).findByText("Lecture 1")).toBeInTheDocument();
    expect(within(groups).queryByText("Algorithms")).toBeNull();
    expect(calls.some((call) => call.url.includes("/api/review/groups?by=note"))).toBe(true);
    await waitFor(() => expect(calls.some((call) => call.method === "PUT" && call.url.includes("/api/me/prefs/reviewGroupBy"))).toBe(true));
  });

  it("with no card at all it says so instead of an empty list", async () => {
    groupsAnswer = (by) => ({ by, groups: [] });
    setModuleAddress("status");
    screenOpen();
    const groups = await section();
    expect(await within(groups).findByText(/No review cards yet/)).toBeInTheDocument();
    expect(within(groups).queryByRole("list")).toBeNull();
  });

  it("「練這組」 opens the session limited to the group as a new page, names the group, and All cards leads back", async () => {
    setModuleAddress("status");
    screenOpen();
    const groups = await section();
    await within(groups).findByText("Algorithms");
    await userEvent.click(within(groups).getAllByRole("button", { name: "Practise this group" })[0]!);
    // A new history entry (Back returns to the status page) and the group is in the address.
    expect(getModuleAddress()).toBe(`tag.${TAG_A}`);
    await waitFor(() => expect(calls.some((call) => call.url.includes(`/api/review/queue?tag_id=${TAG_A}`))).toBe(true));
    expect(takeHistoryIntent()).toBe("push");
    // The title is not known to this test's store, so the line shows the placeholder name, never an id.
    const line = await screen.findByText(/Reviewing notes tagged #/);
    expect(line.textContent).not.toContain(TAG_A);
    // Back (the address returns to the previous entry, as useUrlSync does on popstate): the status page again.
    setModuleAddress("status");
    expect(await screen.findByRole("region", { name: "Groups" })).toBeInTheDocument();
    // Forward again, then All cards.
    setModuleAddress(`tag.${TAG_A}`);
    await userEvent.click(await screen.findByRole("button", { name: "All cards" }));
    expect(getModuleAddress()).toBeNull();
    await waitFor(() => expect(calls.at(-1)!.url).not.toContain("tag_id") );
  });

  it("the 「沒有標籤」 and note rows open their own scopes", async () => {
    setModuleAddress("status");
    screenOpen();
    const groups = await section();
    const rows = await within(groups).findAllByRole("listitem");
    await userEvent.click(within(rows[1]!).getByRole("button", { name: "Practise this group" }));
    expect(getModuleAddress()).toBe("untagged");
    await waitFor(() => expect(calls.some((call) => call.url.includes("/api/review/queue?untagged=true"))).toBe(true));
    expect(await screen.findByText("Practising cards with no tag")).toBeInTheDocument();
  });

  it("a reload keeps the group: the address alone opens the scoped session", async () => {
    setModuleAddress(`root.${NOTE_A}`);
    screenOpen();
    await waitFor(() => expect(calls.some((call) => call.url.includes(`/api/review/queue?root=${NOTE_A}`))).toBe(true));
  });
});

describe("the review place in the address", () => {
  it("round-trips every place and ignores anything else", () => {
    for (const place of [{ kind: "status" }, { kind: "untagged" }, { kind: "tag", id: TAG_A }, { kind: "root", id: NOTE_A }] as const) {
      expect(parsePlace(formatPlace(place))).toEqual(place);
    }
    expect(formatPlace(null)).toBeNull();
    for (const bad of [null, "", "tag.", "tag.not-an-id", "root.<script>", "deck.1"]) expect(parsePlace(bad), String(bad)).toBeNull();
  });
  it("a group row maps to the place that practises it", () => {
    expect(placeOfGroup("tag", TAG_A)).toEqual({ kind: "tag", id: TAG_A });
    expect(placeOfGroup("tag", null)).toEqual({ kind: "untagged" });
    expect(placeOfGroup("note", NOTE_A)).toEqual({ kind: "root", id: NOTE_A });
  });
});
