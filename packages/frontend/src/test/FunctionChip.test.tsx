import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import FunctionChip, { TagName } from "../components/FunctionChip";
import type { Tag } from "../lib/api";

const tag = (id: string, name: string, over: Partial<Tag> = {}): Tag => ({ id, name, color: "", schema_id: null, ...over });

describe("FunctionChip", () => {
  it("a function is its icon and name, never written as #name", () => {
    const { container } = render(<FunctionChip tag={tag("m1", "review", { schema_module: "review" })} />);
    expect(container.querySelector(".function-chip svg")).not.toBeNull();
    expect(container.textContent).toBe("Review");
    expect(container.textContent).not.toContain("#");
  });

  it("TagName: a function is a chip, the person's own tag keeps its #", () => {
    render(<><TagName tag={tag("m1", "review", { schema_module: "review" })} /><span data-testid="own"><TagName tag={tag("t1", "books")} /></span></>);
    expect(document.querySelector(".function-chip")?.textContent).toBe("Review");
    expect(screen.getByTestId("own").textContent).toBe("#books");
  });
});
