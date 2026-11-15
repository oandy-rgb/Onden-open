import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { resetAppState } from "../../lib/appStore";
import { reads } from "../../lib/data";
import { setLocalePref } from "../../lib/i18n";
import SemanticIndexWidget from "./SemanticIndexWidget";

const ctx = { online: true } as never;
const status = (s: { ready: number; total: number; working: boolean }) => vi.spyOn(reads.modules.semantic, "status").mockResolvedValue(s);

beforeEach(() => { setLocalePref("zh-TW"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); resetAppState(); });

describe("SemanticIndexWidget", () => {
  it("says in plain words how many notes are ready", async () => {
    status({ ready: 12, total: 40, working: false });
    render(<SemanticIndexWidget ctx={ctx} />);
    expect(await screen.findByText("40 則筆記裡有 12 則準備好了，可以用意思找。")).toBeTruthy();
  });

  it("while working it reports progress, and when done it says all are ready", async () => {
    status({ ready: 5, total: 40, working: true });
    const { unmount } = render(<SemanticIndexWidget ctx={ctx} />);
    expect(await screen.findByText("正在準備你的筆記… 40 則裡已有 5 則好了。")).toBeTruthy();
    unmount();
    status({ ready: 40, total: 40, working: false });
    render(<SemanticIndexWidget ctx={ctx} />);
    expect(await screen.findByText("40 則筆記都準備好了，可以用意思找。")).toBeTruthy();
  });

  it("offline it says it needs a connection, with no technical words", () => {
    render(<SemanticIndexWidget ctx={{ online: false } as never} />);
    expect(screen.getByText("連上網路才看得到有多少筆記準備好了。")).toBeTruthy();
  });
});
