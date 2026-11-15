import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setAppState } from "../lib/appStore";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import type { Tag } from "../lib/api";
import FeaturedFields from "../components/FeaturedFields";

const tag = (fields: Tag["schema_fields"]): Tag =>
  ({ id: "t", name: "t", color: "#888", schema_id: "s", schema_fields: fields });

describe("featured fields on the note", () => {
  it("hides unnamed empty fields but keeps named ones and filled ones", () => {
    render(<FeaturedFields
      classTags={[tag([{ name: "field_1", type: "text" }, { name: "field_2", type: "text" }, { name: "author", type: "text" }])]}
      attrs={{ field_2: "x" }} onAttrSet={() => {}} />);
    expect(screen.queryByText("field_1")).toBeNull();
    expect(screen.getByText("field_2")).toBeInTheDocument();
    expect(screen.getByText("author")).toBeInTheDocument();
  });

  it("renders nothing when every field is an unnamed empty one", () => {
    const { container } = render(<FeaturedFields classTags={[tag([{ name: "field_1", type: "text" }])]} attrs={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("a linked note shows by its title, never its id, and editing opens the same controls as the tag card", async () => {
    setAppState({ data: { ...noWorkspaceData, nodes: [{ id: "11111111-1111-4111-8111-111111111111", title: "上次的講稿" } as ContentNode] } });
    render(<FeaturedFields classTags={[tag([{ name: "ref", label: "參考", type: "relation" }, { name: "day", label: "日期", type: "date" }])]}
      attrs={{ ref: "11111111-1111-4111-8111-111111111111" }} onAttrSet={() => {}} />);
    expect(screen.getByText("上次的講稿")).toBeInTheDocument();
    expect(screen.queryByText(/11111111/)).toBeNull();
    fireEvent.click(screen.getByTitle("Edit 日期"));
    expect(await screen.findByRole("button", { name: "日期" })).toHaveAttribute("aria-expanded", "false");
  });

  it("pressing a cell puts the caret in its field, so typing right away writes the value", async () => {
    setAppState({ data: { ...noWorkspaceData, nodes: [] } });
    render(<FeaturedFields classTags={[tag([{ name: "city", label: "城市", type: "text" }])]} attrs={{}} onAttrSet={() => {}} />);
    fireEvent.click(screen.getByTitle("Edit 城市"));
    const input = await screen.findByRole("textbox", { name: "城市" });
    await waitFor(() => expect(input).toHaveFocus());
  });
});
