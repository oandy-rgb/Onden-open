import { untitledTitle } from "../lib/noteLabel";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import GalleryLayout from "../modules/gallery/GalleryLayout";
import type { ExecResponse } from "../lib/viewExec";
import type { ExecRow } from "@onden/contract";

function makeRow(over: Partial<ExecRow> = {}): ExecRow {
  return {
    id: "n1",
    title: "Untitled",
    slug: "untitled",
    created_at: "2026-01-01T03:04:05Z",
    updated_at: "2026-01-02T03:04:05Z",
    attributes: {},
    ...over,
  };
}

function makeExec(rows: ExecRow[], visible_fields: string[]): ExecResponse {
  return {
    rows,
    total: rows.length, next: null,
    view: { layout: "gallery", group_by: null, visible_fields, layout_config: {} },
  };
}

describe("GalleryLayout", () => {
  it("renders an empty state when there are no rows", () => {
    render(<GalleryLayout exec={makeExec([], ["title"])} />);
    expect(screen.getByText(/no rows match/i)).toBeInTheDocument();
  });

  it("renders one card per row with the title", () => {
    const exec = makeExec(
      [
        makeRow({ id: "a", title: "Alpha" }),
        makeRow({ id: "b", title: "Beta" }),
      ],
      ["title"],
    );
    render(<GalleryLayout exec={exec} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("falls back to the untitled name when title is empty", () => {
    const exec = makeExec([makeRow({ id: "a", title: "" })], ["title"]);
    render(<GalleryLayout exec={exec} />);
    expect(screen.getByText(untitledTitle())).toBeInTheDocument();
  });

  it("renders a cover image from a media-hinted field and resolves bare ids via /api/media/", () => {
    const exec = makeExec(
      [makeRow({ id: "a", title: "Has cover", attributes: { cover: "abc123" } })],
      ["title", "cover"],
    );
    const { container } = render(<GalleryLayout exec={exec} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    // Bare media id -> served through the media endpoint.
    expect(img?.getAttribute("src")).toContain("/api/media/abc123");
  });

  it("uses an absolute image URL value when a field value looks like an image", () => {
    const exec = makeExec(
      [makeRow({ id: "a", title: "URL cover", attributes: { photo: "https://cdn.example.com/x.jpg" } })],
      ["title", "photo"],
    );
    const { container } = render(<GalleryLayout exec={exec} />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://cdn.example.com/x.jpg");
  });

  it("shows a letter placeholder when no cover is available", () => {
    const exec = makeExec([makeRow({ id: "a", title: "Plain" })], ["title"]);
    const { container } = render(<GalleryLayout exec={exec} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".cv-gallery-cover-placeholder")?.textContent).toBe("P");
  });

  it("renders key fields as badges but not the cover field", () => {
    const exec = makeExec(
      [makeRow({ id: "a", title: "Card", attributes: { status: "active", cover: "img1" } })],
      ["title", "status", "cover"],
    );
    render(<GalleryLayout exec={exec} />);
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    // Cover field is shown as the image, never repeated as a badge.
    expect(screen.queryByText("cover")).toBeNull();
  });

  it("calls onSelectNode when a card is clicked", () => {
    const onSelect = vi.fn();
    const exec = makeExec([makeRow({ id: "z", title: "Click me" })], ["title"]);
    render(<GalleryLayout exec={exec} onSelectNode={onSelect} />);
    fireEvent.click(screen.getByText("Click me"));
    expect(onSelect).toHaveBeenCalledWith("z");
  });

  it("does not crash and disables cards when onSelectNode is absent", () => {
    const exec = makeExec([makeRow({ id: "z", title: "No handler" })], ["title"]);
    const { container } = render(<GalleryLayout exec={exec} />);
    const btn = container.querySelector("button.cv-gallery-card") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
