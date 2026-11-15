import { useEffect, useId, useState } from "react";

import { reads } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { Select, TextField } from "../../components/ui";

// The part of an API role's setup both screens share (the role's card and the “Add AI role” steps):
// which key, which model, and the monthly limit. There is no default model and no suggested one: the list
// is whatever the chosen service itself reports. The limit is counted in tokens.

export type ApiKeyChoice = { id: string; label: string; last4: string; revoked_at: string | null };
export type ApiModelChoice = { id: string; display_name: string; lifecycle: "active" | "deprecated" | "retired"; web_search: boolean };
export type ApiSettings = { credentialId: string; model: string; cap: "" | "unlimited" | "capped"; capTokens: string };

export const EMPTY_API_SETTINGS: ApiSettings = { credentialId: "", model: "", cap: "", capTokens: "" };

export const apiSettingsReady = (s: ApiSettings): boolean =>
  !!s.credentialId && !!s.model && (s.cap === "unlimited" || (s.cap === "capped" && Number.isInteger(Number(s.capTokens)) && Number(s.capTokens) > 0));

/** The body of PUT /api/ai/roles/:id/runtime for these settings. */
export const apiSettingsBody = (s: ApiSettings) => ({
  credential_id: s.credentialId, model: s.model,
  cap: s.cap === "capped" ? { kind: "capped" as const, tokens: Number(s.capTokens) } : { kind: "unlimited" as const },
});

/** Whether this server offers the API way of running at all, and the owner's live keys (none until loaded). */
export function useApiKeys(): { offered: boolean; keys: ApiKeyChoice[] } {
  const [offered, setOffered] = useState(false);
  const [keys, setKeys] = useState<ApiKeyChoice[]>([]);
  useEffect(() => {
    let cancelled = false;
    reads.aiRuntime.status().then(async ({ api_runtime_offered }) => {
      if (!api_runtime_offered) return;
      if (!cancelled) setOffered(true);
      const list = (await reads.aiRuntime.credentials<ApiKeyChoice>()).credentials.filter((k) => !k.revoked_at);
      if (!cancelled) setKeys(list);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return { offered, keys };
}

/** The model (from the list the service itself reports; no default) and the monthly limit. Shared by every place
 *  that sets up an API-run AI: the key is chosen or tested elsewhere, and `models` is its list (null while loading). */
export function ModelAndCapFields({ value, onChange, models, retired, noKeyYet }: {
  value: ApiSettings; onChange: (next: ApiSettings) => void; models: ApiModelChoice[] | null;
  /** No key is chosen yet, so there is no list to wait for. */
  noKeyYet?: boolean;
  /** The model chosen earlier was retired by the service. */
  retired?: boolean;
}) {
  const t = useT();
  const ids = { model: useId(), cap: useId() };
  return (
    <>
      <label htmlFor={ids.model}>{t("Model")}</label>
      <Select id={ids.model} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} disabled={models === null || noKeyYet}>
        <option value="">{models === null && !noKeyYet ? t("Loading…") : t("Choose a model…")}</option>
        {(models ?? []).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
      </Select>
      {!noKeyYet && models !== null && models.length === 0 && <p className="member-hint">{t("This service did not list any model. Check the key and the service address.")}</p>}
      {retired && <p className="member-warning" role="alert">{t("The model you chose was retired. Choose another to run again.")}</p>}
      <label htmlFor={ids.cap}>{t("Monthly limit")}</label>
      <Select id={ids.cap} value={value.cap} onChange={(e) => onChange({ ...value, cap: e.target.value as ApiSettings["cap"] })}>
        <option value="">{t("Choose…")}</option>
        <option value="capped">{t("Stop at a number of tokens each month")}</option>
        <option value="unlimited">{t("No limit")}</option>
      </Select>
      {value.cap === "capped" && (
        <label>{t("Tokens per month")} <TextField inputMode="numeric" value={value.capTokens} onChange={(e) => onChange({ ...value, capTokens: e.target.value.replace(/\D/g, "") })} /></label>
      )}
      {value.cap === "unlimited" && <p className="member-hint">{t("Tip: also set a spending limit with your AI service for this key.")}</p>}
    </>
  );
}

export default function ApiSettingsFields({ value, onChange, keys, retired, onModels }: {
  value: ApiSettings; onChange: (next: ApiSettings) => void; keys: ApiKeyChoice[];
  /** The model chosen earlier was retired by the service. */
  retired?: boolean;
  onModels?: (models: ApiModelChoice[] | null) => void;
}) {
  const t = useT();
  const keyId = useId();
  const [models, setModels] = useState<ApiModelChoice[] | null>(null);

  useEffect(() => {
    if (!value.credentialId) { setModels(null); onModels?.(null); return; }
    let cancelled = false;
    reads.aiRuntime.models<ApiModelChoice>(value.credentialId)
      .then((r) => { if (!cancelled) { const live = r.models.filter((m) => m.lifecycle !== "retired"); setModels(live); onModels?.(live); } })
      .catch(() => { if (!cancelled) { setModels([]); onModels?.([]); } });
    return () => { cancelled = true; };
    // onModels is a setter from the parent; the models depend on the key alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.credentialId]);

  return (
    <>
      <label htmlFor={keyId}>{t("API key")}</label>
      <Select id={keyId} value={value.credentialId} onChange={(e) => onChange({ ...value, credentialId: e.target.value, model: "" })}>
        <option value="">{t("Choose…")}</option>
        {keys.map((k) => <option key={k.id} value={k.id}>{k.label} · {t("Ends in {last4}", { last4: k.last4 })}</option>)}
      </Select>
      <ModelAndCapFields value={value} onChange={onChange} models={models} noKeyYet={!value.credentialId} retired={retired} />
    </>
  );
}
