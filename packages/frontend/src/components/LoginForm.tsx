import { useEffect, useId, useState } from "react";
import { authClient, fetchConfiguredProviders, type SocialProvider } from "../lib/auth-client";
import { t, useT } from "../lib/i18n";
import { pageOrigin } from "../lib/api";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../lib/passwordRules";
import { inviteRequestHeaders, pendingInviteToken } from "../lib/invite";
import { FieldError, Pressable, TextField } from "./ui";

// The sign-in / sign-up form. LoginGate loads it only when nobody is signed in
// (a signed-in session never needs it), so it is not in the boot JS.
const PROVIDER_LABELS: Record<SocialProvider, string> = {
  github: "GitHub",
  google: "Google",
};

function passwordTooShortMessage(): string {
  return t("Password must be at least {n} characters.", { n: PASSWORD_MIN_LENGTH });
}

function authFailureMessage(error: { code?: string; message?: string; status?: number }, fallback: string): string {
  if (error.code === "INVALID_ORIGIN") {
    return t("Sign-in is not enabled for {origin}. Use the server's configured address or ask its administrator to allow this address.", {
      origin: pageOrigin(),
    });
  }
  // An invite link that does not admit this sign-up (D110), told apart from
  // a plainly closed server.
  if (error.code === "INVITE_EXPIRED") return t("This invite link expired — ask the owner for a new one.");
  if (error.code === "INVITE_EMAIL_MISMATCH") return t("This invite is for a different email. Sign up with the email the owner invited.");
  if (error.code === "INVITE_INVALID") return t("This invite link is no longer valid — ask the owner for a new one.");
  if (error.code === "SIGNUP_CLOSED") {
    return t("Sign-up is closed on this server. Ask the owner to invite this email.");
  }
  if (error.code === "PASSWORD_TOO_SHORT") return passwordTooShortMessage();
  if (error.code === "PASSWORD_TOO_LONG") return t("Password is too long — at most {n} characters.", { n: PASSWORD_MAX_LENGTH });
  if (error.code === "USER_ALREADY_EXISTS" || error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
    return t("This email is already registered. Sign in instead.");
  }
  if (error.code === "INVALID_EMAIL_OR_PASSWORD") return t("Wrong email or password.");
  if (error.code === "INVALID_EMAIL") return t("That email address is not valid.");
  if (error.status === 429 || error.code === "TOO_MANY_REQUESTS") return t("Too many attempts. Try again later.");
  // Never the auth library's own text: it is English and meant for developers.
  return fallback;
}

export default function LoginForm({ refetch }: { refetch: () => Promise<unknown> | void }) {
  useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  // Arriving through an invite link (D110) opens the sign-up form.
  const [invited] = useState(() => pendingInviteToken() !== null);
  const [mode, setMode] = useState<"login" | "signup">(() => (invited ? "signup" : "login"));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [providers, setProviders] = useState<SocialProvider[]>([]);
  const [social, setSocial] = useState<SocialProvider | null>(null);
  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const passwordHintId = useId();
  // Ask the backend which OAuth providers it has configured. A self-host
  // without OAuth set up returns [] → no social buttons, plain form unchanged.
  useEffect(() => {
    let alive = true;
    void fetchConfiguredProviders().then((p) => { if (alive) setProviders(p); });
    return () => { alive = false; };
  }, []);

  const signInWith = async (provider: SocialProvider) => {
    setError(null);
    setSocial(provider);
    try {
      const res = await authClient.signIn.social({
        provider,
        callbackURL: pageOrigin() || "/",
      });
      // On success better-auth redirects the browser; if it returns an error
      // we surface it and re-enable the buttons.
      if (res?.error) {
        setError(authFailureMessage(res.error, t("Login failed")));
        setSocial(null);
      }
    } catch {
      setError(t("Something went wrong"));
      setSocial(null);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "signup" && password.length < PASSWORD_MIN_LENGTH) {
      setError(passwordTooShortMessage());
      return;
    }
    setLoading(true);
    try {
      // Confirm the new session before finishing the form, without relying
      // solely on the client's delayed sign-in notification.
      if (mode === "login") {
        const res = await authClient.signIn.email({ email, password });
        if (res.error) setError(authFailureMessage(res.error, t("Login failed")));
        else await refetch();
      } else {
        // A pending invite link rides along: a closed server admits only a
        // sign-up carrying a valid link for this email.
        const res = await authClient.signUp.email({ email, password, name }, { headers: inviteRequestHeaders() });
        if (res.error) setError(authFailureMessage(res.error, t("Signup failed")));
        else await refetch();
      }
    } catch {
      setError(t("Something went wrong"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-gate">
      <div className="login-card">
        <div className="login-logo">Onden</div>
        {invited && (
          <p className="login-invite-note" role="note">
            {t("You were invited. Create your account (or sign in) with the email the invite was sent to.")}
          </p>
        )}
        {providers.length > 0 && (
          <>
            <div className="login-social">
              {providers.map((provider) => (
                <Pressable
                  key={provider}
                  type="button"
                  className={`login-social-btn login-social-${provider}`}
                  onClick={() => void signInWith(provider)}
                  disabled={social !== null || loading}
                >
                  {social === provider
                    ? "…"
                    : t("Continue with {provider}").replace("{provider}", PROVIDER_LABELS[provider])}
                </Pressable>
              ))}
            </div>
            <div className="login-divider" role="separator" aria-label={t("or")}>
              <span>{t("or")}</span>
            </div>
          </>
        )}
        <form onSubmit={(e) => void submit(e)} className="login-form">
          {mode === "signup" && (
            <div className="login-field">
              <label className="login-label" htmlFor={nameId}>{t("Name")}</label>
              <TextField
                id={nameId}
                className="login-input"
                type="text"
                placeholder={t("Name")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
          )}
          <div className="login-field">
            <label className="login-label" htmlFor={emailId}>{t("Email")}</label>
            <TextField
              id={emailId}
              className="login-input"
              type="email"
              autoComplete="email"
              placeholder={t("Email")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="login-field">
            <label className="login-label" htmlFor={passwordId}>{t("Password")}</label>
            <TextField
              id={passwordId}
              className="login-input"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={t("Password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === "signup" ? PASSWORD_MIN_LENGTH : undefined}
              aria-describedby={mode === "signup" ? passwordHintId : undefined}
            />
            {mode === "signup" && (
              <p id={passwordHintId} className="login-hint">
                {t("At least {n} characters", { n: PASSWORD_MIN_LENGTH })}
              </p>
            )}
          </div>
          {error && <FieldError>{error}</FieldError>}
          <Pressable className="login-submit" type="submit" disabled={loading}>
            {loading ? "…" : mode === "login" ? t("Sign in") : t("Create account")}
          </Pressable>
        </form>
        <Pressable className="login-toggle" onClick={() => { setMode(m => m === "login" ? "signup" : "login"); setError(null); }}>
          {mode === "login" ? t("No account? Sign up") : t("Have an account? Sign in")}
        </Pressable>
      </div>
    </div>
  );
}
