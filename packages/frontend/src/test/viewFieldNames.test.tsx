// A view never shows a field's internal name (updated_at, file.mtime…): the cards' badges, the board's tooltips and an
// imported base's column heads all go through fieldDisplayName (components/viewLayoutKit/builtInFieldLabels.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import GalleryLayout from "../modules/gallery/GalleryLayout";
import { BasesTable } from "../components/views/BasesTable";
import { fieldDisplayName } from "../components/viewLayoutKit";
import type { ExecResponse } from "../lib/viewExec";
import type { ExecRow } from "@onden/contract";

const row = (over: Partial<ExecRow> = {}): ExecRow => ({
  id: "n1", title: "Alpha", slug: "alpha", created_at: "2026-01-01T03:04:05Z", updated_at: "2026-01-02T03:04:05Z", attributes: {}, ...over,
});
const exec = (visible_fields: string[]): ExecResponse => ({
  rows: [row()], total: 1, next: null, view: { layout: "gallery", group_by: null, visible_fields, layout_config: {} },
});

describe("field names in views", () => {
  it("a card's badge for the updated time says 「Updated at」, not updated_at", () => {
    const { container } = render(<GalleryLayout exec={exec(["title", "updated_at", "created_at"])} />);
    expect(screen.getByText("Updated at")).toBeInTheDocument();
    expect(screen.getByText("Created at")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/updated_at|created_at/);
    expect(container.querySelector("[title='updated_at'], [title='created_at']")).toBeNull();
  });

  it("an imported base's built-in columns have names, its own properties keep theirs", () => {
    const { container } = render(<BasesTable rows={[]} view={{ type: "table", order: ["file.name", "file.mtime", "rating"] } as never} />);
    expect([...container.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["Title", "Updated at", "rating"]);
  });

  it("names the built-in columns and leaves a person's own field as written", () => {
    const t = (s: string) => s;
    expect(fieldDisplayName("updated_at", t)).toBe("Updated at");
    expect(fieldDisplayName("file.ctime", t)).toBe("Created at");
    expect(fieldDisplayName("Rating", t)).toBe("Rating");
  });

  // The views' own files: a raw field variable as text or a tooltip is the same leak the cards had.
  it("no view file draws a field variable as text or as a tooltip", () => {
    const src = join(__dirname, "..");
    const files = ["modules/table", "modules/kanban", "modules/calendar", "modules/gallery", "components/views", "components/collections"]
      .flatMap((dir) => readdirSync(join(src, dir)).filter((name) => /\.tsx$/.test(name)).map((name) => join(src, dir, name)));
    const leaks = files.flatMap((file) => readFileSync(file, "utf8").split("\n").flatMap((line, i) =>
      /(>\s*\{(f|field|key|col|column|groupField)\}\s*<|title=\{(f|field|key|col|column|groupField)\})/.test(line) ? [`${file.replace(src, "src")}:${i + 1}`] : []));
    expect(leaks).toEqual([]);
  });
});
