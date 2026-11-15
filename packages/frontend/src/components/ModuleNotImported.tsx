import { PackagePlus } from "lucide-react";
import { MODULES } from "../modules";
import { useT } from "../lib/i18n";
import EmptyState from "./EmptyState";
import "./ModuleLibrary.css";
import { useIsOwner } from "../lib/capabilities";
import { openSettings } from "../lib/settingsRequest";

/** A module screen reached by link or history while that module is off (or
 *  still waiting for the owner's one-time yes): points at the module library
 *  (Settings › Modules), the one place modules are turned on and off. */
export default function ModuleNotImported({ moduleId }: { moduleId: string }) {
  const t = useT();
  const isOwner = useIsOwner();
  const mod = MODULES.find((m) => m.id === moduleId);
  const name = mod ? t(mod.library.title) : moduleId;
  return (
    <div className="module-not-imported">
      <EmptyState
        size="page"
        variant="empty"
        icon={<PackagePlus size={28} aria-hidden="true" />}
        title={t("“{name}” is off", { name })}
        description={isOwner
          ? t("Turn it on in Settings › Modules to open it.")
          : t("“{name}” is off in this workspace. The workspace owner can turn it on in Settings › Modules.", { name })}
        ctaLabel={t("Open the module library")}
        onCta={() => openSettings("modules")}
      />
    </div>
  );
}
