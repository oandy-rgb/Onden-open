import type { LucideIcon } from "lucide-react";
import { Suspense } from "react";
import { useTagRows } from "../lib/appStore";
import { useT } from "../lib/i18n";
import { MODULES, MODULE_SETTINGS, TAG_FUNCTIONS, inModuleLibrary, moduleEntry } from "../modules";
import { useModuleFilter } from "../hooks/useModuleFilter";
import { moduleTagOf } from "../lib/tagModules";
import { useIsOwner } from "../lib/capabilities";
import { requestOpenFeature } from "../lib/featureRequest";
import { waitingFor, waitingText } from "../lib/libraryLayout";
import RemovedModuleTags from "../components/RemovedModuleTags";
import { SettingRow } from "./SettingRenderer";
import type { SettingContext } from "../lib/settingsTypes";
import { NavPinSwitch } from "./NavigationSetting";
import { Button } from "../components/ui";
import { FeatureSwitch, TurnOffConfirm, useFeatureSwitch } from "../components/FeatureSwitch";
import "../components/ModuleLibrary.css";

// One feature's own page, Settings › Features › <feature>: its icon, name and
// master switch; a small picture of it when it can be drawn; 「在導覽列」; then
// every setting that feature has (they are here and nowhere else), and last
// 「打開」. Reached from the feature list's row. For a tag function, the
// settings its module tag holds for every tag that uses it are here too.

/** The tag holding a function module's shared settings, if it has both. */
function useFunctionSettings(id: string) {
  const tags = useTagRows() ?? [];
  const fn = TAG_FUNCTIONS.find((f) => f.id === id);
  const mod = MODULES.find((m) => m.id === id);
  const tag = mod?.library.moduleTag ? moduleTagOf(tags, id) : null;
  return fn?.settings && tag ? { Settings: fn.settings, tag } : null;
}

/** Whether feature `id` has settings of its own to show. */
export function useModuleHasSettings(): (id: string) => boolean {
  const tags = useTagRows() ?? [];
  return (id: string) => {
    if (MODULE_SETTINGS.some((def) => def.moduleId === id)) return true;
    const fn = TAG_FUNCTIONS.find((f) => f.id === id);
    const mod = MODULES.find((m) => m.id === id);
    return !!(fn?.settings && mod?.library.moduleTag && moduleTagOf(tags, id));
  };
}

/** A feature as the settings name it: its page's title and icon. */
export type FeaturePage = { id: string; title: string; Icon: LucideIcon };

/** The name of feature `id` (an i18n key), whether it is on or off. */
export function featureTitleOf(id: string): string {
  return MODULES.find((m) => m.id === id)?.library.title ?? id;
}

/** The features that are on and have settings of their own, in list order: the
 *  pages settings search looks into. */
export function useSettingsModules(): FeaturePage[] {
  const isImported = useModuleFilter();
  const hasSettings = useModuleHasSettings();
  return MODULES.filter((m) => inModuleLibrary(m) && isImported(m.id))
    .map((m) => ({ id: m.id, title: m.library.title, Icon: m.library.Icon }))
    .filter((page) => hasSettings(page.id));
}

/** A feature's settings rows (its page). */
export function ModuleSettingsBody({ id, ctx }: { id: string; ctx: SettingContext }) {
  const t = useT();
  const isOwner = useIsOwner();
  const fnSettings = useFunctionSettings(id);
  const rows = MODULE_SETTINGS.filter((def) => def.moduleId === id);
  return (
    <>
      {rows.map((def) => <SettingRow key={def.id} def={def} ctx={ctx} titled />)}
      {fnSettings && (
        <Suspense fallback={<p className="module-card-hint">{t("Loading…")}</p>}>
          <fnSettings.Settings tag={fnSettings.tag} online={ctx.online} canManage={isOwner} onSaved={() => ctx.onImportDone()} />
        </Suspense>
      )}
    </>
  );
}

export default function ModuleSettingsPage({ id, ctx }: { id: string; ctx: SettingContext }) {
  const t = useT();
  const isImported = useModuleFilter();
  const state = useFeatureSwitch(ctx.online, ctx.onImportDone);
  const mod = MODULES.find((m) => m.id === id);
  if (!mod) return null;
  const waiting = waitingFor(mod, state.status);
  const Icon = mod.library.Icon;
  const name = t(mod.library.title);
  const on = isImported(id);
  const { SettingsPreview } = mod;
  return (
    <section className="settings-section settings-module-page" data-module={id}>
      <div className="module-page-head">
        <Icon size={32} aria-hidden="true" className="module-page-icon" />
        <h4 className="settings-module-title">{name}</h4>
        <FeatureSwitch id={id} name={name} state={state} />
      </div>
      {waiting && <p className="module-card-hint">{waitingText(waiting, t)}</p>}
      <TurnOffConfirm id={id} name={name} state={state} />
      {/* The tags it left behind show only here, on the page of the feature that is off. */}
      {!on && <RemovedModuleTags moduleId={id} openTag={ctx.openTag} />}
      {on && (
        <>
          {SettingsPreview && <Suspense fallback={null}><SettingsPreview /></Suspense>}
          <NavPinSwitch moduleId={id} />
          <ModuleSettingsBody id={id} ctx={ctx} />
          {moduleEntry(id) !== null && (
            <Button type="button" variant="primary"
              onClick={() => { ctx.onClose(); requestOpenFeature(id); }}>
              {t("Open {name}", { name })}
            </Button>
          )}
        </>
      )}
      {state.element}
    </section>
  );
}
