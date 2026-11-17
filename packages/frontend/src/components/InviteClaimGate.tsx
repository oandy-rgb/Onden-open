import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { forgetInviteToken, pendingInviteToken } from "../lib/invite";
import { FieldError, Pressable } from "./ui";

// After sign-in with an invite link pending (D110): claim it BEFORE the
// workspace mounts, so the first request the app makes already acts as the
// invited member (role + spaces) — an earlier request would have made the
// login an ordinary viewer. The workspace (and its bootstrap) loads only once
// the claim answered. A refused link says why and lets the person continue
// without it; nothing here decides access, the server does.
export default function InviteClaimGate({ children }: { children: React.ReactNode }) {
  const t = useT();
  const [token] = useState(pendingInviteToken);
  const [state, setState] = useState<{ phase: "claiming" } | { phase: "done" } | { phase: "refused"; message: string }>(
    () => (token ? { phase: "claiming" } : { phase: "done" }),
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    // lib/data is the whole data layer: loaded only when there is an invite
    // to claim, so the sign-in page and an ordinary sign-in never fetch it here.
    import("../lib/data")
      .then(({ workspaceAccessWriter, writeErrors }) => workspaceAccessWriter.claimInvite(token)
        .then(() => {
          forgetInviteToken();
          if (alive) setState({ phase: "done" });
        })
        .catch((e: unknown) => {
          if (alive) setState({ phase: "refused", message: writeErrors.message(e) });
        }))
      .catch(() => {
        if (alive) setState({ phase: "refused", message: "" });
      });
    return () => { alive = false; };
  }, [token, attempt]);

  if (state.phase === "done") return <>{children}</>;
  if (state.phase === "claiming") return <div className="login-loading" role="status">{t("Accepting the invite…")}</div>;
  return (
    <div className="login-gate">
      <section className="login-card login-connection" aria-labelledby="invite-claim-title">
        <div className="login-logo">Onden</div>
        <h1 className="login-connection-title" id="invite-claim-title">{t("The invite could not be used")}</h1>
        <FieldError>{state.message || t("Something went wrong")}</FieldError>
        <Pressable className="login-submit" type="button" onClick={() => { setState({ phase: "claiming" }); setAttempt((n) => n + 1); }}>
          {t("Try again")}
        </Pressable>
        <Pressable
          className="login-toggle" type="button"
          onClick={() => { forgetInviteToken(); setState({ phase: "done" }); }}
        >
          {t("Continue without the invite")}
        </Pressable>
      </section>
    </div>
  );
}
