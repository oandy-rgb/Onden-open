import { useMemo, useState } from "react";
import { useAppSelector, useAllNodes } from "../lib/appStore";
import { useT } from "../lib/i18n";
import { directTagUsage } from "../lib/nodeTags";
import { tagTidyReport, tagTreeRows } from "../lib/tagTree";
import { useIsOwner } from "../lib/capabilities";
import { Button, Pressable } from "./ui";
import "./TagTidy.css";

// The tag tidy line, at the bottom of the tag list (SidebarTagTree): a quiet
// count of what could be tidied — tags no note uses, pairs of similar names —
// and 檢視 lists them: each opens its tag. Nothing is deleted from here. The
// owner's; absent when there is nothing to tidy. (Functions nothing uses are
// the module library's 「開著，還沒用到」 group, not this line.)

const NO_TAGS: never[] = [];

export default function TagTidy({ openTag }: { openTag?: (id: string) => void }) {
  const t = useT();
  const isOwner = useIsOwner();
  const tags = useAppSelector((s) => s.data.tags ?? NO_TAGS);
  const nodes = useAllNodes();
  const [open, setOpen] = useState(false);
  const usage = useMemo(() => directTagUsage(nodes, tags), [nodes, tags]);
  const tidy = useMemo(() => tagTidyReport(tagTreeRows(tags), usage), [tags, usage]);
  const parts = [
    tidy.unused.length > 0 && t(tidy.unused.length === 1 ? "1 unused tag" : "{n} unused tags", { n: tidy.unused.length }),
    tidy.similar.length > 0 && t(tidy.similar.length === 1 ? "1 pair of similar names" : "{n} pairs of similar names", { n: tidy.similar.length }),
  ].filter(Boolean);
  if (!isOwner || parts.length === 0) return null;
  const tagButton = (id: string, name: string) => openTag
    ? <Pressable type="button" className="tag-tidy-tag" onClick={() => openTag(id)}>#{name}</Pressable>
    : <span className="tag-tidy-tag">#{name}</span>;

  return (
    <section className="tag-tidy" aria-label={t("Tidy up")}>
      <p className="tag-tidy-line">
        <span>{parts.join(" · ")}</span>
        <Button variant="ghost" size="sm" className="tag-tidy-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {t(open ? "Hide the list" : "Show the list")}
        </Button>
      </p>
      {open && (
        <div className="tag-tidy-body">
          <p className="tag-tidy-hint">{t("Nothing here is deleted for you. Open a tag to merge it into another or delete it.")}</p>
          {tidy.unused.length > 0 && (
            <div role="group" aria-label={t("Unused tags")}>
              <h4>{t("Unused tags")}</h4>
              <ul>{tidy.unused.map((tag) => <li key={tag.id}>{tagButton(tag.id, tag.name)}</li>)}</ul>
            </div>
          )}
          {tidy.similar.length > 0 && (
            <div role="group" aria-label={t("Similar names")}>
              <h4>{t("Similar names")}</h4>
              <ul>{tidy.similar.map(([a, b]) => (
                <li key={`${a.id}:${b.id}`}>{tagButton(a.id, a.name)}{t(", ")}{tagButton(b.id, b.name)}</li>
              ))}</ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
