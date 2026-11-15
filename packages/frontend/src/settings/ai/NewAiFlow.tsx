import { useId, useRef, useState } from "react";

import { addToast } from "../../lib/appStore";
import { useT } from "../../lib/i18n";
import { randomUUID } from "../../lib/uuid";
import { Button, Radio, TextField } from "../../components/ui";
import ApiSettingsFields, { EMPTY_API_SETTINGS, apiSettingsReady, type ApiSettings } from "./ApiSettingsFields";
import { apiConnection, ensureAiModuleOn, createAiWithConnection } from "./actions";
import type { AiPageData } from "./model";
import { AI_NAME_MAX } from "./model";
import "./strings";

// ＋ 新增 AI: a name and the connection it runs on (a key that is kept, or a connection code for your own AI).
// The AI starts suggest-only and stands (可編輯) only in spaces that already let AI read; this never opens a space.
// A connection that is not there yet is made with 「＋ 新增連線」, which can give it to a new AI as well.

export default function NewAiFlow({ data, online, aiOn, onDone, onFresh, onCancel }: {
  data: AiPageData; online: boolean; aiOn: boolean;
  onDone: () => void; onCancel: () => void;
  onFresh: (code: { aiName: string; plaintext: string }) => void;
}) {
  const t = useT();
  const ids = { name: useId(), way: useId() };
  const [name, setName] = useState("");
  const [way, setWay] = useState<"key" | "code">(data.keys.length > 0 ? "key" : "code");
  const [settings, setSettings] = useState<ApiSettings>(EMPTY_API_SETTINGS);
  const [busy, setBusy] = useState(false);
  const attempt = useRef(randomUUID());
  const ready = online && !busy && !!name.trim() && (way === "code" || apiSettingsReady(settings));

  async function save() {
    if (!ready) return;
    setBusy(true);
    await ensureAiModuleOn(aiOn, online);
    const made = await createAiWithConnection({ name: name.trim(), connection: way === "key" ? apiConnection(settings.credentialId, settings) : { kind: "mcp" } }, attempt.current);
    setBusy(false);
    if (!made) return;
    attempt.current = randomUUID();
    if (made.token) onFresh({ aiName: name.trim(), plaintext: made.token });
    else if (way === "code") addToast(t("The connection code was already made, but its reply was lost, so it can't be shown again. Revoke it and make a new one."), "error");
    addToast(t("{name} was added.", { name: name.trim() }), "success");
    onDone();
    onCancel();
  }

  return (
    <form className="ai-flow" aria-label={t("New AI")} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label htmlFor={ids.name}>{t("What should this AI be called?")}</label>
      <TextField id={ids.name} value={name} maxLength={AI_NAME_MAX} autoFocus placeholder="@ai" onChange={(e) => setName(e.target.value)} />
      <fieldset className="ai-target">
        <legend>{t("What does it run on?")}</legend>
        <label className="ai-target-option">
          <Radio name={ids.way} checked={way === "key"} disabled={data.keys.length === 0} onChange={() => setWay("key")} />
          <span>{t("A saved API key")}</span>
        </label>
        {data.keys.length === 0 && <p className="member-hint">{t("You have no saved key yet. Use “New connection” to add one.")}</p>}
        <label className="ai-target-option">
          <Radio name={ids.way} checked={way === "code"} onChange={() => setWay("code")} />
          <span>{t("Your own AI, with a connection code")}</span>
        </label>
        {way === "key" && <div className="member-key-form"><ApiSettingsFields value={settings} onChange={setSettings} keys={data.keys.map((k) => ({ id: k.id, label: k.label, last4: k.last4, revoked_at: null }))} /></div>}
      </fieldset>
      <div className="ai-flow-actions">
        <Button variant="ghost" className="ai-touch" disabled={busy} onClick={onCancel}>{t("Cancel")}</Button>
        <Button type="submit" variant="primary" className="ai-touch" disabled={!ready}>{busy ? t("Saving…") : t("Add AI")}</Button>
      </div>
    </form>
  );
}
