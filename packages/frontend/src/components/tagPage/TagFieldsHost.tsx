import { useFieldUsage } from "../../hooks/useFieldUsage";
import type { Tag } from "../../lib/api";
import { useTagRows } from "../../lib/appStore";
import "../functionCatalog";
import "./strings";
import "../TagsPanel.css";
import "./TagPage.css";
import FieldPopover from "./FieldPopover";
import { tagFieldModel } from "./fieldModel";
import { useSchemaDraft } from "./structure/useSchemaDraft";
import { tagTreeModel } from "./tagTreeModel";

/** The field settings popover for a tag's pages other than its own — the
 *  table view, whose column names open the same popover as the field chips
 *  (FieldPopover). The tag page mounts the popover itself; this is the same
 *  popover over its own copy of the tag's schema draft, so only one of the two
 *  is on screen. Renders nothing until a column name is pressed. */
export default function TagFieldsHost({ tagId, online, onSaved }: { tagId: string; online: boolean; onSaved?: () => void }) {
  const tags = useTagRows() ?? [];
  const tag = tags.find((candidate) => candidate.id === tagId);
  if (!tag) return null;
  return <Loaded key={tag.id} tag={tag} allTags={tags} online={online} onSaved={onSaved} />;
}

function Loaded({ tag, allTags, online, onSaved }: { tag: Tag; allTags: Tag[]; online: boolean; onSaved?: () => void }) {
  const draft = useSchemaDraft({ tag, online, onSaved, onLoadError: () => {} });
  const fieldModel = tagFieldModel(tag, draft.fields, tagTreeModel(tag, allTags), [], true);
  const fieldUsage = useFieldUsage(tag.id);
  return <FieldPopover tag={tag} draft={draft} fieldModel={fieldModel} fieldUsage={fieldUsage} canManage />;
}
