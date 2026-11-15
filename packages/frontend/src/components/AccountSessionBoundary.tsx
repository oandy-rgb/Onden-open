import { useEffect, useState, type ReactNode } from "react";
import { bindAccountStorage, boundAccountId, matchesAccountStorageServer } from "../lib/accountStorage";
import { getApiBase, reloadPage } from "../lib/api";
import { t } from "../lib/i18n";
import { Pressable } from "./ui";

/** Establish request ownership before children can start reads or writes.
 * A different account must not inherit this page's writers or module stores. */
export default function AccountSessionBoundary({ userId, children }: { userId: string; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(bindAccountStorage(userId, getApiBase())); }, [userId]);
  const previous = boundAccountId();
  if (previous && (previous !== userId || !matchesAccountStorageServer(getApiBase()))) {
    return (
      <div className="login-gate">
        <section className="login-card login-connection" aria-label={t("Your account has changed")}>
          <div className="login-logo">Onden</div>
          <h1 className="login-connection-title">{t("Your account has changed")}</h1>
          <p className="login-connection-note">{t("Reload to continue with the account you just signed in to.")}</p>
          <Pressable className="login-submit" type="button" onClick={() => reloadPage()}>
            {t("Reload page")}
          </Pressable>
        </section>
      </div>
    );
  }
  if (!ready || previous !== userId) return <div className="login-loading" role="status">{t("Loading…")}</div>;
  return <>{children}</>;
}
