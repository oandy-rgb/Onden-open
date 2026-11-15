import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Menu, MenuItem, Modal, usePopover } from "../components/ui";
import ToastStack from "../components/ToastStack";
import { addToast, resetAppState } from "../lib/appStore";

// A modal is a native <dialog> in the top layer, which paints above <body>: a
// menu or a toast rendered in the page would sit behind it, out of reach.

function MenuInModal() {
  const [open, setOpen] = useState(false);
  const menu = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false) });
  return (
    <Modal label="Card" onClose={() => {}}>
      <button ref={menu.anchor} type="button" onClick={() => setOpen(true)}>Open</button>
      {open && <Menu popover={menu} label="Choices"><MenuItem onSelect={() => {}}>One</MenuItem></Menu>}
    </Modal>
  );
}

afterEach(() => { cleanup(); resetAppState(); });

describe("floating surfaces over a modal", () => {
  it("a menu opened inside a modal is rendered in that modal's layer", () => {
    render(<MenuInModal />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("menu", { name: "Choices" }).closest("dialog")).toBe(screen.getByRole("dialog", { name: "Card" }));
  });

  it("a toast shown while a modal is open is inside it, and back in the page after", () => {
    const { rerender } = render(<><ToastStack /><Modal label="Card" onClose={() => {}}><p>body</p></Modal></>);
    act(() => addToast("Moved", "success", { label: "Undo", onClick: () => {} }));
    expect(screen.getByRole("button", { name: "Undo" }).closest("dialog")).not.toBeNull();
    rerender(<ToastStack />);
    expect(screen.getByRole("button", { name: "Undo" }).closest("dialog")).toBeNull();
  });

  it("a plain 「done」 toast waits for the dialog to close; a failure shows inside it", () => {
    const { rerender } = render(<><ToastStack /><Modal label="Card" onClose={() => {}}><p>body</p></Modal></>);
    act(() => { addToast("Saved", "success"); addToast("Could not save", "error"); });
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getByText("Could not save").closest("dialog")).not.toBeNull();
    rerender(<ToastStack />);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("the answer to what the person just did in the dialog (inDialog) shows inside it at once", () => {
    render(<><ToastStack /><Modal label="Card" onClose={() => {}}><p>body</p></Modal></>);
    act(() => { addToast("Downloaded it", "success", undefined, { inDialog: true }); });
    expect(screen.getByText("Downloaded it").closest("dialog")).not.toBeNull();
  });
});
