// A quoted area of a drawing (`![[Title|ink=頁@x,y,w,h]]`) survives the export's file-name rewrite: the note is
// written under another file name (its title has a `:`), the link is rewritten to that name, and the area stays.

import { describe, expect, it } from "vitest";
import { wikilinkIndex, wikilinksByFileName } from "../services/exportZip.js";

const ID = "00000000-0000-4000-8000-000000000001";
const index = wikilinkIndex([{ id: ID, title: "Sketch: A", slug: "sketch-a" }]);
const rewrite = (md: string) => wikilinksByFileName(md, index, new Map([[ID, "Sketch A"]]), new Map([[ID, "Sketch: A"]]));

describe("wikilinksByFileName and a quoted area", () => {
  it("keeps the area when the file name differs from the title", () => {
    expect(rewrite("![[Sketch: A|ink=page@1,2,3,4]]")).toBe("![[Sketch A|ink=page@1,2,3,4]]");
  });
  it("still writes the title as the label for an ordinary link or embed", () => {
    expect(rewrite("[[Sketch: A]]")).toBe("[[Sketch A|Sketch: A]]");
    expect(rewrite("![[Sketch: A|my label]]")).toBe("![[Sketch A|my label]]");
  });
});
