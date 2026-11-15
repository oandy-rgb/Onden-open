import type { ViewDef } from "@onden/markdown";
import type { EvalNode } from "../../lib/basesEval";
import { useT } from "../../lib/i18n";
import { Pressable } from "../ui";

type Props = {
  rows: EvalNode[];
  view: ViewDef;
  onSelectNode?: (id: string) => void;
};

export function BasesTable({ rows, view, onSelectNode }: Props) {
  const t = useT();
  const order = view.order && view.order.length > 0
    ? view.order
    : ["file.name"];

  return (
    <div className="bases-table-wrap">
      <table className="bases-table">
        <thead>
          <tr>
            {order.map((key) => <th key={key}>{key}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td className="bases-table-empty" colSpan={order.length}>{t("No matches")}</td></tr>
          )}
          {rows.map((n) => (
            <tr key={n.id}>
              {order.map((key) => (
                <td key={key}>
                  {key === "file.name" || key === "title"
                    ? <Pressable className="bases-table-title" onClick={() => onSelectNode?.(n.id)}>{n.title}</Pressable>
                    : String(n.frontmatter?.[key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
