import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import RegionErrorBoundary from "../components/RegionErrorBoundary";
import AppErrorBoundary from "../components/AppErrorBoundary";

let renders = 0;
let broken = true;
function FakeModule() {
  renders++;
  if (broken) throw new Error("kaboom-for-test id-1234");
  return <div>module screen</div>;
}

/** A page like the notes workspace: sidebar and center are separate regions; the center follows the open note. */
function Page() {
  const [note, setNote] = useState("a");
  return (
    <div>
      <RegionErrorBoundary region="sidebar" resetKeys={[note]}><nav>sidebar</nav></RegionErrorBoundary>
      <button type="button" onClick={() => setNote("b")}>other note</button>
      <textarea aria-label="editor" />
      <RegionErrorBoundary region="center" resetKeys={[note]}>
        {note === "a" ? <FakeModule /> : <main>main of {note}</main>}
      </RegionErrorBoundary>
    </div>
  );
}

describe("RegionErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    renders = 0;
    broken = true;
  });

  it("only the broken region shows the message; the rest stays, with no error text", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Page />);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("sidebar")).toBeTruthy();
    expect(screen.getByLabelText("editor")).toBeTruthy();
    expect(screen.queryByText(/kaboom|1234/)).toBeNull();
    expect(screen.getByRole("button", { name: "Try this part again" })).toBeTruthy();
    // reported once, to the console, with the region named
    const reports = log.mock.calls.filter((call) => String(call[0]).startsWith("[RegionErrorBoundary:center]"));
    expect(reports).toHaveLength(1);
  });

  it("the typed text of a healthy sibling survives the error and the retry", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Page />);
    const editor = screen.getByLabelText("editor") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "half a sentence" } });
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try this part again" }));
    expect(screen.getByLabelText("editor")).toBe(editor);
    expect(editor.value).toBe("half a sentence");
  });

  it("Try again renders the region again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Page />);
    const before = renders;
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try this part again" }));
    expect(renders).toBeGreaterThan(before);
    expect(screen.getByText("module screen")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("going to another note clears the message", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Page />);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByText("other note"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("main of b")).toBeTruthy();
  });

  it("an error still broken after Try again shows the message again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Try this part again" }));
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("hands a code-split file that did not load to the app's boundary, which offers the reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function MissingChunk(): never {
      throw new TypeError("Failed to fetch dynamically imported module: /assets/Screen-abc.js");
    }
    render(
      <AppErrorBoundary>
        <RegionErrorBoundary region="center"><MissingChunk /></RegionErrorBoundary>
      </AppErrorBoundary>,
    );
    expect(screen.queryByText("Try this part again")).toBeNull();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });
});
