import { describe, expect, it } from "vitest";
import type { PuckComponentData, PuckData } from "./design.js";
import { withImplicitStacks } from "./topLevel.js";

const c = (type: string, props: Record<string, unknown> = {}): PuckComponentData => ({ type, props: { id: `${type}-x`, ...props } });
const home = (...content: PuckComponentData[]): PuckData => ({ root: { props: {} }, content });

describe("withImplicitStacks", () => {
  it("puts a default stack around each top-level content component and leaves layouts alone", () => {
    const out = withImplicitStacks(home(c("note", { id: "n1" }), c("sidebar", { id: "sb" }), c("tag_view", { id: "t1" })));
    expect(out.content.map((x) => x.type)).toEqual(["stack", "sidebar", "stack"]);
    expect(out.content[0]!.props).toMatchObject({ bg: "none", heading: "auto", cls: "", css: "" });
    expect((out.content[0]!.props.items as PuckComponentData[]).map((x) => x.props.id)).toEqual(["n1"]);
  });
  it("returns the same home when there is no top-level content", () => {
    const h = home(c("stack"));
    expect(withImplicitStacks(h)).toBe(h);
  });
});
