import { useCallback, useEffect, useState } from "react";

import { addToast } from "../../lib/appStore";
import { aiRoleWriter, reads, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { Button, Checkbox, Radio } from "../../components/ui";
import ApiSettingsFields, {
  apiSettingsBody, apiSettingsReady, EMPTY_API_SETTINGS, useApiKeys, type ApiModelChoice, type ApiSettings,
} from "./ApiSettingsFields";
import { useRuntimeText, type AiRoleInfo, type RuntimeKind as Runtime } from "./aiRoleInfo";

type RoleRuntimes = AiRoleInfo;

/** One role's way of running: the choice between the two ways (API, MCP), and for the API its key,
 *  model (no default: you choose) and monthly limit. Shown only where the server offers
 *  the API at all. Choosing a way never changes what the role may do. */
export default function ApiRuntimeSetup({ actorId, online, onChanged }: { actorId: string; online: boolean; onChanged: () => void }) {
  const t = useT();
  const { label, reason: why } = useRuntimeText();
  const { keys } = useApiKeys();
  const [role, setRole] = useState<RoleRuntimes | null>(null);
  const [models, setModels] = useState<ApiModelChoice[] | null>(null);
  const [runtime, setRuntime] = useState<Runtime>("");
  const [api, setApi] = useState<ApiSettings>(EMPTY_API_SETTINGS);
  const [smallOnly, setSmallOnly] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const mine = (await reads.aiRuntime.roles<RoleRuntimes>()).roles.find((r) => r.actor_id === actorId) ?? null;
      setRole(mine);
      if (!mine) return;
      setRuntime(mine.default_runtime);
      setApi((now) => ({ ...now, model: mine.api?.model ?? "", cap: mine.api?.cap ?? "", capTokens: mine.api?.monthly_cap_tokens ? String(mine.api.monthly_cap_tokens) : "" }));
      setSmallOnly(mine.api?.small_actions_only ?? false);
      setWebSearch(mine.api?.web_search ?? false);
    } catch { setRole(null); }
  }, [actorId]);
  useEffect(() => { void load(); }, [load]);

  // The key currently used (the one the role has, else the only one there is).
  useEffect(() => {
    if (!role?.api || api.credentialId) return;
    const current = keys.find((k) => k.id === role.api!.credential_id)?.id ?? keys[0]?.id ?? "";
    if (current) setApi((now) => ({ ...now, credentialId: current }));
  }, [role, keys, api.credentialId]);

  // Only a service that says it can search offers the switch (a role that already has it on can still turn it off).
  const searchOffered = (models ?? []).find((m) => m.id === api.model)?.web_search === true;
  if (!role?.api) return null; // the server does not offer the API for this role: nothing to choose

  const apiReady = runtime !== "api" || apiSettingsReady(api);
  async function save() {
    if (busy || !apiReady) return;
    setBusy(true);
    try {
      await aiRoleWriter.setRuntime(actorId, {
        default_runtime: runtime,
        ...(runtime === "api" ? { api: { ...apiSettingsBody(api), small_actions_only: smallOnly, web_search: webSearch } } : {}),
      });
      addToast(t("Saved."), "success");
      await load();
      onChanged();
    } catch (error) { writeErrors.report(error, addToast); }
    finally { setBusy(false); }
  }

  return (
    <section className="member-keys" aria-label={t("How this role runs")}>
      <h4>{t("Way of running")}</h4>
      <div role="radiogroup" aria-label={t("Way of running")} className="member-key-access">
        {role.runtimes.map((r) => (
          <label key={r.kind}>
            <Radio checked={runtime === r.kind} onChange={() => setRuntime(r.kind)} /> {label(r.kind)}
            {!r.available && <span className="member-hint"> — {why(r.unavailable_reason)}</span>}
          </label>
        ))}
      </div>
      {runtime === "api" && (
        <div className="member-key-form">
          <p className="member-hint">{t("With the API the AI can only suggest changes. You accept or reject each one.")}</p>
          <ApiSettingsFields value={api} onChange={setApi} keys={keys} retired={role.api.model_retired} onModels={setModels} />
          <p className="member-hint">{t("Used this month: {n} tokens.", { n: role.api.used_this_month_tokens.toLocaleString() })}</p>
          <label><Checkbox checked={smallOnly} onChange={(e) => setSmallOnly(e.target.checked)} /> {t("Use the API only for small actions on selected text")}</label>
          {(searchOffered || webSearch) && <label><Checkbox checked={webSearch} onChange={(e) => setWebSearch(e.target.checked)} /> {t("Let it search the web")}</label>}
          {webSearch && <p className="member-hint">{t("Its search words are sent to the internet and can contain parts of your notes.")}</p>}
        </div>
      )}
      <Button variant="secondary" disabled={!online || busy || !apiReady} onClick={() => void save()}>{t("Save")}</Button>
    </section>
  );
}
