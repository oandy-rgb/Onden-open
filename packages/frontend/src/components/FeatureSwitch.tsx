import { useState } from "react";
import { useIsOwner } from "../lib/capabilities";
import { useT } from "../lib/i18n";
import { useModuleImport } from "../lib/moduleLibrary";
import { useModuleStatus } from "../hooks/useModuleFilter";
import { MODULES } from "../modules";
import { shownStatus, waitingFor } from "../lib/libraryLayout";
import OwnerLock from "./OwnerLock";
import { Button, Pressable, Switch } from "./ui";
import { useModuleImportConfirm } from "./ModuleImportConfirm";

// The feature on/off switch, shared by the feature list (ModuleLibrary) and a
// feature's own page (ModuleSettingsPage), so both turn a feature on and off
// the same way: only the owner decides, only online (the server takes the
// decision); turning on a feature that waits for the owner's one-time yes asks
// first; turning one off asks what it keeps.

export function useFeatureSwitch(online: boolean, onChanged?: () => void | Promise<void>) {
  const status = useModuleStatus();
  const isOwner = useIsOwner();
  const confirmer = useModuleImportConfirm();
  const { busy, setImported } = useModuleImport(online, onChanged);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  async function setOn(id: string, on: boolean) {
    if (await setImported(id, on)) setConfirmRemove(null);
  }
  async function flip(id: string, on: boolean) {
    if (!on) { setConfirmRemove(id); return; }
    if (status(id) === "ask") await confirmer.confirm(id, { run: () => setImported(id, true) });
    else await setOn(id, true);
  }
  return { online, status, isOwner, busy, confirmRemove, setConfirmRemove, setOn, flip, element: confirmer.element };
}
export type FeatureSwitchState = ReturnType<typeof useFeatureSwitch>;

/** The switch; anyone but the owner sees it disabled, with a lock. */
export function FeatureSwitch({ id, name, state }: { id: string; name: string; state: FeatureSwitchState }) {
  // A feature that needs another (skills need AI) cannot be switched while that one is off; the page says why (waitingFor).
  const mod = MODULES.find((m) => m.id === id);
  const waiting = mod !== undefined && waitingFor(mod, state.status) !== null;
  const shown = mod ? shownStatus(mod, state.status) : state.status(id);
  return (
    <>
      {!state.isOwner && <OwnerLock />}
      <Switch on={shown === "on"} label={name} disabled={!state.isOwner || !state.online || state.busy !== null || waiting}
        onChange={(next) => void state.flip(id, next)} />
    </>
  );
}

/** Under a feature turned off: what stays, and the button that does it. */
export function TurnOffConfirm({ id, name, state }: { id: string; name: string; state: FeatureSwitchState }) {
  const t = useT();
  if (!state.isOwner || state.confirmRemove !== id) return null;
  return (
    <div className="module-card-confirm" role="group" aria-label={t("Turn off “{name}”", { name })}>
      <span>{t("Hide “{name}” everywhere? Its data is kept and comes back when you turn it on again.", { name })}</span>
      <div className="module-card-actions">
        <Pressable type="button" className="module-card-remove" disabled={!state.online || state.busy !== null}
          onClick={() => void state.setOn(id, false)}>{t("Turn off")}</Pressable>
        <Button type="button" onClick={() => state.setConfirmRemove(null)}>{t("Cancel")}</Button>
      </div>
    </div>
  );
}
