import type { ContentNode, Tag } from "../../lib/api";
import { useT } from "../../lib/i18n";
import MemberList from "../MemberList";
import type { FieldModel } from "./fieldModel";
import { useTagBlocks } from "./useTagBlocks";
import { Pressable } from "../ui";

/** The notes of the tag as a list (its saved views are tabs above the page), and after them the paragraphs that
 *  carry the tag themselves (`{…}` in a note's text): each its words and its note, opening that note.
 *  A view module's tag has no notes of its own: its page gathers the tags that use the view. */
export default function TagMembers({ tag, instances, childTags, extenderTags, fieldModel, onOpenNode }: {
  tag: Tag; instances: ContentNode[];
  /** The child tags and the tags extending this one, whose notes are included. */
  childTags: Tag[]; extenderTags: Tag[];
  fieldModel: Pick<FieldModel, "allFields">;
  onOpenNode?: (id: string) => void;
}) {
  const t = useT();
  const { allFields } = fieldModel;
  const blocks = useTagBlocks(tag.id);
  return (
    <section className="schema-lens-section tag-members-section">
      <h2 className="schema-lens-section-title">{t("Tagged notes")} <span className="tag-member-count">{instances.length}</span></h2>
      {childTags.length > 0 && (
        <p className="schema-lens-hint">{t("Includes notes of its child tags: {names}", {
          names: childTags.map((other) => `#${other.name}`).join(", "),
        })}</p>
      )}
      {extenderTags.length > 0 && (
        <p className="schema-lens-hint">{t(tag.schema_module ? "Includes notes of the tags that use this function: {names}" : "Includes notes of the tags with an old inheritance of it: {names}", {
          names: extenderTags.map((other) => `#${other.name}`).join(", "),
        })}</p>
      )}
      {/* A tag lists its members here; their table, calendar, board and cards are tabs above the page. */}
      {instances.length === 0 ? (blocks.total === 0 && <p className="schema-lens-hint">{t("No notes use this tag yet. Open a note and add it with \"+ Tag\" under the title.")}</p>)
        // A tag with fields compares its members side by side by default.
        : <MemberList nodes={instances} fields={allFields} onOpenNode={onOpenNode} />}
      {blocks.rows.length > 0 && (
        <>
          <h3 className="schema-lens-section-title tag-member-blocks-title">{t("Paragraphs")} <span className="tag-member-count">{blocks.total}</span></h3>
          <ul className="tag-member-list tag-member-list--rich tag-member-list--blocks">
            {blocks.rows.map((block) => (
              <li key={block.id}>
                <Pressable type="button" onClick={() => onOpenNode?.(block.note_id)}>
                  <span className="tag-member-title">{block.label}</span>
                  <span className="tag-member-values">{block.note_title}</span>
                </Pressable>
              </li>
            ))}
          </ul>
          {blocks.more && <Pressable type="button" className="tag-member-more" onClick={blocks.more}>{t("Show more")}</Pressable>}
        </>
      )}
    </section>
  );
}
