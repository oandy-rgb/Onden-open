import { useState } from "react";
import { setApiBase, pageOrigin } from "../lib/api";
import { t, useT } from "../lib/i18n";
import "./ServerSetup.css";
import { isEnterKey } from "../lib/keys";
import { Pressable, TextField } from "./ui";

type Props = { onConnect: () => void };

// Same-origin is the default: the page and its /api live behind one nginx
// (docker-compose). Only someone pointing the app at a SEPARATE backend host
// needs the URL field, so it hides behind an "Advanced" disclosure and no
// jargon greets the common user. The native app has no same-origin backend
// (its page is the WebView's own origin), so it asks for the URL directly.
const isNative = import.meta.env.VITE_NATIVE === "true";

function defaultOrigin(): string {
  return !isNative ? pageOrigin() : "";
}

export default function ServerSetup({ onConnect }: Props) {
  useT();
  const [advanced, setAdvanced] = useState(isNative);
  const [url, setUrl] = useState(defaultOrigin);
  const [status, setStatus] = useState<"idle" | "checking" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleConnect() {
    // No URL typed (common path) → same-origin: "" so api.ts hits /api on this
    // very host (no cross-origin, no CORS, no env baked at build time).
    if (advanced && !url.trim()) return;
    setStatus("checking");
    setErrorMsg("");
    // setApiBase checks the server first; a changed server reloads the page.
    const result = await setApiBase(advanced ? url : "");
    if (!result.ok) {
      setStatus("error");
      setErrorMsg(result.error);
    } else if (!result.changed) {
      onConnect();
    }
  }

  return (
    <main className="app-shell">
      <div className="app-boot-screen">
        <div className="app-boot-logo">Onden</div>
        <div className="server-setup-card">
          <h2 className="server-setup-title">{t("Welcome to Onden")}</h2>
          <p className="server-setup-desc">{t("Connect to start.")}</p>
          {advanced && (
            <TextField
              className="server-setup-input"
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setStatus("idle"); }}
              placeholder="https://your-server.com"
              onKeyDown={(e) => { if (isEnterKey(e)) void handleConnect(); }}
              autoFocus
            />
          )}
          {status === "error" && (
            <p className="server-setup-error">{errorMsg}</p>
          )}
          <Pressable
            className="server-setup-btn"
            onClick={() => void handleConnect()}
            disabled={status === "checking"}
          >
            {status === "checking" ? t("Connecting…") : t("Connect")}
          </Pressable>
          {!advanced && (
            <Pressable
              type="button"
              className="server-setup-advanced"
              onClick={() => { setAdvanced(true); setStatus("idle"); }}
            >
              {t("Advanced / connect to a different server")}
            </Pressable>
          )}
        </div>
      </div>
    </main>
  );
}
