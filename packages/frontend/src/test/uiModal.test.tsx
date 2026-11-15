import { describe, it, expect, vi } from "vitest";
import { useRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "../components/ui/Modal";

// ui/Modal's dismissal rules. jsdom has no top layer (setup.ts stubs
// showModal), so focus containment is left to the browser tests.

function Harness({ onClose, busy = false }: { onClose: () => void; busy?: boolean }) {
  const confirm = useRef<HTMLButtonElement>(null);
  return (
    <Modal label="Ask" role="alertdialog" className="layer" busy={busy} onClose={onClose} initialFocus={confirm}>
      <div className="card"><p>Sure?</p><button type="button">No</button><button type="button" ref={confirm}>Yes</button></div>
    </Modal>
  );
}

const layer = () => document.querySelector("dialog.layer") as HTMLDialogElement;

describe("ui/Modal", () => {
  it("opens as a named modal and focuses the requested control", () => {
    render(<Harness onClose={vi.fn()} />);
    expect(screen.getByRole("alertdialog", { name: "Ask" })).toBe(layer());
    expect(layer().open).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Yes" }));
  });

  it("Esc (cancel) and a press on the layer ask to close", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent(layer(), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(layer());
    fireEvent.click(layer());
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Esc in a modal opened from a modal closes only the top one", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <Modal label="Outer" className="outer" onClose={outer}>
        <div><Modal label="Inner" className="inner" onClose={inner}><div>Top</div></Modal></div>
      </Modal>,
    );
    fireEvent(document.querySelector("dialog.inner")!, new Event("cancel", { cancelable: true }));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("a press that starts in the card and ends on the layer does not close", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.pointerDown(screen.getByText("Sure?"));
    fireEvent.click(layer());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("busy holds it open, even when the browser closes the dialog itself", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} busy />);
    fireEvent(layer(), new Event("cancel", { cancelable: true }));
    fireEvent.pointerDown(layer());
    fireEvent.click(layer());
    layer().open = false;
    fireEvent(layer(), new Event("close"));
    expect(onClose).not.toHaveBeenCalled();
    expect(layer().open).toBe(true);
  });

  it("a browser-initiated close is reported, and focus returns on unmount", () => {
    const outside = document.createElement("button"); document.body.append(outside); outside.focus();
    const onClose = vi.fn();
    const { unmount } = render(<Harness onClose={onClose} />);
    fireEvent(layer(), new Event("close"));
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("renders inside the fullscreen element and follows it when fullscreen starts and ends", () => {
    const pdf = document.createElement("div");
    document.body.appendChild(pdf);
    const setFullscreen = (el: Element | null) => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => el });
      document.dispatchEvent(new Event("fullscreenchange"));
    };
    try {
      // Opened while already fullscreen (a confirm inside the PDF reader).
      setFullscreen(pdf);
      const onClose = vi.fn();
      const view = render(<Harness onClose={onClose} />);
      expect(pdf.contains(layer())).toBe(true);
      // Fullscreen ends: the open modal goes back to <body>, still open and not closed.
      setFullscreen(null);
      expect(pdf.contains(layer())).toBe(false);
      expect(document.body.contains(layer())).toBe(true);
      expect(layer().open).toBe(true);
      // Fullscreen starts under an open modal: it moves in.
      setFullscreen(pdf);
      expect(pdf.contains(layer())).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
      view.unmount();
      expect(document.querySelector("dialog.layer")).toBeNull();
    } finally {
      setFullscreen(null);
      pdf.remove();
    }
  });
});
