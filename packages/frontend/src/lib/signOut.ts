// Signing out, one way for every surface (the account menu, the access-revoked
// screen): finish saving edits, end the session, forget the verified account
// (a later offline start must not reopen it), then reload — a new page
// lifetime, so nothing of this account's stores or writers outlives it
// (accountStorage binds a page to one account).

import { reloadPage } from "./api";
import { authClient } from "./auth-client";
import { forgetVerifiedAccount } from "./accountStorage";
import { WriteActionError, drafts } from "./data";
import { t } from "./i18n";
import { forgetPushDevice } from "./webPush";

/** The page reload, behind a seam tests can observe (jsdom can't stub location). */
export const pageLifecycle = { reload: () => reloadPage() };

export async function signOutOfAccount({ afterRevocation = false }: {
  /** The account was removed: its local copy is already wiped and the server
   *  refuses its writes, so there is nothing to save — waiting for a save
   *  would only keep the person from leaving. */
  afterRevocation?: boolean;
} = {}): Promise<void> {
  if (!afterRevocation && !await drafts.prepareExit()) {
    throw new WriteActionError(t("Sign-out paused. Finish saving your edits, then try again."));
  }
  // This device stops getting the account's lock-screen reminders (needs the session, so before it ends).
  await forgetPushDevice().catch(() => {});
  try {
    const result = await authClient.signOut();
    if (result.error) throw result.error;
  } catch (cause) {
    // Auth reports both resolved errors and rejected requests. A missing
    // response cannot prove whether the server already ended the session.
    throw new WriteActionError(t("Could not confirm sign-out. Keep this page open and try again."), { cause });
  }
  forgetVerifiedAccount();
  pageLifecycle.reload();
}
