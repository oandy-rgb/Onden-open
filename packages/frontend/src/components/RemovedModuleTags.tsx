import { TagName } from "./FunctionChip";
import { useMemo, useState } from "react";
import { useAppSelector, useAllNodes } from "../lib/appStore";
import { useT, tn } from "../lib/i18n";
import { MODULES } from "../modules";
import { directTagUsage } from "../lib/nodeTags";
import { splitTagSections } from "../lib/tagTree";
import { useModuleFilter } from "../hooks/useModuleFilter";
import { useIsOwner } from "../lib/capabilities";
import { Button, Pressable } from "./ui";
import { Trash2 } from "lucide-react";
import { nodeActions } from "../lib/data";
import "./TagTidy.css";

// The tags a turned-off feature left behind (turning a feature off keeps its tags
// and notes), shown on that feature's own page (settings/ModuleSettingsPage) next
// to the switch that turns it on again, and in no tag list. A quiet line; absent
// when there are none. A tag no note uses can be deleted right
// there (a delete like any other: undo, and History brings it back).

const NO_TAGS: never[] = [];

/** `moduleId`: the turned-off feature whose page this is. `null`: the tags of features this
 *  version no longer has (nothing has a page to show them on, so the feature list ends with them). */
export default function RemovedModuleTags({ moduleId, openTag }: { moduleId: string | null; openTag?: (id: string) => void }) {
  const t = useT();
  const isOwner = useIsOwner();
  const isImported = useModuleFilter();
  const tags = useAppSelector((s) => s.data.tags ?? NO_TAGS);
  const nodes = useAllNodes();
  const [open, setOpen] = useState(false);
  const usage = useMemo(() => directTagUsage(nodes), [nodes]);
  const removed = useMemo(() => splitTagSections(tags, isImported).removed.filter((tag) => moduleId === null ? !MODULES.some((mod) => mod.id === tag.schema_module) : tag.schema_module === moduleId), [tags, isImported, moduleId]);
  if (!isOwner || removed.length === 0) return null;
  const moduleTitle = (id: string) => t(MODULES.find((mod) => mod.id === id)?.library.title ?? id);

  return (
    <section className="tag-tidy" aria-label={t("From modules that are off")}>
      <p className="tag-tidy-line">
        <span>
          {t(removed.length === 1 ? "1 tag from a module that is off" : "{n} tags from modules that are off", { n: removed.length })}
        </span>
        <Button variant="ghost" size="sm" className="tag-tidy-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {t(open ? "Hide the list" : "Show the list")}
        </Button>
      </p>
      {open && (
        <div className="tag-tidy-body">
          <p className="tag-tidy-hint">{t("Turning a module off keeps its tags and their notes. Open a tag to see its notes, or turn the module on again in Settings › Modules.")}</p>
          <ul className="tag-tidy-removed">{removed.map((tag) => {
            const count = usage.get(tag.id) ?? 0;
            return (
              <li key={tag.id} data-module={tag.schema_module ?? undefined}>
                {openTag
                  ? <Pressable type="button" className="tag-tidy-tag" aria-label={t("Open #{name}", { name: tag.name })}
                      onClick={() => openTag(tag.id)}><TagName tag={tag} /></Pressable>
                  : <span className="tag-tidy-tag"><TagName tag={tag} /></span>}
                <span className="tag-tidy-removed-meta">
                  {moduleId !== null && <>{t("Module: {module}", { module: moduleTitle(tag.schema_module ?? "") })}{" · "}</>}
                  {tn("1 directly tagged note", "{n} directly tagged notes", count)}
                </span>
                {count === 0 && (
                  <Button variant="ghost" size="sm" className="tag-tidy-delete"
                    aria-label={t("Delete #{name}", { name: tag.name })} onClick={() => void nodeActions.delete(tag.id, tag.name)}>
                    <Trash2 size={14} aria-hidden="true" /> {t("Delete")}
                  </Button>
                )}
              </li>
            );
          })}</ul>
        </div>
      )}
    </section>
  );
}
