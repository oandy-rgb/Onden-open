// The page the check runs mermaid and our extractor in: draws each sample with
// mermaid, reads its layout back with extractLayout, and draws that layout with
// the server's template beside it (so a person can compare the two).
import { diagramSvgTree, DIAGRAM_CSS, type SvgNode } from "@onden/markdown";
import { extractLayout } from "../../src/lib/diagramPrecompile";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const kebab = (k: string) => (k === "className" ? "class" : k === "viewBox" ? "viewBox" : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
const html = (n: SvgNode): string =>
  `<${n.tag}${Object.entries(n.attrs ?? {}).map(([k, v]) => ` ${kebab(k)}="${esc(String(v))}"`).join("")}>${n.text ? esc(n.text) : ""}${(n.children ?? []).map(html).join("")}</${n.tag}>`;

(window as unknown as { run: unknown }).run = async (mermaid: { initialize: (c: unknown) => void; render: (id: string, s: string, el: Element) => Promise<{ svg: string }> }, samples: string[]) => {
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default", htmlLabels: false, flowchart: { htmlLabels: false } });
  const style = document.createElement("style");
  style.textContent = `${DIAGRAM_CSS}body{font-family:sans-serif}.row{display:flex;gap:20px;border-bottom:1px solid #ccc;padding:8px}.row>div{flex:1}`;
  document.head.append(style);
  const results: Array<{ ok: boolean; nodes?: number; edges?: number; groups?: number }> = [];
  for (const [i, source] of samples.entries()) {
    const row = document.createElement("div"); row.className = "row"; document.body.append(row);
    const left = document.createElement("div"); const right = document.createElement("div"); row.append(left, right);
    left.innerHTML = (await mermaid.render(`m${i}`, source, left)).svg;
    const layout = extractLayout(left.querySelector("svg")!, source);
    if (layout) right.innerHTML = `<div class="md-mermaid">${html(diagramSvgTree(layout))}</div>`; else right.textContent = "FALLBACK (drawn by the reader's browser)";
    results.push(layout ? { ok: true, nodes: layout.nodes.length, edges: layout.edges.length, groups: layout.groups.length } : { ok: false });
  }
  return results;
};
