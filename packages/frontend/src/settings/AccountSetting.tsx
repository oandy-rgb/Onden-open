import { LogOut } from "lucide-react";
import { useRef, useState } from "react";
import { useSyncTrouble } from "../components/SyncStatus";
import { useLocalOnlyStatus } from "../lib/localOnlyStatus";
import { Button } from "../components/ui";
import { useAccountSession } from "../lib/accountSession";
import { writeErrors } from "../lib/data";
import { useT } from "../lib/i18n";
import { signOutOfAccount } from "../lib/signOut";
import { useOnline } from "../lib/appStore";
import type { SettingContext } from "../lib/settingsTypes";

// Settings › Account: who is signed in, whether what they write is saved, and
// (below, from the registry) the server address and 「登出」. The status dot is
// the same one the settings list shows on its first row.

/** The person's name for display: their name, else their email, else null. */
export function useAccountName(): string | null {
  const user = useAccountSession()?.user;
  return user ? user.name || user.email : null;
}

/** "ok" while saving works, "trouble" for offline / waiting / refused. */
export function useAccountStatus(): { ok: boolean; label: string } {
  const t = useT();
  const online = useOnline();
  const trouble = useSyncTrouble();
  const localOnly = useLocalOnlyStatus();
  if (trouble) return { ok: false, label: trouble.label };
  if (localOnly) return { ok: true, label: localOnly.label };
  return { ok: online, label: online ? t("Synced") : t("Offline") };
}

/** A circle with the first letter of the name. */
export function Avatar({ name }: { name: string | null }) {
  return <span className="settings-avatar" aria-hidden="true">{(name ?? "?").trim().charAt(0).toUpperCase() || "?"}</span>;
}

export default function AccountSetting({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const session = useAccountSession();
  const status = useAccountStatus();
  const name = session?.user ? session.user.name || session.user.email : null;
  return (
    <>
      {session?.user && (
        <div className="settings-account-identity">
          <Avatar name={name} />
          <div className="settings-account-text">
            <strong>{name}</strong>
            {session.user.name && <span>{session.user.email}</span>}
          </div>
        </div>
      )}
      <div className="settings-row">
        <span className="settings-label">{t("Saving")}</span>
        <span className={`settings-status-dot ${status.ok ? "online" : "offline"}`} aria-hidden="true" />
        <span className="settings-value">{status.label}</span>
      </div>
      {/* Most often the device's network (or its VPN) dropped, not the address below. */}
      {!ctx.online && <p className="settings-hint">{t("This device can't reach the server. Check its network connection (a VPN, if you use one); what you write here syncs once it's back.")}</p>}
    </>
  );
}

export function SignOutSetting() {
  const t = useT();
  const session = useAccountSession();
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!session?.user) return null;
  async function signOut() {
    if (busy.current) return;
    busy.current = true; setWorking(true); setError(null);
    // Saves, signs out and reloads (lib/signOut.ts); a failure stays here.
    try { await signOutOfAccount(); }
    catch (cause) { setError(writeErrors.message(cause)); }
    finally { busy.current = false; setWorking(false); }
  }
  return (
    <>
      <Button variant="secondary" className="settings-sign-out" aria-disabled={working} onClick={() => void signOut()}>
        <LogOut size={16} aria-hidden="true" />{working ? t("Saving and signing out…") : t("Sign out")}
      </Button>
      {error && <p className="settings-hint settings-storage-error" role="alert">{error}</p>}
    </>
  );
}
