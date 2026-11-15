vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  getPendingWrites: vi.fn(async () => []), getNodeAttributeRecord: vi.fn(async () => null),
  upsertAttribute: vi.fn(async () => {}), removeAttribute: vi.fn(async () => {}),
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import NodeAttributesPanel from "../components/NodeAttributesPanel";
import TagCardTop from "../components/TagCardTop";
import { noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import { setWorkspaceTimeZoneSource } from "../lib/localDate";
import { setLocalePref } from "../lib/i18n";

// The tag card's fields are controls you use directly (no press-to-edit step):
// chips for options, a switch, a day with quick picks, boxes you type in, a
// linked note as a pill with 「換一則」. The card's top says what the tag brings.

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let attributes: Array<Record<string, unknown>> = [];

const club: Tag = {
  id: "t-club", name: "讀書會", color: "#a55", schema_id: "s-club",
  schema_fields: [
    { name: "when", label: "日期", type: "date" },
    { name: "status", label: "狀態", type: "select", options: ["準備中", "已辦完", "取消"] },
    { name: "place", label: "地點", type: "relation" },
    { name: "host", label: "主講", type: "text" },
    { name: "seats", label: "人數", type: "number" },
    { name: "open", label: "開放報名", type: "boolean" },
  ],
};
const manyOptions: Tag = {
  id: "t-many", name: "多選項", color: "", schema_id: "s-many",
  schema_fields: [{ name: "kind", label: "種類", type: "select", options: ["一", "二", "三", "四", "五", "六", "七"] }],
};
const venue: ContentNode = { id: "n-venue", title: "讀書會場地", slug: "v", markdown: "", node_type: "content", source_type: "manual" };
const hall: ContentNode = { id: "n-hall", title: "大講堂", slug: "h", markdown: "", node_type: "content", source_type: "manual" };

function puts(key: string) {
  return calls.filter((c) => c.init?.method === "PUT" && c.url.includes(`/attributes/${key}`))
    .map((c) => (JSON.parse(String(c.init?.body)) as { value: string }).value);
}

function panel(props: Partial<React.ComponentProps<typeof NodeAttributesPanel>> = {}, tags: Tag[] = [club]) {
  return render(<NodeAttributesPanel nodeId="n1" classTags={tags} allNodes={[venue, hall]} {...props} />);
}

beforeEach(() => {
  calls = []; attributes = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const own = url.includes("/attributes") && !url.includes("inherited") && !url.includes("rollup") && !init?.method;
    return new Response(JSON.stringify(own ? attributes : []), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  setAppState({ online: true });
});
afterEach(() => {
  vi.useRealTimers();
  setWorkspaceTimeZoneSource(() => undefined);
  resetAppState();
  act(() => setLocalePref("system"));
  vi.restoreAllMocks();
});

describe("fields are controls, name above value", () => {
  it("text and number are boxes from the start; they write on blur or Enter, not on every key", async () => {
    attributes = [{ key: "host", value: "小明", value_type: "text", is_inheritable: false, source: "explicit" }];
    panel();
    const host = await screen.findByDisplayValue("小明");
    fireEvent.change(host, { target: { value: "小華" } });
    expect(puts("host")).toEqual([]);
    fireEvent.blur(host);
    await waitFor(() => expect(puts("host")).toEqual(["小華"]));
    // Unchanged on blur: no write.
    fireEvent.blur(screen.getByLabelText("人數"));
    const seats = screen.getByLabelText("人數");
    expect(seats).toHaveAttribute("type", "number");
    fireEvent.change(seats, { target: { value: "12" } });
    fireEvent.keyDown(seats, { key: "Enter" });
    await waitFor(() => expect(puts("seats")).toEqual(["12"]));
    expect(puts("host")).toHaveLength(1);
    // The empty box says what to add.
    expect(screen.getByLabelText("主講")).toBeInTheDocument();
  });

  it("an empty text box shows a grey hint naming the field", async () => {
    act(() => setLocalePref("zh-TW"));
    panel();
    expect(await screen.findByPlaceholderText("加主講…")).toBeInTheDocument();
  });

  it("nothing is written while an input method is composing", async () => {
    panel();
    const host = await screen.findByLabelText("主講");
    act(() => host.focus());
    fireEvent.compositionStart(host);
    fireEvent.change(host, { target: { value: "ㄒ" } });
    fireEvent.keyDown(host, { key: "Enter", isComposing: true });
    fireEvent.blur(host);
    await new Promise((r) => setTimeout(r, 20));
    expect(puts("host")).toEqual([]);
    fireEvent.change(host, { target: { value: "小" } });
    fireEvent.compositionEnd(host);
    act(() => host.blur());
    await waitFor(() => expect(puts("host")).toEqual(["小"]));
  });

  it("a composition that ends after the box lost focus writes the box's final text", async () => {
    panel();
    const host = await screen.findByLabelText("主講");
    act(() => host.focus());
    fireEvent.compositionStart(host);
    fireEvent.change(host, { target: { value: "ㄒ" } });
    act(() => host.blur());
    // Some keyboards end the composition with the final text and no input event before it.
    fireEvent.compositionEnd(host, { target: { value: "小" } });
    await waitFor(() => expect(puts("host")).toEqual(["小"]));
  });

  it("a boolean is a switch", async () => {
    panel();
    const sw = await screen.findByRole("switch", { name: "開放報名" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    await waitFor(() => expect(puts("open")).toEqual(["true"]));
  });
});

describe("options as chips", () => {
  it("lists every option; the current one is pressed; one tap switches, the same again clears", async () => {
    attributes = [{ key: "status", value: "準備中", value_type: "text", is_inheritable: false, source: "explicit" }];
    panel();
    const group = await screen.findByRole("group", { name: "狀態" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["準備中", "已辦完", "取消"]);
    await waitFor(() => expect(within(group).getByRole("button", { name: "準備中" })).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(within(group).getByRole("button", { name: "已辦完" }));
    await waitFor(() => expect(puts("status")).toEqual(["已辦完"]));
    fireEvent.click(within(group).getByRole("button", { name: "準備中" }));
    await waitFor(() => expect(puts("status")).toEqual(["已辦完", ""]));
  });

  it("too many options for a row fall back to a dropdown", async () => {
    panel({}, [manyOptions]);
    const select = await screen.findByRole("combobox", { name: "種類" });
    fireEvent.change(select, { target: { value: "三" } });
    await waitFor(() => expect(puts("kind")).toEqual(["三"]));
  });

  it("the owner keeps 「+ New option…」 as a chip", async () => {
    panel({ canEditTags: true });
    expect(await screen.findByRole("button", { name: "+ New option…" })).toBeInTheDocument();
  });
});

describe("a date shows its value; quick picks open on press, by the workspace's day", () => {
  const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });

  it("picks today / tomorrow / next week on the workspace's calendar, then closes", async () => {
    at("2026-11-01T20:00:00Z"); // 11/2 in Taipei, still 11/1 in Los Angeles
    setWorkspaceTimeZoneSource(() => "Asia/Taipei");
    panel();
    const day = await screen.findByRole("button", { name: "日期" });
    expect(screen.queryByRole("button", { name: "Today" })).toBeNull();
    fireEvent.click(day);
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(puts("when")).toEqual(["2026-11-02"]));
    expect(screen.queryByRole("button", { name: "Today" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "日期" }));
    fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    await waitFor(() => expect(puts("when")).toEqual(["2026-11-02", "2026-11-03"]));
    fireEvent.click(screen.getByRole("button", { name: "日期" }));
    fireEvent.click(screen.getByRole("button", { name: /^Next / }));
    await waitFor(() => expect(puts("when")).toEqual(["2026-11-02", "2026-11-03", "2026-11-09"]));
  });

  it("the same instant is the day before in another time zone", async () => {
    at("2026-11-01T20:00:00Z");
    setWorkspaceTimeZoneSource(() => "America/Los_Angeles");
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "日期" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(puts("when")).toEqual(["2026-11-01"]));
  });
});

describe("a linked note", () => {
  it("is a pill that opens the note; 換一則 opens the picker and writes the new one", async () => {
    attributes = [{ key: "place", value: "n-venue", value_type: "node_ref", is_inheritable: false, source: "explicit" }];
    const onOpenNote = vi.fn();
    panel({ onOpenNote });
    const pill = await screen.findByRole("button", { name: "讀書會場地" });
    fireEvent.click(pill);
    expect(onOpenNote).toHaveBeenCalledWith("n-venue");
    fireEvent.click(screen.getByRole("button", { name: "Change note" }));
    fireEvent.click(await screen.findByRole("button", { name: "大講堂" }));
    await waitFor(() => expect(puts("place")).toEqual(["n-hall"]));
  });
});

describe("what the tag brings (the top of a card)", () => {
  const review: Tag = { id: "t-review", name: "技能", color: "", schema_id: "s-review", schema_module: "skills", effective_modules: ["skills"] };
  const course: Tag = { id: "t-course", name: "課程", color: "", schema_id: "s-course", schema_extends: ["t-review"], effective_modules: ["skills"],
    schema_fields: [{ name: "teacher", type: "text" }] };
  const plain: Tag = { id: "t-plain", name: "分享", color: "", schema_id: "s-plain" };
  const seed = (tags: Tag[]) => resetAppState({ data: { ...noWorkspaceData, nodes: [{ ...venue, class_tag_ids: ["t-course"] }], tags }, online: true });

  it("names the name, the count, the page link and the functions it gets by extending another tag", () => {
    seed([review, course, plain]);
    act(() => setLocalePref("zh-TW"));
    const onOpenTag = vi.fn();
    render(<TagCardTop tag={course} onOpenTag={onOpenTag} />);
    expect(screen.getByText("#課程")).toBeInTheDocument();
    expect(screen.getByText("1 篇筆記")).toBeInTheDocument();
    expect(screen.getByText("帶來：技能")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "標籤頁 →" }));
    expect(onOpenTag).toHaveBeenCalledWith("t-course");
  });

  it("says 沒有欄位 for a tag without fields", () => {
    seed([review, course, plain]);
    act(() => setLocalePref("zh-TW"));
    render(<TagCardTop tag={plain} onOpenTag={() => {}} />);
    expect(screen.getByText("帶來：沒有功能 · 沒有欄位")).toBeInTheDocument();
  });
});
