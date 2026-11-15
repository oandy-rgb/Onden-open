// Tasks as link and embed targets (T6): the `[[` menu offers them with enough
// small print to tell same-named ones apart and writes a link by id; `![[task]]`
// is a live checkbox row that completes the task; a task the reader cannot
// read shows no title; one they can only read cannot be ticked.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { nodeRefTarget } from "@onden/markdown";
import type { ContentNode } from "../lib/api";

const { taskWriter } = await import("../lib/data");
const { registerTaskRefs, resolveTaskRef, taskLineRange, taskRefsFrom } = await import("../lib/taskRefs");
const { resolveEmbed } = await import("../lib/embeds");
const { taskChips, taskHint } = await import("../lib/taskChips");
const { applyCompletion, getCompletions } = await import("../lib/editorCompletion");
const { embedLineRanges } = await import("../lib/editorEmbeds");
const { default: MarkdownRenderer } = await import("../components/MarkdownRenderer");
const { loadPartLinks } = await import("../lib/partLinkModule");

const note = (over: Partial<ContentNode> & { id: string; title: string }) =>
  ({ slug: over.title.toLowerCase(), markdown: "", node_type: "content", ...over }) as unknown as ContentNode;

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const hostNote = note({ id: "h1", title: "Weekly plan", space_id: "s1" });
const row = (over: Record<string, unknown>) => ({ id: ID_A, title: "Pay rent", status: "todo", ...over }) as never;

/** The rows of `tasks`, held by the app and registered as link targets. */
function hold(tasks: unknown[], canEdit = (_space: string | null) => true) {
  const refs = taskRefsFrom(tasks as never, [hostNote], canEdit);
  const listeners = new Set<() => void>();
  registerTaskRefs({ tasks: () => refs, subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; } });
  return refs;
}

// A link by id (`onden://node/<id>`) holds a `/`, so the renderer fetches the part-link module (lib/partLinkModule.ts)
// and draws again once it is here, with new link components: an element found before that is replaced, and a click
// on it reaches nothing. Load it first, so what the tests click is what stays on screen.
beforeAll(() => loadPartLinks());

let patch: ReturnType<typeof vi.spyOn>;
beforeEach(() => { patch = vi.spyOn(taskWriter, "patch").mockResolvedValue({} as never); });
afterEach(() => { registerTaskRefs(null); vi.restoreAllMocks(); });

describe("resolving a task", () => {
  it("by id, so two tasks with one title are never mixed up", () => {
    const refs = hold([row({ id: ID_A, when_date: "2026-10-30" }), row({ id: ID_B, node_id: "h1" })]);
    expect(resolveTaskRef(nodeRefTarget(ID_B))?.id).toBe(ID_B);
    expect(resolveTaskRef(nodeRefTarget(ID_A))?.id).toBe(ID_A);
    expect(refs).toHaveLength(2);
  });

  it("by title only when no note has it", () => {
    hold([row({ id: ID_A, title: "Pay rent" })]);
    const embedded = resolveEmbed("Pay rent", null, [note({ id: "n1", title: "Other" })]);
    expect(embedded.kind).toBe("task");
    const note2 = note({ id: "n2", title: "Pay rent" });
    expect(resolveEmbed("Pay rent", null, [note2]).kind).toBe("note");
  });

  it("an id the reader holds no task for is a task embed with no task (never `missing`, never a title)", () => {
    hold([]);
    const embed = resolveEmbed(nodeRefTarget(ID_C), null, []);
    expect(embed).toMatchObject({ kind: "task", task: null });
  });

  it("a heading or block of a task is no embed of it", () => {
    hold([row({})]);
    expect(resolveEmbed(`${nodeRefTarget(ID_A)}#^abc`, null, []).kind).toBe("task"); // an unknown note by id: unreadable, no title
    expect((resolveEmbed("Pay rent#Heading", null, []) as { kind: string }).kind).toBe("missing");
  });
});

describe("the `[[` menu", () => {
  const ctx = (tasks: ReturnType<typeof taskRefsFrom>) => ({
    nodes: [{ id: "n1", title: "Rent notes" }], tasks, tags: [], attrClassTags: [],
    canSetAttr: false, canInsertPage: false, canCreateNote: false,
  });

  it("offers tasks only once something is typed, and tells same-named ones apart", () => {
    const refs = hold([
      row({ id: ID_A, title: "Pay rent", when_date: "2026-10-30" }),
      row({ id: ID_B, title: "Pay rent", node_id: "h1", status: "done" }),
      row({ id: ID_C, title: "Pay rent" }),
    ]);
    expect(getCompletions({ type: "wikilink", query: "" }, ctx(refs)).some((i) => "__task" in i)).toBe(false);
    const items = getCompletions({ type: "wikilink", query: "pay rent" }, ctx(refs)).filter((i) => "__task" in i) as Array<{ id: string; hint: string; done: boolean }>;
    expect(items.map((i) => i.id).sort()).toEqual([ID_A, ID_B, ID_C].sort());
    const hints = items.map((i) => i.hint);
    expect(new Set(hints).size).toBe(3);
    expect(items.find((i) => i.id === ID_B)).toMatchObject({ done: true, hint: "Done · In “Weekly plan”" });
    expect(items.find((i) => i.id === ID_C)?.hint).toBe("Anytime");
    expect(hints.join("|")).not.toContain(ID_A);
  });

  it("writes a link that names the task by id", () => {
    const refs = hold([row({ id: ID_A, title: "Pay [rent] | now" })]);
    const [item] = getCompletions({ type: "wikilink", query: "pay" }, ctx(refs)).filter((i) => "__task" in i);
    const view = new EditorView({ state: EditorState.create({ doc: "See [[pay", selection: { anchor: 9 } }) });
    applyCompletion(view, { type: "wikilink", triggerStart: 4 }, item!);
    expect(view.state.doc.toString()).toBe(`See [[${nodeRefTarget(ID_A)}|Pay rent now]]`);
    view.destroy();
  });
});

