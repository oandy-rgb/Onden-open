import { Suspense, useEffect, useId, useRef, useState } from "react";
import { authClient } from "../lib/auth-client";
import { t, useT } from "../lib/i18n";
import { getApiBase } from "../lib/api";
import { onAppResume } from "../lib/appResume";
import { forgetVerifiedAccount, rememberVerifiedAccount, verifiedAccountFor } from "../lib/accountStorage";
import { lazyWithReload } from "../lib/lazyWithReload";
import { Pressable } from "./ui";
import AccountSessionBoundary from "./AccountSessionBoundary";
import { pendingInviteToken } from "../lib/invite";

// The sign-in form is only for someone who is not signed in: it loads on use,
// behind the same "Loading…" line the session check shows.
const LoginForm = lazyWithReload(() => import("./LoginForm"));
// Claiming an invite is only for someone who arrived with an invite link: everyone else goes straight to
// the workspace, so the claim screen loads only when a link is pending (decided once per mount, like the gate itself).
const InviteClaimGate = lazyWithReload(() => import("./InviteClaimGate"));
function InviteGate({ children }: { children: React.ReactNode }) {
  const [pending] = useState(() => pendingInviteToken() !== null);
  if (!pending) return <>{children}</>;
  return (
    <Suspense fallback={<div className="login-loading" role="status">{t("Accepting the invite…")}</div>}>
      <InviteClaimGate>{children}</InviteClaimGate>
    </Suspense>
  );
}

export default function LoginGate({ children }: { children: React.ReactNode }) {
  useT();
  const { data: session, isPending, error: sessionError, refetch } = authClient.useSession();
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const connectionTitleId = useId();

  const retryConnection = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryFailed(false);
    try {
      await refetch();
    } catch {
      // better-auth normally reports failures through useSession.error. Keep
      // unexpected transport rejections recoverable through the same surface.
      setRetryFailed(true);
    } finally {
      setRetrying(false);
    }
  };

  const signedOut = sessionError?.status === 401;
  const verifiedUserId = session && !signedOut ? session.user.id : null;
  useEffect(() => {
    if (verifiedUserId) rememberVerifiedAccount(verifiedUserId, getApiBase());
    else if (signedOut) forgetVerifiedAccount();
  }, [verifiedUserId, signedOut]);
  // GAP-20: when the sign-in check cannot reach the server (not a 401), open
  // the account this device last verified, from its local copy. Its requests
  // fail as offline until the connection returns; then the session is checked
  // again before anything is sent (and a different account is refused).
  // A recheck in flight (pending, no error yet) keeps an already-opened offline
  // workspace mounted; an initial check never shows local data early.
  const openedOffline = useRef<string | null>(null);
  const offlineUserId = session || signedOut ? null
    : sessionError ? verifiedAccountFor(getApiBase())
    : isPending ? openedOffline.current : null;
  useEffect(() => { openedOffline.current = offlineUserId; }, [offlineUserId]);
  useEffect(() => {
    if (!offlineUserId) return;
    const recheck = () => { void refetch(); };
    return onAppResume(recheck, ["online"]);
  }, [offlineUserId, refetch]);
  // better-auth retains the last verified session on transient failures. Keep
  // its mounted editor (including unsaved input).
  if (verifiedUserId) {
    return (
      <AccountSessionBoundary userId={verifiedUserId}>
        <InviteGate>{children}</InviteGate>
      </AccountSessionBoundary>
    );
  }
  if (offlineUserId && !retrying) return <AccountSessionBoundary userId={offlineUserId}>{children}</AccountSessionBoundary>;
  if (retrying || retryFailed || (sessionError && !signedOut)) {
    return (
      <div className="login-gate">
        <section className="login-card login-connection" aria-labelledby={connectionTitleId}>
          <div className="login-logo">Onden</div>
          <h1 className="login-connection-title" id={connectionTitleId}>
            {t("Unable to check your sign-in status")}
          </h1>
          <p className="login-connection-note">
            {t("This does not mean you have been signed out. Retry to continue.")}
          </p>
          <Pressable className="login-submit" type="button" aria-disabled={retrying}
            onClick={() => void retryConnection()}>
            {retrying ? t("Checking connection…") : t("Retry connection")}
          </Pressable>
        </section>
      </div>
    );
  }
  const loadingView = <div className="login-loading" role="status">{t("Loading…")}</div>;
  if (isPending) return loadingView;

  return (
    <Suspense fallback={loadingView}>
      <LoginForm refetch={refetch} />
    </Suspense>
  );
}
