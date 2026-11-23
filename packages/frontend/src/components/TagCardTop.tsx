import { useMemo } from "react";
import type { Tag } from "../lib/api";
import { useTagRows, useAllNodes } from "../lib/appStore";
import { tagPath } from "../lib/data";
import { tn, useT } from "../lib/i18n";
import { abilitySource } from "../lib/tagModules";
import { tagMembers } from "../lib/nodeTags";
import { tagFields } from "../lib/tagFields";
import { enabledTagFunctions } from "../modules";
import { useModuleFilter } from "../hooks/useModuleFilter";
import { Pressable } from "./ui";
import "./NoteTagCards.css";

// The top of one tag's card, the same where the card is drawn (under the title
// when a chip is opened, and the info panel's 「標籤」 tab): the tag's name, how
// many notes carry it, the way to its page, and one small line of what the tag
// brings — its functions (with the ones it gets by extending another tag) and
// 「沒有欄位」 when it defines none.

const NO_TAGS: Tag[] = [];

export default function TagCardTop({ tag, onOpenTag }: { tag: Tag; onOpenTag: (tagId: string) => void }) {
  const t = useT();
  const isImported = useModuleFilter();
  const nodes = useAllNodes();
  const tags = useTagRows() ?? NO_TAGS;
  const count = useMemo(() => tagMembers(tags, nodes, tag.id).length, [tags, nodes, tag.id]);
  const functions = enabledTagFunctions(tag, isImported);
  const noFields = tagFields(tag).length === 0;
  return (
    <header className="tag-card-top">
      <div className="tag-card-top-line">
        <Pressable type="button" className="tag-card-name tap-target" onClick={() => onOpenTag(tag.id)} title={t("Open tag settings")}>
          #{tagPath(tags, tag.id) || tag.name}
        </Pressable>
        <span className="tag-card-count">{tn("{n} note", "{n} notes", count)}</span>
        <Pressable type="button" className="tag-card-page tap-target" onClick={() => onOpenTag(tag.id)}>{t("Tag page →")}</Pressable>
      </div>
      <p className="tag-card-brings">
        {functions.length === 0 && noFields
          ? t("Only sorts notes: no extra features or fields")
          : t("Notes with this tag get: {list}", { list: [...functions.map(({ id, title }) => {
            // A function got through another tag it extends says where it comes from.
            const source = abilitySource(tags, tag.id, id);
            const via = source && source.id !== tag.id && source.schema_module !== id ? source : null;
            return via ? `${t(title)} (${t("through #{name}", { name: via.name })})` : t(title);
          }), ...(noFields || functions.length > 0 ? [] : [t("their own fields")])].join(" · ") })}
      </p>
    </header>
  );
}
