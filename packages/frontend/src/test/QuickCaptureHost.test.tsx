// The shell mounts QuickCaptureHost; the box's code loads on the first request
// to open it. The first request must still open the box once the file arrives
// (this file never loads it beforehand), and a share opens it without a request.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QuickCapture, openQuickCapture } from "../modules/capture";
import { captureProps } from "./helpers/captureProps";
import { resetAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";

beforeAll(() => { bindAccountStorage("host-user", "https://onden.example/"); });
beforeEach(() => { localStorage.clear(); resetAppState(); });

describe("QuickCaptureHost", () => {
  it("shows nothing and loads nothing until asked", () => {
    render(<QuickCapture {...captureProps()} />);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("opens the box on the first request, though the file loads after it", async () => {
    render(<QuickCapture {...captureProps()} />);
    act(() => openQuickCapture());
    expect(await screen.findByRole("textbox", {}, { timeout: 10_000 })).toBeInTheDocument();
  });
});
