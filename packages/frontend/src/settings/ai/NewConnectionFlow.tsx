import { useId, useRef, useState } from "react";

import { addToast } from "../../lib/appStore";
import { useT } from "../../lib/i18n";
import { randomUUID } from "../../lib/uuid";
import { Button, Pressable, Radio, Select, TextField } from "../../components/ui";
import { ModelAndCapFields, EMPTY_API_SETTINGS, apiSettingsReady, type ApiSettings } from "./ApiSettingsFields";
import type { AiRoleInfo } from "./aiRoleInfo";
import { apiConnection, capOf, createAiWithConnection, ensureAiModuleOn, findSavedKey, giveCode, saveKey, setAiKey } from "./actions";
import ApiConnectionForm, {
  connectionFields, connectionLabel, connectionPrices, EMPTY_CONNECTION, type ConnectionDraft, type TestedConnection,
} from "./ApiConnectionForm";
import type { AiPageData } from "./model";
import { AI_NAME_MAX } from "./model";
import "./strings";

// 新增連線, one flow for every place a connection is made: first use, the 「＋ 新增連線」 button, and 「換連線」
// (an AI is given, `forRole`). It asks: the kind (an API key, or a connection code for your own AI) → for a key its
// address and key and 「測試」 (only a passed test may be saved) → who uses it: an AI that exists, a new AI, or nobody
// yet (a key only) → for an AI on a key, its model (from the list that key reports) and monthly limit.
// Nothing here opens a space's 「AI 可以讀」 switch: a new AI stands only where AI reading is already on (the server decides).

type Kind = "key" | "code";
type Target = "existing" | "new" | "none";

