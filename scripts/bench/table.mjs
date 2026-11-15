// Plain-text tables for the bench scripts.

/** @param {string[]} header @param {string[][]} rows @param {boolean[]} [rightAligned] */
export function renderTable(header, rows, rightAligned = []) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const cell = (text, i) => (rightAligned[i] ? text.padStart(widths[i]) : text.padEnd(widths[i]));
  const line = (cells) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(header), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...rows.map(line)].join("\n");
}

/** 1234.5 → "1234.5 ms"; bytes are shown as KB. */
export function formatValue(value, unit) {
  if (unit === "bytes") return `${(value / 1024).toFixed(1)} KB`;
  return `${value >= 100 ? Math.round(value) : value} ${unit}`;
}
