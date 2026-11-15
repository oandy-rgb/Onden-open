import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { withPrintStyle } from "../lib/noteExportPrint";

describe("print export style", () => {
  it("is added to the print window's HTML, last in <head>", () => {
    const out = withPrintStyle("<!doctype html><html><head><style>a{}</style></head><body>x</body></html>");
    expect(out.indexOf("a{}")).toBeLessThan(out.indexOf('id="print-export"'));
    expect(out.indexOf('id="print-export"')).toBeLessThan(out.indexOf("</head>"));
  });

  it("holds the rules the layout depends on", () => {
    const css = withPrintStyle("<head></head>");
    for (const rule of ["size: A4", "@bottom-center", "break-after: avoid", "break-inside: avoid", "table-header-group", "print-color-adjust: exact", "max-width: 100%", "text-decoration: underline"]) {
      expect(css).toContain(rule);
    }
  });

  it("is not part of the downloaded HTML path", () => {
    expect(readFileSync("src/lib/noteExport.ts", "utf8")).not.toContain("print-export");
  });
});

describe("Word export loads on demand", () => {
  it("no boot-time module imports docx statically", () => {
    for (const file of ["src/hooks/useNoteExport.ts", "src/lib/noteExport.ts", "src/components/NoteActions.tsx"]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/from\s+["']docx["']|from\s+["'].*noteExportDocx["']/);
    }
    expect(readFileSync("src/hooks/useNoteExport.ts", "utf8")).toContain('import("../lib/noteExportDocx")');
    expect(readFileSync("src/lib/noteExportDocx.ts", "utf8")).not.toMatch(/^import\s+(?!type)[^;]*from\s+["']docx["']/m);
  });
});