export default function NewConnectionFlow({ data, online, aiOn, forRole, firstUse = false, initialKind, onDone, onFresh, onCancel }: {
  data: AiPageData; online: boolean; aiOn: boolean;
  /** The AI that is being given this connection (「換連線」). */
  forRole?: AiRoleInfo;
  /** Nothing exists yet: the AI that is made is called “AI” and answers to @ai. */
  firstUse?: boolean;
  initialKind?: Kind;
  onDone: () => void; onCancel: () => void;
  /** A connection code was made: the page shows it once (it must outlive this flow, which closes). */
  onFresh: (code: { aiName: string; plaintext: string }) => void;
}) {
  const t = useT();
  const ids = { target: useId(), existing: useId(), name: useId(), codeName: useId() };
  const [kind, setKind] = useState<Kind | null>(initialKind ?? null);
  const [draft, setDraft] = useState<ConnectionDraft>(EMPTY_CONNECTION);
  const [tested, setTested] = useState<TestedConnection | null>(null);
  const [target, setTarget] = useState<Target>(forRole ? "existing" : firstUse || data.roles.length === 0 ? "new" : "existing");
  const [existingId, setExistingId] = useState(forRole?.actor_id ?? data.roles[0]?.actor_id ?? "");
  const [newName, setNewName] = useState(firstUse ? "AI" : "");
  const [codeName, setCodeName] = useState("");
  const [settings, setSettings] = useState<ApiSettings>(EMPTY_API_SETTINGS);
  const [busy, setBusy] = useState(false);
  // Each write has its own key, kept until THAT write succeeds: a retry after a lost reply reuses it (the server then
  // answers `deduped`, handled in actions.ts), and a different write never shares it.
  const writeKeys = useRef({ key: randomUUID(), role: randomUUID(), code: randomUUID() });
  // The key this form already saved, so a second try never saves it twice.
  const savedKeyId = useRef<string | null>(null);

  const roleTarget = forRole ?? data.roles.find((r) => r.actor_id === existingId);
  const usesApi = kind === "key" && target !== "none";
  const nameReady = target !== "new" || !!newName.trim();
  const existingReady = target !== "existing" || !!roleTarget;
  // The key is not kept yet, so it has no id: only the model and the limit are asked here.
  const apiReady = !usesApi || apiSettingsReady({ ...settings, credentialId: "to-be-saved" });
  const keyStepDone = kind === "key" ? tested !== null : true;
  const canSave = online && !busy && kind !== null && keyStepDone && nameReady && existingReady && apiReady
    && (kind !== "key" || connectionPrices(draft) !== null) && (kind !== "code" || target !== "none");
  const targetOptions = firstUse ? (["new"] as Target[]) : forRole ? (["existing"] as Target[]) : (["existing", "new", "none"] as Target[]).filter((o) => o !== "none" || kind === "key");

  async function save() {
    if (!canSave) return;
    setBusy(true);
    // Saying yes here is the owner's one-time yes to AI: the server refuses AI writes until the feature is on.
    await ensureAiModuleOn(aiOn, online);
    let done = false;
    let keepOpen = false;
    if (kind === "key") {
      const fields = connectionFields(draft, tested!);
      // The key is kept once: after it is saved, every later try (another AI, a retry) uses THAT key and never saves a second.
      const keep = async (): Promise<string | null> => {
        if (savedKeyId.current) return savedKeyId.current;
        const saved = await saveKey(fields, writeKeys.current.key);
        if (!saved) return null;
        writeKeys.current.key = randomUUID();
        const id = saved.id ?? await findSavedKey(fields.label as string);
        if (!id) { addToast(t("The key was saved, but it could not be found again. Close this and look in the list."), "error"); return null; }
        savedKeyId.current = id;
        return id;
      };
      if (target === "none") done = (await keep()) !== null;
      else if (target === "new") {
        const id = savedKeyId.current;
        const connection = id ? apiConnection(id, settings) : { kind: "api_new" as const, ...fields, model: settings.model, cap: capOf(settings) };
        const made = await createAiWithConnection({ name: newName.trim(), connection }, writeKeys.current.role);
        if (made) { writeKeys.current.role = randomUUID(); done = true; }
      } else {
        const id = await keep();
        if (id) {
          done = await setAiKey(roleTarget!.actor_id, id, settings);
          if (!done) { keepOpen = true; addToast(t("The key was saved, but {name} could not be switched to it. Try again, or choose it from “Change connection”.", { name: roleTarget!.name }), "error"); }
        }
      }
    } else if (target === "new") {
      const made = await createAiWithConnection({ name: newName.trim(), connection: { kind: "mcp", key_name: codeName.trim() || undefined } }, writeKeys.current.role);
      if (made) {
        writeKeys.current.role = randomUUID();
        done = true;
        if (made.token) onFresh({ aiName: newName.trim(), plaintext: made.token });
        else addToast(t("The connection code was already made, but its reply was lost, so it can't be shown again. Revoke it and make a new one."), "error");
      }
    } else {
      const token = await giveCode(roleTarget!.actor_id, codeName.trim() || roleTarget!.name, roleTarget!.default_runtime === "mcp", writeKeys.current.code);
      if (token !== null) { writeKeys.current.code = randomUUID(); done = true; onFresh({ aiName: roleTarget!.name, plaintext: token }); }
    }
    setBusy(false);
    if (!done) { if (keepOpen) onDone(); return; }
    addToast(kind === "code" ? t("The connection code was made.") : t("The connection was saved."), "success");
    onDone();
    onCancel();
  }

  return (
    <form className="ai-flow" aria-label={t("New connection")} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {kind === null ? (
        <div className="ai-kinds" role="group" aria-label={t("Kind of connection")}>
          <Pressable className="ai-kind" onClick={() => { setKind("key"); }}>
            <strong>{t("With an API key")}</strong>
            <small>{t("Onden asks your AI service itself. The AI can only suggest changes; you accept each one.")}</small>
          </Pressable>
          <Pressable className="ai-kind" onClick={() => { setKind("code"); if (!forRole) setTarget(data.roles.length === 0 ? "new" : "existing"); }}>
            <strong>{t("Let your own AI connect in")}</strong>
            <small>{t("You get a connection code to put into your own AI app.")}</small>
          </Pressable>
        </div>
      ) : (
        <>
          {kind === "key" && (
            <ApiConnectionForm draft={draft} onChange={setDraft} tested={tested} onTested={(r) => { setTested(r); savedKeyId.current = null; setSettings((s) => ({ ...s, model: "" })); }} online={online} busy={busy} />
          )}
          {kind === "code" && (
            <div className="member-key-form">
              <label htmlFor={ids.codeName}>{t("Name for this connection code (optional)")}</label>
              <TextField id={ids.codeName} value={codeName} maxLength={AI_NAME_MAX} onChange={(e) => setCodeName(e.target.value)} />
            </div>
          )}

          {keyStepDone && (
            <fieldset className="ai-target">
              <legend>{t("Who uses it?")}</legend>
              {targetOptions.length > 1 ? targetOptions.map((option) => (
                <label key={option} className="ai-target-option">
                  <Radio name={ids.target} checked={target === option} onChange={() => setTarget(option)} />
                  <span>{option === "existing" ? t("An AI you already have") : option === "new" ? t("A new AI") : t("Nobody yet. Only keep the key.")}</span>
                </label>
              )) : <p className="member-hint">{firstUse ? t("An AI called “AI” is made for it. In notes you call it with @ai.") : t("It will be used by {name}.", { name: forRole?.name ?? "" })}</p>}
              {target === "existing" && !forRole && (
                data.roles.length === 0 ? <p className="member-hint">{t("You have no AI yet. Make a new one.")}</p> : (
                  <Select id={ids.existing} aria-label={t("Which AI")} value={existingId} onChange={(e) => setExistingId(e.target.value)}>
                    {data.roles.map((r) => <option key={r.actor_id} value={r.actor_id}>{r.name} (@{r.handle})</option>)}
                  </Select>
                )
              )}
              {target === "new" && !firstUse && (
                <>
                  <label htmlFor={ids.name}>{t("What should this AI be called?")}</label>
                  <TextField id={ids.name} value={newName} maxLength={AI_NAME_MAX} onChange={(e) => setNewName(e.target.value)} />
                </>
              )}
              {usesApi && (
                <div className="member-key-form">
                  <ModelAndCapFields value={settings} onChange={setSettings} models={tested?.models ?? null} noKeyYet={tested === null} />
                </div>
              )}
              {kind === "key" && <p className="member-hint">{t("The key will be saved as “{name}”.", { name: connectionLabel(draft) })}</p>}
            </fieldset>
          )}
        </>
      )}
      <div className="ai-flow-actions">
        <Button variant="ghost" className="ai-touch" disabled={busy} onClick={onCancel}>{t("Cancel")}</Button>
        {kind !== null && !initialKind && !forRole && <Button variant="secondary" className="ai-touch" disabled={busy} onClick={() => { setKind(null); setTested(null); }}>{t("Back")}</Button>}
        {kind !== null && <Button type="submit" variant="primary" className="ai-touch" disabled={!canSave}>{busy ? t("Saving…") : t("Save")}</Button>}
      </div>
    </form>
  );
}
