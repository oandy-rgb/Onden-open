// The notice a read-only handwriting surface shows (components/InkNodeView, the real one — not a stand-in): a drawing made with
// a newer version says to update the app; a note the person may not change says that instead, never the update line.
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { stubPagesNearScreen } from "./helpers/nearScreen";
import { bindAccountStorage } from "../lib/accountStorage";
import { inkReadOnlyMessage } from "../lib/ink";

beforeAll(() => { bindAccountStorage("u", ""); });

describe("InkNodeView read-only notice", () => {
  beforeEach(() => {
    localStorage.clear();
    stubPagesNearScreen();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function renderInk(props: { readOnly?: boolean; readOnlyNotice?: string }) {
    const { default: InkNodeView } = await import("../components/InkNodeView");
    return render(<InkNodeView nodeId="n1" {...props} />);
  }

  it("a drawing from a newer version says to update the app", async () => {
    await renderInk({ readOnly: true });
    expect(screen.getByRole("status")).toHaveTextContent(inkReadOnlyMessage());
  });

  it("a note the person may not change says so, and not 「update the app」", async () => {
    await renderInk({ readOnly: true, readOnlyNotice: "You can read this note but not change it, so this opens read-only." });
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("You can read this note but not change it, so this opens read-only.");
    expect(notice).not.toHaveTextContent(/newer version|Update the app/);
  });
});
