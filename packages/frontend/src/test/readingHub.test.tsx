import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { lazy } from "react";
import { BookOpen, Rss } from "lucide-react";
import ReadingScreen from "../components/ReadingScreen";
import { isModuleScreen, isReadingSection, moduleFilterFor, readingSectionsFor } from "../modules";
import { readingEntrySection } from "../lib/readingHub";
import type { ModuleScreenProps, ReadingSection } from "../modules";

const section = (id: string, label: string, text: string): ReadingSection => ({
  id, label, Icon: id === "rss" ? Rss : BookOpen, order: 0,
  Component: lazy(async () => ({ default: (_: ModuleScreenProps) => <p>{text}</p> })),
});
const screenProps = { online: true, target: null, onOpenNode: vi.fn(), onRefresh: vi.fn(), onImmersiveChange: vi.fn() };

afterEach(() => { try { localStorage.removeItem("onden.reading.lastSection"); } catch { /* jsdom */ } });

describe("reading hub registry", () => {
  it("lists the imported modules' sections in hub order; each section is a full-page view", () => {
    // Only RSS adds a section: highlights are
    // ordinary notes, found where notes are, not in 閱讀.
    expect(readingSectionsFor(moduleFilterFor(["rss"])).map((s) => s.id))
      .toEqual(["rss"]);
    expect(readingSectionsFor(moduleFilterFor(["review"]))).toEqual([]);
    for (const gone of ["read_later", "citations", "highlights"]) expect(isReadingSection(gone)).toBe(false);
    expect(isModuleScreen("rss")).toBe(true);
    expect(isModuleScreen("notes")).toBe(false);
  });

  it("reopens on the section last read while it is still there", () => {
    const sections = [{ id: "rss" }, { id: "other" }];
    expect(readingEntrySection(sections)).toBe("rss");
    localStorage.setItem("onden.reading.lastSection", "other");
    expect(readingEntrySection(sections)).toBe("other");
    expect(readingEntrySection([{ id: "rss" }])).toBe("rss");
    expect(readingEntrySection([])).toBeNull();
  });
});

describe("ReadingScreen", () => {
  it("shows the section row and the open section; picking another navigates", async () => {
    const onSelect = vi.fn();
    render(<ReadingScreen activeId="other" onSelect={onSelect} {...screenProps}
      sections={[section("rss", "RSS", "the reader"), section("other", "Other", "the queue")]} />);
    expect(await screen.findByText("the queue")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Reading sections" });
    expect(within(nav).getByRole("button", { name: "Other" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(nav).getByRole("button", { name: "RSS" }));
    expect(onSelect).toHaveBeenCalledWith("rss");
    expect(localStorage.getItem("onden.reading.lastSection")).toBe("other");
  });

  it("has no section row with a single section", async () => {
    render(<ReadingScreen activeId="rss" onSelect={vi.fn()} {...screenProps} sections={[section("rss", "RSS", "the reader")]} />);
    expect(await screen.findByText("the reader")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Reading sections" })).toBeNull();
  });
});
