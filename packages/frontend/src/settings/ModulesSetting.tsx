import { Suspense } from "react";
import { lazyWithReload } from "../lib/lazyWithReload";
import { useT } from "../lib/i18n";
import RemovedModuleTags from "../components/RemovedModuleTags";
import type { SettingContext } from "../lib/settingsTypes";

// Settings › Features: the feature list (components/ModuleLibrary), which only
// decides what is on. Lazy, since the library pulls in every module's icon and
// settings. The tags a turned-off feature left are shown on that feature's own
// page (ModuleSettingsPage); only the tags of a feature this version no longer has end this list.
const ModuleLibrary = lazyWithReload(() => import("../components/ModuleLibrary"));

export default function ModulesSetting({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  return (
    <Suspense fallback={<p className="setting-note">{t("Loading…")}</p>}>
      <ModuleLibrary online={ctx.online} onChanged={ctx.onImportDone}
        onOpenPage={ctx.openTab} />
      {/* Only when there are tags of features this version no longer has. */}
      <RemovedModuleTags moduleId={null} openTag={ctx.openTag} />
    </Suspense>
  );
}
