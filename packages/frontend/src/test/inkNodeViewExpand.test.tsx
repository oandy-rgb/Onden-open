// 「放大畫面」 on the handwriting page: the same button and behaviour as the PDF
// (components/ExpandPaneButton + hooks/useExpandedPane), also when read-only.
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubPagesNearScreen } from "./helpers/nearScreen";
import { fireEvent, render } from "@testing-library/react";
import { bindAccountStorage } from "../lib/accountStorage";

beforeAll(() => { bindAccountStorage("u", ""); });

describe("InkNodeView 放大畫面", () => {
  beforeEach(() => {
    localStorage.clear();
    stubPagesNearScreen();
  vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function renderInk(props: { readOnly?: boolean } = {}) {
    const { default: InkNodeView } = await import("../components/InkNodeView");
    return render(<InkNodeView nodeId="n1" {...props} />);
  }
  const toggle = () => document.querySelector("[data-pdf-expand]") as HTMLButtonElement;

  it("the toolbar's button enlarges the page and Esc shrinks it", async () => {
    const { container } = await renderInk();
    const root = container.querySelector(".ink-note") as HTMLElement;
    expect(toggle()).toHaveAttribute("aria-label", "Enlarge");
    expect(root.className).not.toContain("pane--expanded");
    fireEvent.click(toggle());
    expect(root.className).toContain("pane--expanded");
    expect(toggle()).toHaveAttribute("aria-label", "Shrink (Esc)");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(root.className).not.toContain("pane--expanded");
    expect(toggle()).toHaveAttribute("aria-label", "Enlarge");
  });

  it("is remembered for the note across a remount", async () => {
    const first = await renderInk();
    fireEvent.click(toggle());
    first.unmount();
    const { container } = await renderInk();
    expect(container.querySelector(".ink-note")?.className).toContain("pane--expanded");
  });

  it("a read-only page can be enlarged too", async () => {
    const { container } = await renderInk({ readOnly: true });
    fireEvent.click(toggle());
    expect(container.querySelector(".ink-note")?.className).toContain("pane--expanded");
  });
});
