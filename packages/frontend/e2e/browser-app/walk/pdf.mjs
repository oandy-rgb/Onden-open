// A small text PDF made on the spot (no binary file in the repo): `pages` pages, each with one line of 36 pt text near the top.
export function makePdf(pages = 6) {
  const objs = []; const kids = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (let i = 0; i < pages; i++) {
    const pg = 4 + i * 2, ct = pg + 1; kids.push(`${pg} 0 R`);
    const text = `BT /F1 36 Tf 72 700 Td (Page ${i + 1} of the study notes) Tj ET`;
    objs[pg] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${ct} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objs[ct] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  let out = "%PDF-1.4\n"; const off = [];
  for (let i = 1; i < objs.length; i++) { off[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const x = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + off.slice(1).map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
