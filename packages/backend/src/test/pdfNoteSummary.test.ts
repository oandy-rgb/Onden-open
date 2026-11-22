import { describe, expect, it } from "vitest";
import { pdfNoteSummary } from "../services/agentTools/pdfNoteSummary.js";

describe("getNode's pdf_note", () => {
  it("is absent for a note that is not a PDF", () => {
    expect(pdfNoteSummary([{ key: "status" }], "text")).toBeNull();
  });
  it("counts the extracted characters of a PDF note", () => {
    expect(pdfNoteSummary([{ key: "pdf_url" }], "  hello world ")).toContain("holds 11 characters");
  });
  it("says no text could be extracted when the body is empty", () => {
    expect(pdfNoteSummary([{ key: "pdf_url" }], "  \n")).toContain("no text could be extracted");
    expect(pdfNoteSummary([{ key: "pdf_url" }], null)).toContain("no text could be extracted");
  });
});
