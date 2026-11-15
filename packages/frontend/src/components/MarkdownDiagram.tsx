// A diagram laid out at publish time, drawn from the template in
// @onden/markdown (diagramSvg.ts). Every value reaches the DOM as a React
// attribute or text child; nothing is parsed as HTML.
import { createElement, type ReactNode } from "react";
import { diagramSvgTree, type DiagramLayout, type SvgNode } from "@onden/markdown";

const toReact = (node: SvgNode, key?: number): ReactNode =>
  createElement(node.tag, { ...node.attrs, key }, ...(node.text !== undefined ? [node.text] : (node.children ?? []).map(toReact)));

export default function MarkdownDiagram({ layout }: { layout: DiagramLayout }) {
  return <div className="md-mermaid">{toReact(diagramSvgTree(layout))}</div>;
}
