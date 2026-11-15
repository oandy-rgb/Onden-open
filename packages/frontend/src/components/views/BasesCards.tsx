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

export function BasesCards({ rows, view, onSelectNode }: Props) {
  const t = useT();
  const order = view.order ?? ["file.name"];
  if (rows.length === 0) return <EmptyState size="inline" as="div" title={t("No matches")} />;
  return (
    <div className="bases-cards">
      {rows.map((n) => (
        <Pressable key={n.id} className="bases-card" onClick={() => onSelectNode?.(n.id)}>
          <div className="bases-card-title">{n.title}</div>
          <div className="bases-card-meta">
            {order
              .filter((k) => k !== "file.name" && k !== "title")
              .map((k) => {
                const v = n.frontmatter?.[k];
                if (v == null || v === "") return null;
                return <span key={k} className="bases-card-meta-pair"><em>{k}</em> {String(v)}</span>;
              })}
          </div>
        </Pressable>
      ))}
    </div>
  );
}
