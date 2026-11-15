import { Suspense, useState } from "react";
import { Settings2, X } from "lucide-react";
import type { Tag } from "../../lib/api";
import { useIsOwner } from "../../lib/capabilities";
import { useT } from "../../lib/i18n";
import { openSettings } from "../../lib/settingsRequest";
import { abilitySource } from "../../lib/tagModules";
import { Popover, Pressable, usePopover } from "../ui";
import type { FunctionModel } from "./functionModel";
import type { TagTreeModel } from "./tagTreeModel";

/** 「功能」: what notes with this tag get, as chips under the title — 「複習 ×」
 *  (the × takes it off, for the owner, when this tag itself has it). A function
 *  the tag has through its own module tag or a tag it inherits from has no ×;
 *  a function whose module is off shows dashed with 「還沒開」. A function's
 *  quick action (開始複習) opens or closes its panel; its settings are behind
 *  the gear. The row only shows what the tag already holds (nothing is added
 *  here since 2026-11-12); with none it is not drawn. Everyone sees the row;
 *  only the owner changes it. */
export default function FunctionsRow({ tag, online, canManage, fns, tree, openPanel, busy, onTogglePanel, onRemove, onTurnOn, onSaved }: {
  tag: Tag; online: boolean; canManage: boolean;
  fns: Pick<FunctionModel, "abilities" | "dormant" | "routeOf">;
  tree: Pick<TagTreeModel, "tagsWithSelf">;
  openPanel: string | null; busy: boolean;
  onTogglePanel: (id: string) => void;
  onRemove: (id: string) => void;
  onTurnOn: (id: string) => void;
  onSaved?: () => void;
}) {
  const t = useT();
  const isOwner = useIsOwner();
  const { abilities, dormant, routeOf } = fns;
  const removable = (id: string) => canManage && online && !busy && routeOf(id) === "direct";
  // A tag with no function shows no row: functions are no longer added from here.
  if (abilities.length === 0 && dormant.length === 0) return null;
  return (
    <div className="tag-page-row" role="group" aria-label={t("Functions")}>
      <span className="tag-page-row-label">{t("Functions")}</span>
      <div className="tag-page-items">
        {abilities.map((fn) => {
          const { id, title, description, Icon, panel } = fn;
          const source = fn.settings ? abilitySource(tree.tagsWithSelf, tag.id, id) : null;
          return (
            <span key={id} className="tag-fn-entry" data-function={id} title={t(description)}>
              <Icon size={13} aria-hidden="true" />{t(title)}
              {panel && (
                <Pressable type="button" className="tag-function-quick" disabled={!online} onClick={() => onTogglePanel(id)}>
                  {t(openPanel === id ? panel.closeLabel : panel.openLabel)}
                </Pressable>
              )}
              {fn.settings && source && <FunctionSettingsButton fn={fn} tag={tag} source={source} online={online} canManage={canManage} onSaved={onSaved} />}
              {removable(id) && (
                <Pressable type="button" className="tag-fn-entry-remove" aria-label={t("Remove “{function}” from #{tag}", { function: t(title), tag: tag.name })}
                  onClick={() => onRemove(id)}><X size={13} aria-hidden="true" /></Pressable>
              )}
            </span>
          );
        })}
        {dormant.map(({ id, title, Icon }) => (
          <span key={id} className="tag-fn-entry is-dormant" data-function={id}>
            <Icon size={13} aria-hidden="true" />{t(title)}<span className="tag-fn-entry-note">{t("Not on yet")}</span>
            {canManage && isOwner && (
              <Pressable type="button" className="tag-function-quick" disabled={!online || busy} onClick={() => onTurnOn(id)}>{t("Turn on")}</Pressable>
            )}
            {removable(id) && (
              <Pressable type="button" className="tag-fn-entry-remove" aria-label={t("Remove “{function}” from #{tag}", { function: t(title), tag: tag.name })}
                onClick={() => onRemove(id)}><X size={13} aria-hidden="true" /></Pressable>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The gear beside a function: its settings, which belong to the tag the function comes from. */
function FunctionSettingsButton({ fn, tag, source, online, canManage, onSaved }: {
  fn: FunctionModel["abilities"][number]; tag: Tag; source: Tag; online: boolean; canManage: boolean; onSaved?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const popover = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false), placement: "bottom-start" });
  const Settings = fn.settings!;
  // Settings on the module tag (#複習's daily cards) are the module's, shared by every tag that adds it: changed in Settings › Modules.
  const moduleSettings = source.schema_module === fn.id;
  return (
    <>
      <Pressable ref={popover.anchor} type="button" className="tag-fn-entry-remove" aria-haspopup="dialog" aria-expanded={open}
        aria-label={t("Settings of “{function}”", { function: t(fn.title) })} onClick={() => setOpen((o) => !o)}>
        <Settings2 size={13} aria-hidden="true" />
      </Pressable>
      {open && (
        <Popover popover={popover} label={t("Settings of “{function}”", { function: t(fn.title) })} className="tag-fn-settings">
          {moduleSettings ? (
            <Pressable type="button" className="schema-lens-action" onClick={() => { popover.close(); openSettings("modules"); }}>{t("Open Settings › Modules")}</Pressable>
          ) : (
            <Suspense fallback={<p>{t("Loading…")}</p>}>
              {source.id !== tag.id && <p className="tag-function-note">{t("These settings belong to #{name}; every tag that gets {function} from it shares them.", { name: source.name, function: t(fn.title) })}</p>}
              <Settings tag={source} online={online} canManage={canManage} onSaved={onSaved} />
            </Suspense>
          )}
        </Popover>
      )}
    </>
  );
}
