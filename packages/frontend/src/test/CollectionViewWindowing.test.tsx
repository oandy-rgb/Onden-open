// Hand-rolled list virtualization for CollectionView (table + list layouts).
//
// Mirrors the OverviewSidebar windower: past ROW_WINDOW_THRESHOLD only the
// visible slice of rows is mounted, with top/bottom spacers keeping the
// scrollbar honest. These tests assert the four contract points from the task:
//   1. below threshold → every row renders, no scroll container / spacers
//   2. above threshold → only a window of rows renders
//   3. the rows shown at a given scroll offset are the correct slice
//   4. windowing never reorders or drops rows (order preserved within the slice)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

// Layouts only read the api() helper on edit; stub it so nothing hits a backend.
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: vi.fn(async () => ({})) };
});

import TableLayout from "../modules/table/TableLayout";
import { ROW_WINDOW_THRESHOLD } from "../components/viewLayoutKit";
import type { ExecResponse } from "../lib/viewExec";

const ROW_PITCH = 40; // px per row we pin via getBoundingClientRect below

function makeExec(rowCount: number, layout: "table"): ExecResponse {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: `node-${i}`,
    title: `Row ${i}`,
    slug: `row-${i}`,
    created_at: "2025-12-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    attributes: {} as Record<string, string | null>,
  }));
  return {
    rows,
    total: rowCount, next: null,
    view: { layout, group_by: null, visible_fields: ["title"], layout_config: {} },
  };
}

/** jsdom has no layout: pin row geometry so the windower can measure a pitch,
 *  and drive scrollTop/clientHeight so the slice is deterministic. We stub the
 *  prototype getter so each rendered row reports a top = its DOM index * pitch
 *  (contiguous, which is all the windower's two-row pitch probe needs). */
function pinGeometry(rowSelector: string) {
  const origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.matches(rowSelector)) {
      const container = this.closest("[data-virt-container]") ?? document.body;
      const rows = Array.from(container.querySelectorAll(rowSelector));
      const idx = rows.indexOf(this);
      return { top: idx * ROW_PITCH, bottom: idx * ROW_PITCH + ROW_PITCH, left: 0, right: 0, width: 100, height: ROW_PITCH, x: 0, y: idx * ROW_PITCH, toJSON: () => ({}) } as DOMRect;
    }
    return origRect.call(this);
  };
  return () => { Element.prototype.getBoundingClientRect = origRect; };
}

describe("CollectionView windowing — TableLayout", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders every row below the threshold (no scroll container, no spacers)", () => {
    const n = ROW_WINDOW_THRESHOLD; // exactly at threshold → NOT windowed (> only)
    const { container } = render(<TableLayout exec={makeExec(n, "table")} />);
    const dataRows = container.querySelectorAll("tr[data-cv-row]");
    expect(dataRows.length).toBe(n);
    expect(container.querySelector(".cv-table-wrap--virt")).toBeNull();
    expect(container.querySelector(".cv-table-virt-spacer")).toBeNull();
  });

  it("mounts only a window of rows past the threshold", () => {
    const n = ROW_WINDOW_THRESHOLD + 700;
    const { container } = render(<TableLayout exec={makeExec(n, "table")} />);
    expect(container.querySelector(".cv-table-wrap--virt")).not.toBeNull();
    const mounted = container.querySelectorAll("tr[data-cv-row]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(n);
    // Bottom spacer present (we're scrolled to the top, lots of rows below).
    expect(container.querySelector(".cv-table-virt-spacer")).not.toBeNull();
  });

  it("shows the correct slice of rows at a given scroll offset", () => {
    const restore = pinGeometry("tr[data-cv-row]");
    try {
      const n = ROW_WINDOW_THRESHOLD + 700;
      const { container } = render(<TableLayout exec={makeExec(n, "table")} />);
      const wrap = container.querySelector(".cv-table-wrap--virt") as HTMLElement;
      wrap.setAttribute("data-virt-container", "");
      // Give the container a viewport and scroll it ~400 rows down.
      Object.defineProperty(wrap, "clientHeight", { value: 600, configurable: true });
      Object.defineProperty(wrap, "scrollTop", { value: 400 * ROW_PITCH, configurable: true });
      fireEvent.scroll(wrap);

      const titles = Array.from(container.querySelectorAll("tr[data-cv-row] .cv-table-title"))
        .map((b) => b.textContent);
      // Window centers on row ~400 (scrollTop / pitch). Row 0 must be gone; a
      // mid-list row must be present; the exact start floats with overscan.
      expect(titles).not.toContain("Row 0");
      expect(titles).toContain("Row 400");
      // Rows stay in source order within the slice.
      const idxs = titles.map((t) => Number(t!.replace("Row ", "")));
      for (let i = 1; i < idxs.length; i++) expect(idxs[i]).toBeGreaterThan(idxs[i - 1]);
    } finally {
      restore();
    }
  });

  it("preserves the full row count in the data even while windowed", () => {
    const n = ROW_WINDOW_THRESHOLD + 50;
    const exec = makeExec(n, "table");
    exec.view.layout_config = { aggregates: true };
    const { container } = render(<TableLayout exec={exec} />);
    // The footer (a view that asks for aggregates) reports the true count regardless of windowing.
    expect(container.querySelector(".cv-table-foot")?.textContent).toContain(`${n} rows`);
  });
});

