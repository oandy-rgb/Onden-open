import type { ViewDef } from "@onden/markdown";
import type { EvalNode } from "../../lib/basesEval";
import { useT } from "../../lib/i18n";
import EmptyState from "../EmptyState";
import { Pressable } from "../ui";

type Props = {
  rows: EvalNode[];
  view: ViewDef;
  onSelectNode?: (id: string) => void;
};

export function BasesList({ rows, view, onSelectNode }: Props) {
  const t = useT();
  const order = view.order ?? ["file.name"];
  if (rows.length === 0) return <EmptyState size="inline" as="div" title={t("No matches")} />;
  return (
    <ul className="bases-list">
      {rows.map((n) => (
        <li key={n.id} className="bases-list-row">
          <Pressable className="bases-list-title" onClick={() => onSelectNode?.(n.id)}>{n.title}</Pressable>
          {order
            .filter((k) => k !== "file.name" && k !== "title")
            .map((k) => {
              const v = n.frontmatter?.[k];
              if (v == null || v === "") return null;
              return <span key={k} className="bases-list-badge"><em>{k}</em> {String(v)}</span>;
            })}
        </li>
      ))}
    </ul>
  );
}
