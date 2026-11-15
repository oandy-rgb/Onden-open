import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import InlineProps from "../components/InlineProps";
import type { Tag } from "../lib/api";

const bookTag: Tag = {
  id: "tag-book",
  name: "book",
  color: "#f59e0b",
  schema_id: "schema-book",
  schema_slug: "book",
 
  schema_fields: [
    { name: "status", label: "Status", type: "select", options: ["wishlist", "reading", "done"] },
  ],
};

describe("InlineProps", () => {
  it("renders the node's own non-empty plain properties as label: value", () => {
    render(
      <InlineProps
        attrs={{ source: "Aristotle", due: "2026-07-01" }}
        classTags={[]}
      />,
    );
    expect(screen.getByText("source")).toBeInTheDocument();
    expect(screen.getByText("Aristotle")).toBeInTheDocument();
    expect(screen.getByText("due")).toBeInTheDocument();
    expect(screen.getByText("2026-07-01")).toBeInTheDocument();
  });

  it("hides empty / whitespace-only values", () => {
    render(
      <InlineProps
        attrs={{ source: "Aristotle", note: "", blank: "   " }}
        classTags={[]}
      />,
    );
    expect(screen.getByText("source")).toBeInTheDocument();
    // Empty and whitespace-only props are not surfaced.
    expect(screen.queryByText("note")).not.toBeInTheDocument();
    expect(screen.queryByText("blank")).not.toBeInTheDocument();
  });

  it("hides system-reserved (_) and editor-machinery keys", () => {
    render(
      <InlineProps
        attrs={{
          source: "Aristotle",
          _internal: "secret",
          pdf_url: "https://x/y.pdf",
          ink_data: "{...}",
          sketch_data: "{...}",
        }}
        classTags={[]}
      />,
    );
    expect(screen.getByText("source")).toBeInTheDocument();
    expect(screen.queryByText("_internal")).not.toBeInTheDocument();
    expect(screen.queryByText("pdf_url")).not.toBeInTheDocument();
    expect(screen.queryByText("ink_data")).not.toBeInTheDocument();
    expect(screen.queryByText("sketch_data")).not.toBeInTheDocument();
  });

  it("excludes keys claimed by an applied class-tag schema (those render in FeaturedFields)", () => {
    render(
      <InlineProps
        attrs={{ status: "reading", source: "Aristotle" }}
        classTags={[bookTag]}
      />,
    );
    // `status` is a schema field of #book → not duplicated here.
    expect(screen.queryByText("status")).not.toBeInTheDocument();
    // A plain own property still shows.
    expect(screen.getByText("source")).toBeInTheDocument();
  });

  it("renders nothing when there are no key props (no empty strip)", () => {
    const { container } = render(
      <InlineProps attrs={{ _internal: "x", blank: "" }} classTags={[]} />,
    );
    expect(container.querySelector(".inline-props")).toBeNull();
  });

  it("uses no programmer-UI jargon (no value_type / schema / is_inheritable labels)", () => {
    render(<InlineProps attrs={{ source: "Aristotle" }} classTags={[]} />);
    expect(screen.queryByText(/value_type/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/schema/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/is_inheritable/i)).not.toBeInTheDocument();
  });
});
