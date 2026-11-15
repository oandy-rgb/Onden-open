import { useState } from "react";
import { signOutOfAccount } from "../lib/signOut";
import { writeErrors } from "../lib/data";
import { useT } from "../lib/i18n";
import { Button, layerClass } from "./ui";

// Shown instead of the workspace once the server says this account was removed
// (lib/accessRevoked.ts). The local copy is already wiped; the only way on is
// to sign out (and sign in as someone else, or be invited back).
export default function AccessRevokedNotice() {
  const t = useT();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function signOut() {
    setWorking(true); setError(null);
    // The same sign-out as the account menu, without waiting for saves: this
    // account's copy is gone and its writes are refused (lib/signOut.ts).
    try { await signOutOfAccount({ afterRevocation: true }); }
    catch (cause) { setError(writeErrors.message(cause)); setWorking(false); }
  }
  return <div className={`${layerClass.fixed} membership-gate access-revoked`}>
    <div className="membership-gate-card">
      <h1>{t("You no longer have access to this workspace")}</h1>
      <p>{t("The owner removed your account. This device's copy of the workspace has been deleted.")}</p>
      <Button type="button" onClick={() => void signOut()} disabled={working}>
        {working ? t("Signing out…") : t("Sign out")}
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  </div>;
}
