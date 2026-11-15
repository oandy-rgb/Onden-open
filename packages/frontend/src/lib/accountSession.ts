import { authClient } from "./auth-client";
import { boundAccountId } from "./accountStorage";

/** The session to SHOW in this page: only while it is the account the page is
 *  bound to (accountStorage). After another tab signs in as someone else, the
 *  cookie's user is not this page's — the page shows no account rather than
 *  the wrong one (AccountSessionBoundary asks for a reload). */
export function useAccountSession() {
  const { data } = authClient.useSession();
  const bound = boundAccountId();
  return data?.user && bound !== null && data.user.id === bound ? data : null;
}
