import { useId, useRef, useState } from "react";

import { addToast } from "../../lib/appStore";
import { aiRoleWriter, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { randomUUID } from "../../lib/uuid";
import { Button, Radio } from "../../components/ui";
import ApiSettingsFields, { EMPTY_API_SETTINGS, apiSettingsReady, type ApiSettings } from "./ApiSettingsFields";
import type { AiRoleInfo } from "./aiRoleInfo";
import { giveCode, setAiKey } from "./actions";
import NewConnectionFlow from "./NewConnectionFlow";
import type { AiPageData } from "./model";
import "./strings";

// 換連線: point an AI at another saved key (with its model and limit), at a connection code for your own AI, or at a
// connection that is made right now. Only the AI's connection changes: where it stands in each space, and each
// space's 「讓 AI 讀」 switch, are not touched.

export default function ChangeConnectionFlow({ role, data, online, aiOn, onDone, onFresh, onCancel }: {
  role: AiRoleInfo; data: AiPageData; online: boolean; aiOn: boolean;
  onDone: () => void; onCancel: () => void;
  onFresh: (code: { aiName: string; plaintext: string }) => void;
}) {
  const t = useT();
  const way = useId();
  const others = data.keys.filter((k) => k.id !== role.api?.credential_id);
  const [pick, setPick] = useState<"key" | "code" | "new">(others.length > 0 ? "key" : "new");
  const [settings, setSettings] = useState<ApiSettings>(EMPTY_API_SETTINGS);
  const [busy, setBusy] = useState(false);
  const codeKey = useRef(randomUUID());
  const hasCode = data.codes.some((c) => c.actorId === role.actor_id);

  if (pick === "new") {
    return (
      <div className="ai-flow">
        {others.length > 0 && <Button variant="ghost" size="sm" className="ai-touch" onClick={() => setPick("key")}>{t("Back")}</Button>}
        <NewConnectionFlow data={data} online={online} aiOn={aiOn} forRole={role} onDone={onDone} onFresh={onFresh} onCancel={onCancel} />
      </div>
    );
  }

  const ready = online && !busy && (pick === "code" || apiSettingsReady(settings));
  async function save() {
    if (!ready) return;
    setBusy(true);
    let done = false;
    if (pick === "key") done = await setAiKey(role.actor_id, settings.credentialId, settings);
    else if (hasCode) {
      try { await aiRoleWriter.useConnectionCode(role.actor_id); done = true; }
      catch (error) { writeErrors.report(error, addToast); }
    } else {
      const token = await giveCode(role.actor_id, role.name, role.default_runtime === "mcp", codeKey.current);
      done = token !== null;
      if (token) { codeKey.current = randomUUID(); onFresh({ aiName: role.name, plaintext: token }); }
    }
    setBusy(false);
    if (!done) return;
    addToast(t("{name} now runs on the new connection.", { name: role.name }), "success");
    onDone();
    onCancel();
  }

  return (
    <form className="ai-flow" aria-label={t("Change connection of {name}", { name: role.name })} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <fieldset className="ai-target">
        <legend>{t("Run {name} on…", { name: role.name })}</legend>
        <label className="ai-target-option">
          <Radio name={way} checked={pick === "key"} disabled={others.length === 0} onChange={() => setPick("key")} />
          <span>{t("Another saved API key")}</span>
        </label>
        <label className="ai-target-option">
          <Radio name={way} checked={pick === "code"} onChange={() => setPick("code")} />
          <span>{t("Your own AI, with a connection code")}</span>
        </label>
        {pick === "key" && <div className="member-key-form"><ApiSettingsFields value={settings} onChange={setSettings} keys={others.map((k) => ({ id: k.id, label: k.label, last4: k.last4, revoked_at: null }))} /></div>}
      </fieldset>
      <Button variant="secondary" className="ai-touch" onClick={() => setPick("new")}>{t("＋ New connection")}</Button>
      <div className="ai-flow-actions">
        <Button variant="ghost" className="ai-touch" disabled={busy} onClick={onCancel}>{t("Cancel")}</Button>
        <Button type="submit" variant="primary" className="ai-touch" disabled={!ready}>{busy ? t("Saving…") : t("Save")}</Button>
      </div>
    </form>
  );
}
