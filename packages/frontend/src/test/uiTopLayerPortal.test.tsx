import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Modal } from "../components/ui/Modal";
import { TopLayerPortal } from "../components/ui/TopLayerPortal";

// A corner notice must paint above whatever is in the top layer: a modal, or a
// fullscreen element (PDF reader, handwriting). jsdom has no top layer, so this
// pins where the notice is rendered.

function setFullscreen(el: Element | null) {
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: el });
  act(() => { document.dispatchEvent(new Event("fullscreenchange")); });
}

afterEach(() => { Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null }); });

describe("ui/TopLayerPortal", () => {
  it("with nothing open renders in <body>, not in the page tree it was written in", () => {
    const { container } = render(<main><TopLayerPortal><p>note</p></TopLayerPortal></main>);
    expect(container.contains(screen.getByText("note"))).toBe(false);
    expect(screen.getByText("note").parentElement).toBe(document.body);
  });

  it("moves into a fullscreen element when one starts, and back out when it ends", () => {
    const full = document.body.appendChild(document.createElement("div"));
    render(<TopLayerPortal><p>note</p></TopLayerPortal>);
    setFullscreen(full);
    expect(screen.getByText("note").parentElement).toBe(full);
    setFullscreen(null);
    expect(screen.getByText("note").parentElement).toBe(document.body);
    full.remove();
  });

  it("renders inside the open modal", () => {
    render(<><Modal label="Ask" className="layer" onClose={() => {}}><div>card</div></Modal><TopLayerPortal><p>note</p></TopLayerPortal></>);
    expect(document.querySelector("dialog.layer")!.contains(screen.getByText("note"))).toBe(true);
  });
});
