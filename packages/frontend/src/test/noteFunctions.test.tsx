import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Presentation } from "lucide-react";
import InfoFunctions from "../components/InfoFunctions";
import { type ContentNode, type NodeEdge, type NodeTask } from "../lib/api";
import { setLocalePref } from "../lib/i18n";
import taskNoteFunctionRows from "../modules/tasks/noteFunctionRows";
import canvasNoteFunctionRows from "../modules/canvas/noteFunctionRows";
import dailyNoteFunctionRows from "../modules/daily/noteFunctionRows";
import aiNoteFunctionRows from "../modules/ai/noteFunctionRows";
import websiteNoteFunctionRows from "../modules/website/noteFunctionRows";
import slidesNoteFunctionRows from "../modules/slides/noteFunctionRows";
import { reviewModule } from "../modules/review";
import { websiteModule } from "../modules/website";
import type { NoteFunctionEnv, NoteFunctionRow } from "../modules";

vi.mock("../modules/tasks/openQuickAddTask", () => ({ openQuickAddTask: vi.fn() }));
import { openQuickAddTask } from "../modules/tasks/openQuickAddTask";
import type { SuggestionItem } from "@onden/contract";
import type { CanvasMembership } from "@onden/contract";

// The rows of the info panel's 「功能」 tab: each module's row with data and without, the card itself,
// and 「還能用在這則」. The panel knows no module; these are plain functions of NoteFunctionEnv.

const node = (id: string, extra: Partial<ContentNode> = {}): ContentNode => ({
  id, title: id, slug: id, markdown: "", node_type: "content", source_type: "manual", updated_at: "2026-10-01T00:00:00Z", ...extra,
});
const task = (id: string, extra: Partial<NodeTask> = {}): NodeTask => ({ id, node_id: "me", title: id, status: "todo", ...extra });
const nav = { openNote: vi.fn(), setMode: vi.fn(), openCanvas: vi.fn(), showContent: vi.fn() };
const env = (extra: Partial<NoteFunctionEnv> = {}): NoteFunctionEnv => ({
  node: node("me", { title: "Me" }), body: "", canEdit: true, online: true, nodes: [], edges: [], tasks: [], canvasMemberships: [], suggestions: null, nav, ...extra,
});
const link = (source: string, target: string): NodeEdge =>
  ({ id: `${source}-${target}`, source_node_id: source, target_node_id: target, edge_type: "knowledge_link", status: "active", origin: "manual" });

