import { LogOut, Users } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useAccountSession } from "../lib/accountSession";
import { signOutOfAccount } from "../lib/signOut";
import { writeErrors } from "../lib/data";
import { useT } from "../lib/i18n";
import "./AccountPanel.css";
import { useIsOwner } from "../lib/capabilities";
import { hostCan } from "../lib/hostCapabilities";
import { Button, FieldError } from "./ui";

/** Shared account identity/actions inside a modal shell. The shell keeps the
 * editor inert and prevents closing/navigation while sign-out is pending.
 * `children` sit between the identity and the actions (the phone's sync
 * status and Settings). */
export default function AccountPanel({ onOpenMembers, onBusyChange, children }: {
  onOpenMembers?: () => void; onBusyChange: (busy: boolean) => void; children?: ReactNode;
}) {
  const t = useT();
  const session = useAccountSession();
  const isOwner = useIsOwner();
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    if (busy.current) return;
    busy.current = true; setWorking(true); onBusyChange(true); setError(null);
    // Saves, signs out and reloads (lib/signOut.ts); a failure stays here.
    try { await signOutOfAccount(); }
    catch (cause) { setError(writeErrors.message(cause)); }
    finally { busy.current = false; setWorking(false); onBusyChange(false); }
  }

  if (!session?.user) return null;
  return <section className="account-panel" aria-label={t("Account")}>
    <div className="account-identity">
      <strong>{session.user.name || session.user.email}</strong>
      <span>{session.user.email}</span>
    </div>
    {children}
    <div className="account-actions">
      {isOwner && onOpenMembers && <Button type="button" disabled={working} onClick={onOpenMembers}>
        <Users size={16} />{t("Spaces and members")}
      </Button>}
      {hostCan("accounts") && <Button type="button" onClick={() => void signOut()} aria-disabled={working}>
        <LogOut size={16} />{working ? t("Saving and signing out…") : t("Sign out")}
      </Button>}
    </div>
    {error && <FieldError>{error}</FieldError>}
  </section>;
}
