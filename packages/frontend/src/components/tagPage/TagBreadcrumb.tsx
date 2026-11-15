import type { Tag } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { Pressable } from "../ui";

/** 全部標籤 › its parents › this tag, only for a tag that has parents (alone
 *  it would repeat the title). 全部標籤 opens the tag list (the phone's 標籤
 *  tab, the desktop sidebar's tags). `ancestors` is the parent chain, top first. */
export default function TagBreadcrumb({ tagName, ancestors, onOpenNode, onOpenTagsOverview }: {
  tagName: string; ancestors: Tag[]; onOpenNode?: (id: string) => void; onOpenTagsOverview?: () => void;
}) {
  const t = useT();
  if (ancestors.length === 0) return null;
  return (
    <nav className="tag-page-crumbs" aria-label={t("Breadcrumb")}>
      <Pressable type="button" onClick={() => onOpenTagsOverview?.()}>{t("All tags")}</Pressable>
      {ancestors.map((other) => (
        <span key={other.id}> › <Pressable type="button" onClick={() => onOpenNode?.(other.id)}>{other.name}</Pressable></span>
      ))}
      <span aria-current="page"> › {tagName}</span>
    </nav>
  );
}
