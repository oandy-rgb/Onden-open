import { Lock } from "lucide-react";
import { useT } from "../lib/i18n";

/** Marks a control only the workspace owner can change (the control itself is
 *  shown disabled): a lock, with its meaning for screen readers, no sentence. */
export default function OwnerLock() {
  const t = useT();
  return <Lock size={14} role="img" aria-label={t("Only the owner can change this")} className="settings-owner-lock" />;
}