describe("the embedded row", () => {
  const renderEmbed = (md: string, props: Record<string, unknown> = {}) =>
    render(<MarkdownRenderer nodes={[hostNote]} onNavigate={() => {}} {...props}>{md}</MarkdownRenderer>);

  it("is a checkbox, the title and chips, and ticking it completes the task", async () => {
    hold([row({ id: ID_A, title: "Pay rent", when_date: "2026-10-30", deadline: "2026-11-01", recur: "1w" })]);
    const { container } = renderEmbed(`![[${nodeRefTarget(ID_A)}]]`);
    await waitFor(() => expect(container.querySelector(".md-task-embed")).not.toBeNull());
    expect(container.textContent).toContain("Pay rent");
    expect(container.querySelectorAll(".md-task-chip").length).toBe(3);
    const box = container.querySelector<HTMLElement>(".md-task-box")!;
    expect(box.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(box);
    expect(patch).toHaveBeenCalledWith(ID_A, { status: "done" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(box);
    expect(patch).toHaveBeenLastCalledWith(ID_A, { status: "todo" });
  });

  it("shows a done task checked and struck through", async () => {
    hold([row({ status: "done" })]);
    const { container } = renderEmbed(`![[${nodeRefTarget(ID_A)}]]`);
    await waitFor(() => expect(container.querySelector(".md-task-embed.is-done")).not.toBeNull());
    expect(container.querySelector(".md-task-box")!.getAttribute("aria-checked")).toBe("true");
  });

  it("with only read permission shows the state and cannot be ticked", async () => {
    hold([row({})], () => false);
    const { container } = renderEmbed(`![[${nodeRefTarget(ID_A)}]]`);
    await waitFor(() => expect(container.querySelector(".md-task-box")).not.toBeNull());
    const box = container.querySelector<HTMLElement>(".md-task-box")!;
    expect(box.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(box);
    expect(patch).not.toHaveBeenCalled();
    expect(box.getAttribute("aria-checked")).toBe("false");
  });

  it("a task the reader cannot read shows no title and no id", async () => {
    hold([]);
    const { container } = renderEmbed(`Before\n\n![[${nodeRefTarget(ID_C)}]]\n\nSee [[${nodeRefTarget(ID_C)}|Secret errand]]`);
    await waitFor(() => expect(container.querySelector(".md-embed-notice")?.textContent).toBe("Content you cannot access"));
    expect(container.textContent).not.toContain("Secret errand");
    expect(container.textContent).not.toContain(ID_C);
    expect(container.textContent).not.toContain("onden://");
    expect(container.querySelector(".wikilink-token--unavailable")?.textContent).toBe("Content you cannot access");
  });

  it("opens the task from its title", async () => {
    hold([row({})]);
    const onNavigate = vi.fn();
    const { container } = renderEmbed(`![[${nodeRefTarget(ID_A)}]]`, { onNavigate });
    await waitFor(() => expect(container.querySelector(".md-task-title")).not.toBeNull());
    fireEvent.click(container.querySelector(".md-task-title")!);
    expect(onNavigate).toHaveBeenCalledWith("", ID_A, undefined);
  });

  it("a link by id is a link to the task and opens it", async () => {
    hold([row({})]);
    const onNavigate = vi.fn();
    const { findByText } = renderEmbed(`See [[${nodeRefTarget(ID_A)}|Pay rent]]`, { onNavigate });
    fireEvent.click(await findByText("Pay rent"));
    expect(onNavigate).toHaveBeenCalledWith(`task-${ID_A}`, ID_A, undefined, undefined);
  });
});

describe("the editor", () => {
  it("shows a whole-line task embed as a widget and leaves an unreadable one's text alone", () => {
    hold([row({ id: ID_A })]);
    const doc = `![[${nodeRefTarget(ID_A)}]]\n\ntext`;
    const state = EditorState.create({ doc, selection: { anchor: doc.length } });
    const lines = embedLineRanges(state, () => ({ nodes: [], from: null }));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.version).toContain("task:Pay rent");
    // Two tasks edited elsewhere redraw: the version follows the task's facts.
    hold([row({ id: ID_A, status: "done" })]);
    expect(embedLineRanges(state, () => ({ nodes: [], from: null }))[0]!.version).not.toBe(lines[0]!.version);
  });
});

describe("task labels and lines", () => {
  const facts = (over: Partial<ReturnType<typeof taskRefsFrom>[number]["task"]> = {}) =>
    ({ ...taskRefsFrom([row({})], [], () => true)[0]!.task, ...over });

  it("reads Anytime, a date, done, and the note it is in", () => {
    expect(taskHint(facts(), "2026-10-24")).toBe("Anytime");
    expect(taskHint(facts({ when: "2026-10-24" }), "2026-10-24")).toBe("Today");
    expect(taskHint(facts({ done: true, hostTitle: "Plan" }), "2026-10-24")).toBe("Done · In “Plan”");
    expect(taskChips(facts({ done: true, deadline: "2026-10-24", recur: "2d" }), "2026-10-24")).toEqual(["Due Today", "Every 2 days"]);
  });

  it("finds the checklist line a task came from", () => {
    const md = "# Plan\n\n- [ ] other {task} ^a\n- [x] Pay rent {task} ^b\n";
    const range = taskLineRange(md, "Pay rent")!;
    expect(md.slice(range.start, range.end)).toBe("- [x] Pay rent {task} ^b");
    expect(taskLineRange("no tasks here", "Pay rent")).toBeNull();
  });
});