beforeEach(() => { act(() => setLocalePref("en")); vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

describe("任務", () => {
  it("with open tasks: how many, the nearest day, three titles, 「＋ 任務」 into this note, a jump to the Tasks page", () => {
    const [row] = taskNoteFunctionRows(env({ tasks: [
      task("write", { when_date: "2999-01-05" }), task("book", { deadline: "2999-01-03" }), task("x", { status: "done" }), task("other", { node_id: "elsewhere" }), task("a"),
    ] }));
    expect(row).toMatchObject({ id: "tasks", related: true, badge: { n: 3 }, details: ["write", "book", "a"] });
    expect(row!.status).toMatch(/^3 tasks, nearest Due /);
    void row!.action!.run();
    expect(openQuickAddTask).toHaveBeenCalledWith({ id: "me", title: "Me" });
    row!.jump!.run();
    expect(nav.setMode).toHaveBeenCalledWith("tasks");
  });
  it("without tasks it is offered under 「還能用在這則」; a viewer gets nothing", () => {
    const [row] = taskNoteFunctionRows(env());
    expect(row).toMatchObject({ related: false, status: "Add a task to this note" });
    expect(taskNoteFunctionRows(env({ canEdit: false }))).toEqual([]);
  });
});

describe("AI", () => {
  const item = (kind: SuggestionItem["kind"], base_text: string, new_text = "") => ({ kind, base_text, new_text }) as SuggestionItem;
  const items = [item("replace", "a"), item("title", "", ""), item("delete", "一段很長很長很長很長很長很長很長的文字"), item("comment", "d")];
  const suggestions = { pending: 2, items, acceptAll: vi.fn() };
  it("waiting places: the count as an alert badge, a line per place, accept all, a jump to the first", () => {
    const [row] = aiNoteFunctionRows(env({ suggestions }));
    expect(row).toMatchObject({ related: true, badge: { n: 2, alert: true }, status: "2 places wait for your decision" });
    expect(row!.details).toEqual(["Rewrite “a”", "A new title", "Remove “一段很長很長很長很長很長很長很…”", "A comment on “d”"]);
    void row!.action!.run();
    expect(suggestions.acceptAll).toHaveBeenCalled();
    row!.jump!.run();
    expect(nav.showContent).toHaveBeenCalled();
  });
  it("nothing waiting, no row; offline or read-only, no accept button", () => {
    expect(aiNoteFunctionRows(env())).toEqual([]);
    expect(aiNoteFunctionRows(env({ suggestions: { ...suggestions, pending: 0 } }))).toEqual([]);
    expect(aiNoteFunctionRows(env({ suggestions, online: false }))[0]!.action).toBeUndefined();
    expect(aiNoteFunctionRows(env({ suggestions, canEdit: false }))[0]!.action).toBeUndefined();
  });
});

describe("白板", () => {
  const memberships: CanvasMembership[] = [
    { canvas_id: "b1", canvas_title: "Plan", node_id: "me" }, { canvas_id: "b2", canvas_title: "", node_id: "me" }, { canvas_id: "b3", canvas_title: "Other", node_id: "x" },
  ];
  it("lists the boards the note is on (names in the details) and opens the first", () => {
    const [row] = canvasNoteFunctionRows(env({ canvasMemberships: memberships }));
    expect(row).toMatchObject({ related: true, status: "On 2 whiteboards", details: ["Plan", "Untitled"] });
    expect(row!.action).toBeUndefined();
    row!.jump!.run();
    expect(nav.openCanvas).toHaveBeenCalledWith("b1");
  });
  it("on no board, no row", () => {
    expect(canvasNoteFunctionRows(env({ canvasMemberships: [memberships[2]!] }))).toEqual([]);
  });
});

describe("日記", () => {
  const day = (date: string) => node(`d${date}`, { title: date, slug: date });
  it("the days whose diary links here, newest first; the jump opens the newest", () => {
    const nodes = [node("me"), day("2026-10-28"), day("2026-10-31"), node("plain")];
    const edges = [link("d2026-10-28", "me"), link("d2026-10-31", "me"), link("plain", "me")];
    const [row] = dailyNoteFunctionRows(env({ nodes, edges }));
    expect(row!.related).toBe(true);
    expect(row!.details).toHaveLength(2);
    expect(row!.status).toMatch(/^Mentioned in 2 days' diaries, latest Oct 31/);
    expect(row!.details![0]).toMatch(/Oct 31/);
    row!.jump!.run();
    expect(nav.openNote).toHaveBeenCalledWith("d2026-10-31");
  });
  it("no day links here (or this is a day itself), no row", () => {
    expect(dailyNoteFunctionRows(env({ nodes: [node("me"), node("plain")], edges: [link("plain", "me")] }))).toEqual([]);
    const self = day("2026-10-31");
    expect(dailyNoteFunctionRows(env({ node: self, nodes: [self, day("2026-10-30")], edges: [link("d2026-10-30", self.id)] }))).toEqual([]);
  });
});

describe("command rows (簡報, 引用, 複習, 網站): the same type, now with a tie or without", () => {
  it("簡報: a note that splits into slides has a deck (page count, play); a plain note is only offered; no text, no row", () => {
    const deck = "# A\n---\n# B\n---\n# C";
    const [has] = slidesNoteFunctionRows(env({ body: deck }));
    expect(has).toMatchObject({ related: true, status: "Plays as 3 slides", action: { label: "Play slides" } });
    expect(slidesNoteFunctionRows(env({ body: "just text" }))[0]).toMatchObject({ related: false, status: "Play this note as slides" });
    expect(slidesNoteFunctionRows(env({ body: "  " }))).toEqual([]);
  });
  it("複習 keeps its row (about the note, no extra fields needed)", () => {
    // The two card on/off commands are palette-only (no row), like 「新增技能」; every command that has a row is well-formed.
    expect(reviewModule.noteCommands!.filter((command) => command.row).length).toBeGreaterThanOrEqual(2);
    for (const command of reviewModule.noteCommands!.filter((c) => c.row)) {
      expect(command.row?.related).toBeUndefined();
      expect(command.row?.describe(node("me"), "Q: a\nA: b")).toEqual(expect.any(String));
    }
  });
  it("網站: a note the site may show gets the site's own row, on it or kept off; a hidden note or one the reader can't edit gets none", () => {
    const publish = websiteModule.noteCommands!.find((c) => c.id === "a-publish-note")!;
    expect(publish.row!.related!(node("me"), "")).toBe(false);
    const [row] = websiteNoteFunctionRows(env());
    expect(row).toMatchObject({ id: "website", related: true });
    expect(row!.Custom).toBeDefined();
    expect(websiteNoteFunctionRows(env({ canEdit: false }))).toEqual([]);
    expect(websiteNoteFunctionRows(env({ node: node("me", { hidden: true }) }))).toEqual([]);
  });
});

describe("InfoFunctions", () => {
  const row = (extra: Partial<NoteFunctionRow>): NoteFunctionRow => ({ id: "x", Icon: Presentation, name: "Name", related: true, status: "A sentence", ...extra });

  it("a card opens on a click: details (three at most), the button and the jump", () => {
    const action = vi.fn(); const jump = vi.fn();
    render(<InfoFunctions node={node("me")} rows={[row({ details: ["one", "two", "three", "four"], badge: { n: 2, alert: true }, action: { label: "Do it", run: action }, jump: { label: "Look", run: jump } })]} />);
    expect(screen.queryByText("one")).toBeNull();
    const head = screen.getByRole("button", { name: /A sentence/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("2 waiting")).toHaveClass("ui-chip--accent");
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(["one", "two", "three"].every((text) => screen.queryByText(text))).toBe(true);
    expect(screen.queryByText("four")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Do it" }));
    fireEvent.click(screen.getByRole("button", { name: "Look →" }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(jump).toHaveBeenCalledTimes(1);
  });

  it("only one card is open at a time; a row without a button or a jump shows neither", () => {
    render(<InfoFunctions node={node("me")} rows={[row({ id: "a", status: "First", details: ["d1"] }), row({ id: "b", status: "Second", details: ["d2"] })]} />);
    fireEvent.click(screen.getByRole("button", { name: /First/ }));
    fireEvent.click(screen.getByRole("button", { name: /Second/ }));
    expect(screen.queryByText("d1")).toBeNull();
    expect(screen.getByText("d2")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Functions" })).queryAllByRole("button").filter((b) => /Do|→/.test(b.textContent ?? ""))).toHaveLength(0);
  });

  it("rows with no tie are one line 「還能用在這則」, folded; opened, each has its sentence and a button", () => {
    const run = vi.fn();
    render(<InfoFunctions node={node("me")} rows={[
      row({ id: "t", name: "Tasks", status: "Add a task to this note", related: false, action: { label: "＋ Task", run } }),
      row({ id: "s", name: "Slides", status: "Play this note as slides", related: false, action: { label: "Play slides", run: vi.fn() } }),
    ]} />);
    const more = screen.getByRole("button", { name: /Also usable here: Tasks, Slides/ });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Add a task to this note")).toBeNull();
    fireEvent.click(more);
    expect(screen.getByText("Add a task to this note")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "＋ Task" }));
    expect(run).toHaveBeenCalled();
  });

  it("a row the module draws itself (the site's) is shown as is, and says nothing of ties when nothing is tied", () => {
    const Custom = () => <span>site status</span>;
    render(<InfoFunctions node={node("me")} rows={[row({ id: "w", Custom })]} />);
    expect(screen.getByText("site status")).toBeInTheDocument();
    cleanup();
    render(<InfoFunctions node={node("me")} rows={[]} />);
    expect(screen.getByText("Nothing here ties to this note yet.")).toBeInTheDocument();
  });
});
