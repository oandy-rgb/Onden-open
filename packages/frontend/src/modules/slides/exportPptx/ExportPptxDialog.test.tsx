import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentNode } from "../../../lib/api";

const exportDeck = vi.fn();
const downloadBlob = vi.fn();
vi.mock("./exportDeck", () => ({ exportDeck: (...args: unknown[]) => exportDeck(...args) }));
vi.mock("../../../lib/download", () => ({ downloadBlob: (...args: unknown[]) => downloadBlob(...args) }));

import ExportPptxDialog from "./ExportPptxDialog";
import { ExportCancelled } from "./writePptx";

const node = { id: "n1", title: "期末專題", markdown: "# 標題\n\n---\n\n## 第二頁\n- 一\n- 二\n\n---\n\n## 公式\n$$\nE=mc^2\n$$", node_type: "content", attrs: {}, deleted_at: null } as unknown as ContentNode;
const ok = (extra: object = {}) => ({ blob: new Blob(["x"]), missingPictures: [], inlineFormulaSlides: [], texFormulaSlides: [], ...extra });
const button = (name: RegExp) => screen.getByRole("button", { name });

beforeEach(() => { exportDeck.mockReset(); downloadBlob.mockReset(); });
afterEach(cleanup);

describe("the export panel", () => {
  it("shows the fonts, what is replaced and what becomes a picture, before anything is made", () => {
    render(<ExportPptxDialog node={node} onClose={() => {}} />);
    expect(screen.getByText(/Fonts replaced: Noto Sans TC → Microsoft JhengHei/)).toBeTruthy();
    expect(screen.getByText(/Formulas on slide 3 become pictures/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Keep Onden fonts" }));
    expect(screen.getByText(/Fonts stay as they are/)).toBeTruthy();
    expect(exportDeck).not.toHaveBeenCalled();
  });

  it("exports with the chosen fonts, downloads the file under the note's title, and closes", async () => {
    exportDeck.mockResolvedValue(ok());
    const onClose = vi.fn();
    render(<ExportPptxDialog node={node} onClose={onClose} />);
    fireEvent.click(screen.getByRole("radio", { name: "Noto" }));
    fireEvent.click(button(/^Export$/));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(exportDeck.mock.calls[0]![0]).toMatchObject({ font: "noto", title: "期末專題" });
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "期末專題.pptx");
  });

  it("stays open to say which slides had a picture it could not read, and which have a formula written as TeX", async () => {
    exportDeck.mockResolvedValue(ok({ missingPictures: [{ slide: 2, count: 1 }, { slide: 4, count: 2 }], inlineFormulaSlides: [3], texFormulaSlides: [5] }));
    const onClose = vi.fn();
    render(<ExportPptxDialog node={node} onClose={onClose} />);
    fireEvent.click(button(/^Export$/));
    expect(await screen.findByText("Some pictures could not be read and are grey boxes: slide 2, 4.")).toBeTruthy();
    expect(screen.getByText(/Formulas inside the text on slide 3 are written as plain TeX/)).toBeTruthy();
    expect(screen.getByText(/could not draw the formulas on slide 5 as pictures; they are written as plain TeX/)).toBeTruthy();
    expect(downloadBlob).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("goes back to the start when cancelled, with no file", async () => {
    exportDeck.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new ExportCancelled()))));
    render(<ExportPptxDialog node={node} onClose={() => {}} />);
    fireEvent.click(button(/^Export$/));
    fireEvent.click(await screen.findByRole("button", { name: /^Cancel$/ }));
    await waitFor(() => expect(button(/^Export$/)).toBeTruthy());
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("goes back to the start when cancelled while the file is being written (the export still returns)", async () => {
    let finish: (value: unknown) => void = () => {};
    exportDeck.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<ExportPptxDialog node={node} onClose={() => {}} />);
    fireEvent.click(button(/^Export$/));
    fireEvent.click(await screen.findByRole("button", { name: /^Cancel$/ }));
    finish(ok());
    await waitFor(() => expect(button(/^Export$/)).toBeTruthy());
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("says so, and can be tried again, when the file could not be made", async () => {
    exportDeck.mockRejectedValue(new Error("boom"));
    render(<ExportPptxDialog node={node} onClose={() => {}} />);
    fireEvent.click(button(/^Export$/));
    expect(await screen.findByText("The file could not be made. You can try again.")).toBeTruthy();
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(button(/^Export$/)).toBeTruthy();
  });
});
