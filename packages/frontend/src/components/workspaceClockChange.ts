import { confirmDialog } from "./ConfirmDialog";
import { t } from "../lib/i18n";
import { changeWorkspaceClock, type ClockChange } from "../lib/workspaceClock";

/** changeWorkspaceClock asking through the app's dialog: Settings › Time and the travel question both use it. */
export function changeClockAsking(change: ClockChange, options: { now?: Date } = {}) {
  return changeWorkspaceClock(change, { ...options, confirm: (message) => confirmDialog(message, { confirmLabel: t("Change"), cancelLabel: t("Cancel") }) });
}
