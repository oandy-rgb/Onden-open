import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ContentNode, Tag } from "../lib/api";
import TitleTagRow, { cleanTagName, tagSuggestions } from "../components/TitleTagRow";
import { tagWriter } from "../lib/data/domainWriters";

vi.mock("../lib/data/domainWriters", async (original) => ({
  ...await original<typeof import("../lib/data/domainWriters")>(),
  tagWriter: { apply: vi.fn(), remove: vi.fn(), create: vi.fn() },
}));
const note: ContentNode = { id: "note", title: "Note", slug: "note", markdown: "", source_type: "manual", node_type: "content" };
const tag = (id: string, name: string, extra: Partial<Tag> = {}): Tag => ({ id, name, color: "#888", schema_id: null, ...extra });
const paper = tag("paper", "paper");
const idea = tag("idea", "idea");
const course = tag("course", "Course", { schema_id: "course", schema_behaviour: { modules: { skills: { enabled: true } } } });

function mount(node: ContentNode = note, tags: Tag[] = [paper, idea, course]) {
  const toggle = vi.fn();
  render(<TitleTagRow node={node} tags={tags} onToggleTag={toggle} />);
  return { toggle };
}
function typeTag(text: string) {
  fireEvent.click(screen.getByRole("button", { name: /Tag/ }));
  const input = screen.getByRole("combobox", { name: "Add a tag" });
  fireEvent.change(input, { target: { value: text } });
  return input;
}

beforeEach(() => {
  vi.mocked(tagWriter.apply).mockReset().mockResolvedValue({ status: "synced", value: undefined });
  vi.mocked(tagWriter.remove).mockReset().mockResolvedValue({ status: "synced", value: undefined });
  vi.mocked(tagWriter.create).mockReset().mockResolvedValue({ id: "new-tag", queued: false });
});

describe("tag helpers", () => {
  it("cleans a typed name", () => {
    expect(cleanTagName("  ##idea ")).toBe("idea");
  });
  it("suggests names that start with the query first", () => {
    expect(tagSuggestions([tag("a", "my-paper"), paper, tag("b", "paperwork")], "pa").map((t) => t.name))
      .toEqual(["paper", "paperwork", "my-paper"]);
  });
});

