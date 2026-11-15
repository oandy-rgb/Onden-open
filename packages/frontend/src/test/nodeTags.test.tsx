// "Is this note tagged X" must count label tags (#toread) as well as class
// tags; the Bases filter and the table lens used to see class tags only.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import BaseRenderer from "../components/views/BaseRenderer";
import { appliedNoteTags, hiddenTags, isTagShown, nodeHasTag, nodeTagIds, shownTags, tagMembers } from "../lib/nodeTags";
import { noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { resetAppState } from "../lib/appStore";

const tag = (id: string, title: string) => ({ id, title, slug: title, node_type: "class_tag", source_type: "manual", markdown: "", hidden: false }) as ContentNode;
const note = (id: string, title: string, extra: Partial<ContentNode>) =>
  ({ id, title, slug: id, node_type: "content", source_type: "manual", markdown: "", hidden: false, ...extra }) as ContentNode;

describe("node tag membership", () => {
  it("unions class and label tags once", () => {
    const n = note("n", "N", { class_tag_ids: ["a", "b"], label_tag_ids: ["b", "c"] });
    expect(nodeTagIds(n)).toEqual(["a", "b", "c"]);
    expect(nodeHasTag(n, "c")).toBe(true);
    expect(nodeHasTag({}, "a")).toBe(false);
  });

  it("a Bases file.hasTag filter matches a label tag", () => {
    const nodes = [
      tag("t-read", "toread"),
      note("n1", "Labelled note", { label_tag_ids: ["t-read"] }),
      note("n2", "Untagged note", {}),
    ];
    const source = "filters:\n  - 'file.hasTag(\"toread\")'\nviews:\n  - type: list\n    name: Queue\n";
    render(<BaseRenderer source={source} nodes={nodes} />);
    expect(screen.queryByText("Labelled note")).not.toBeNull();
    expect(screen.queryByText("Untagged note")).toBeNull();
  });
});

describe("hidden tags (D104): one shown rule, everything else keeps working", () => {
  const secret: Tag = { id: "t-secret", name: "secret", color: "", schema_id: null, hidden: true };
  const plain: Tag = { id: "t-plain", name: "plain", color: "", schema_id: null };

  it("isTagShown / shownTags / hiddenTags split the catalog; a note shows no chip for a hidden tag", () => {
    expect(isTagShown(plain)).toBe(true);
    expect(isTagShown(secret)).toBe(false);
    expect(shownTags([plain, secret])).toEqual([plain]);
    expect(hiddenTags([plain, secret])).toEqual([secret]);
    const n = note("n", "N", { label_tag_ids: ["t-plain", "t-secret"] });
    expect(appliedNoteTags(n, [plain, secret]).map((tag) => tag.id)).toEqual(["t-plain"]);
    // Membership is untouched: the note still carries the tag and is its member.
    expect(nodeHasTag(n, "t-secret")).toBe(true);
    expect(tagMembers([plain, secret], [n], "t-secret").map((row) => row.id)).toEqual(["n"]);
  });

  it("a Bases file.hasTag filter still matches a hidden tag whose row is in no list", () => {
    resetAppState({ data: { ...noWorkspaceData, tags: [secret] } });
    // The overview lists leave a hidden tag's own row out: only the catalog has it.
    const nodes = [note("n1", "Secret note", { label_tag_ids: ["t-secret"] }), note("n2", "Other note", {})];
    const source = "filters:\n  - 'file.hasTag(\"secret\")'\nviews:\n  - type: list\n    name: Queue\n";
    render(<BaseRenderer source={source} nodes={nodes} />);
    expect(screen.queryByText("Secret note")).not.toBeNull();
    expect(screen.queryByText("Other note")).toBeNull();
  });
});
