import type { ContentNode, FieldDef } from "../lib/api";
import { useT } from "../lib/i18n";
import { useIsMobile } from "../hooks/useIsMobile";
import { dateLabel } from "../lib/timeLabels";
import { snippetPlainText } from "@onden/markdown";
import { displayTitle } from "../lib/noteLabel";
import "./MemberList.css";
import { Pressable } from "./ui";

// A set of notes as the 「全部」 tab lists it — a tag page's members, a note's
// sub-notes (docs/architecture/views-as-modules.md 「檢視的來源」). With fields
// they are compared field by field (a synthesis matrix for a
// research tag, a reading log for #book); without, a list of titles. Read from
// the local store, so it shows offline and without a saved view; saved views
// add filters, sorting and other layouts on top.
type Props = {
  nodes: ContentNode[];
  fields: FieldDef[];
  onOpenNode?: (id: string) => void;
  /** A note's sub-notes on its page: slim rows with no divider lines, the
   *  titles on the note title's own left edge. */
  flat?: boolean;
};

const fieldKey = (field: FieldDef) => field.name ?? field.key ?? "";

/** A field's value on a note, "" when it has none. */
const valueOf = (node: ContentNode, field: FieldDef) => node.attrs?.[fieldKey(field)] ?? "";

/** The first line of a note's body for its list row: no frontmatter or
 *  markup (snippetPlainText), no #tags, not repeating the title. "" when the
 *  body is empty or not loaded (a slim bootstrap row). */
function bodyExcerpt(node: ContentNode): string {
  const title = (node.title ?? "").trim();
  let text = snippetPlainText(node.markdown ?? "").replace(/(^|\s)#[^\s#]+/g, " ").replace(/\s+/g, " ").trim();
  if (title && text.startsWith(title)) text = text.slice(title.length).trim();
  return text;
}

export default function MemberList({ nodes, fields, onOpenNode, flat }: Props) {
  const t = useT();
  const phone = useIsMobile();
  // A column nobody listed has a value for says nothing: leave it out.
  const columns = fields.filter((field) => fieldKey(field) && field.type !== "media"
    && nodes.some((node) => String(valueOf(node, field)).trim() !== ""));
  if (columns.length === 0 || (phone && !flat)) {
    // The phone has no room for columns: each member is its title and, under
    // it, the values it has on one faint line (field names stay out of it).
    const showValues = phone && !flat && columns.length > 0;
    // Wide titles-only list: each row also says when it changed and how it begins.
    const rich = !phone && !flat;
    return (
      <ul className={flat ? "tag-member-list tag-member-list--flat" : rich ? "tag-member-list tag-member-list--rich" : "tag-member-list"}>
        {nodes.map((node) => {
          const date = !flat ? dateLabel(node.updated_at, "short") : "";
          const values = showValues ? [date, ...columns.map((field) => String(valueOf(node, field)).trim())].filter(Boolean) : [];
          const meta = rich ? [date, bodyExcerpt(node)].filter(Boolean).join(" · ") : "";
          return (
            <li key={node.id}>
              <Pressable type="button" onClick={() => onOpenNode?.(node.id)}>
                <span className="tag-member-title">{displayTitle(node.title)}</span>
                {(values.length > 0 || meta) && <span className="tag-member-values">{meta || values.join(" · ")}</span>}
              </Pressable>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className="tag-member-table-wrap">
      <table className="tag-member-table">
        <thead>
          <tr>
            <th scope="col">{t("Title")}</th>
            {columns.map((field) => <th key={fieldKey(field)} scope="col">{field.label || fieldKey(field)}</th>)}
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <tr key={node.id}>
              <th scope="row">
                <Pressable type="button" onClick={() => onOpenNode?.(node.id)}>{displayTitle(node.title)}</Pressable>
              </th>
              {columns.map((field) => {
                const value = valueOf(node, field);
                return <td key={fieldKey(field)} title={value}>{value}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
