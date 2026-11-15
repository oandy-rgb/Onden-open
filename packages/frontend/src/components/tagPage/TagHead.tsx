import type { ReactNode } from "react";
import { Pin, PinOff } from "lucide-react";
import type { Tag } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { tagDisplayName } from "../../lib/tagFunctions";
import { useSidebarTagPrefs } from "../../hooks/useSidebarTagPrefs";
import { Pressable } from "../ui";

/** The title row: path and name, the saving label (only while saving or
 *  when it failed), pin, and the ⋯ menu (`children`). Pin-to-topbar lives ON
 *  the tag page (TagsMode retirement). A tag's structure is its fields and
 *  views, each with its own entry below the title; no 「加功能」 here. */
export default function TagHead({ tag, parentPath, savingLabel, children }: {
  tag: Tag; parentPath: string; savingLabel: string;
  children?: ReactNode;
}) {
  const t = useT();
  const { isPinned, togglePin } = useSidebarTagPrefs();
  const pinned = isPinned(tag.id);
  return (
    <div className="schema-lens-head">
      <h1 className="schema-lens-title">{!tag.schema_module && <span className="schema-lens-hash">#</span>}{parentPath && <span className="schema-lens-parent-path">{parentPath}</span>}{tagDisplayName(tag)}</h1>
      {savingLabel && <span className="schema-lens-meta" role="status">{savingLabel}</span>}
      <div className="schema-lens-head-actions">
        <Pressable
          type="button"
          className={`schema-lens-icon-btn schema-lens-pin${pinned ? " active" : ""}`}
          aria-pressed={pinned}
          aria-label={t(pinned ? "Unpin tag" : "Pin tag")}
          title={t(pinned ? "Unpin tag" : "Pin tag")}
          onClick={() => togglePin(tag.id)}
        >
          {pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />}
        </Pressable>
        {children}
      </div>
    </div>
  );
}