describe("tags under the title", () => {
  it("applies an existing tag picked while typing", async () => {
    mount();
    const input = typeTag("pap");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(tagWriter.apply).toHaveBeenCalledWith("note", "paper"));
    expect(tagWriter.create).not.toHaveBeenCalled();
  });

  it("creates a new tag and applies it in one step", async () => {
    mount();
    const input = typeTag("#thesis");
    expect(screen.getByRole("option", { name: "Create #thesis" })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(tagWriter.apply).toHaveBeenCalledWith("note", "new-tag"));
    expect(tagWriter.create).toHaveBeenCalledWith("thesis");
  });

  it("never offers a view module tag (#月曆 describes tags, not notes — rule 6)", () => {
    mount(note, [paper, tag("cal", "月曆", { schema_module: "calendar" })]);
    typeTag("月");
    expect(screen.queryByRole("option", { name: /月曆/ })).toBeNull();
    expect(screen.getByRole("option", { name: "Create #月" })).toBeInTheDocument();
  });

  it("offers no Create for a name with \"/\" (a path: #a/b in a note makes two levels)", () => {
    mount();
    typeTag("course/week1");
    expect(screen.queryByRole("option", { name: /Create/ })).toBeNull();
  });

  it("does not create a duplicate when the name exists in another case", async () => {
    mount();
    const input = typeTag("IDEA");
    expect(screen.queryByRole("option", { name: /Create/ })).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(tagWriter.apply).toHaveBeenCalledWith("note", "idea"));
  });

  it("shows applied tags; a plain tag is removed at once, one with functions asks first", async () => {
    const { toggle } = mount({ ...note, class_tag_ids: ["course"], label_tag_ids: ["paper"] });
    fireEvent.click(screen.getByRole("button", { name: "#paper" }));
    expect(toggle).toHaveBeenCalledWith("paper");

    fireEvent.click(screen.getByRole("button", { name: "Remove #paper from this note" }));
    await waitFor(() => expect(tagWriter.remove).toHaveBeenCalledWith("note", "paper"));

    fireEvent.click(screen.getByRole("button", { name: "Remove #Course from this note" }));
    expect(tagWriter.remove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove tag" }));
    await waitFor(() => expect(tagWriter.remove).toHaveBeenCalledWith("note", "course"));
  });

  it("a chip says whether its card is open (aria-expanded) and points at the card", () => {
    const node = { ...note, label_tag_ids: ["paper", "idea"] };
    const { rerender } = render(<TitleTagRow node={node} tags={[paper, idea]} onToggleTag={() => {}} />);
    expect(screen.getByRole("button", { name: "#paper" })).toHaveAttribute("aria-expanded", "false");
    rerender(<TitleTagRow node={node} tags={[paper, idea]} onToggleTag={() => {}} expandedTagId="paper" cardId="card-1" />);
    expect(screen.getByRole("button", { name: "#paper" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "#paper" })).toHaveAttribute("aria-controls", "card-1");
    expect(screen.getByRole("button", { name: "#idea" })).toHaveAttribute("aria-expanded", "false");
  });

  it("is the one place to add a tag: exactly one \"＋\", named for what it adds", () => {
    mount({ ...note, label_tag_ids: ["paper"] });
    expect(screen.getAllByRole("button", { name: "Add a tag" })).toHaveLength(1);
  });

  it("with no tags the add button says \"Tag\" and the row is marked empty", () => {
    const { container } = render(<TitleTagRow node={note} tags={[paper, idea]} onToggleTag={() => {}} />);
    expect(screen.getAllByRole("button", { name: "Tag" })).toHaveLength(1);
    expect(container.querySelector(".title-tag-row--empty")).not.toBeNull();
  });

  it("lists only applied tags: a #word in the title or body is not a tag (T10)", () => {
    mount({ ...note, title: "讀書 #idea", markdown: "#draft and #idea", label_tag_ids: ["paper"] }, [paper, idea]);
    expect(screen.getAllByRole("button", { name: "#paper" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "#idea" })).toBeNull();
    expect(screen.queryByRole("button", { name: "#draft" })).toBeNull();
  });
});

describe("a tag only the app applies", () => {
  const inbox = tag("inbox", "收件匣", { schema_id: "capture", schema_module: "capture" });

  it("is never suggested, not even by its full name, and typing it creates nothing", () => {
    expect(tagSuggestions([paper, inbox], "").map((t) => t.name)).toEqual(["paper"]);
    expect(tagSuggestions([paper, inbox], "收件匣")).toEqual([]);
    mount(note, [paper, inbox]);
    typeTag("收件匣");
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("keeps its chip on a note that carries it, with no way to take it off by hand", () => {
    mount({ ...note, class_tag_ids: ["inbox", "paper"] }, [paper, inbox]);
    expect(screen.getByText("收件匣")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove #收件匣/ })).toBeNull();
    // the person's own tag beside it keeps its ×
    expect(screen.getByRole("button", { name: /Remove #paper/ })).toBeTruthy();
  });
});

describe("hidden tags (D104)", () => {
  const secret = tag("secret", "secret", { hidden: true });

  it("are never suggested, except for their full name", () => {
    expect(tagSuggestions([paper, secret, tag("s2", "secrets")], "").map((t) => t.name)).toEqual(["paper", "secrets"]);
    expect(tagSuggestions([paper, secret, tag("s2", "secrets")], "sec").map((t) => t.name)).toEqual(["secrets"]);
    expect(tagSuggestions([paper, secret, tag("s2", "secrets")], "#Secret").map((t) => t.name)).toEqual(["secret", "secrets"]);
  });

  it("show no chip on a note that carries one", () => {
    mount({ ...note, label_tag_ids: ["paper", "secret"] }, [paper, idea, secret]);
    expect(screen.getByRole("button", { name: "#paper" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "#secret" })).toBeNull();
  });

  it("typing a hidden tag's full name offers it, not Create", async () => {
    mount(note, [paper, idea, secret]);
    const input = typeTag("secre");
    expect(screen.queryByRole("option", { name: /secret/ })).toBeNull();
    fireEvent.change(input, { target: { value: "secret" } });
    expect(screen.queryByRole("option", { name: /Create/ })).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(tagWriter.apply).toHaveBeenCalledWith("note", "secret"));
  });
});
