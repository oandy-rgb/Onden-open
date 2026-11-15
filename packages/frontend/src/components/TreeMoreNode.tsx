import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useContext } from "react";
import { t } from "../lib/i18n";
import { GraphCallbacksContext } from "./graphCallbacks";
import "./TreeMoreNode.css";
import { Pressable } from "./ui";

/** 「+N 篇」: the sub-notes of a card that the tree does not draw yet. */
export function TreeMoreNode({ data }: NodeProps) {
  const { onShowMoreChildren } = useContext(GraphCallbacksContext);
  const remaining = data.remaining as number;
  return (
    <div className="tree-more-node">
      <Handle id="l" type="target" position={Position.Left} className="tree-more-handle" />
      <Pressable
        type="button"
        className="tree-more-button nodrag nopan"
        onClick={(e) => { e.stopPropagation(); onShowMoreChildren(data.parentId as string); }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {t("+{count} notes", { count: remaining })}
      </Pressable>
    </div>
  );
}
