import { useId, useState } from "react";

import { reads, writeErrors } from "../../lib/data";
import { tn, useT } from "../../lib/i18n";
import { Button, Select, TextField } from "../../components/ui";
import type { ApiModelChoice } from "./ApiSettingsFields";
import "./ai.css";
import { AI_NAME_MAX } from "./model";
import "./strings";

// Adding an API connection, the one form: address, key, a name (blank = taken from the address), and a 「測試」
// that asks the service with this key before anything is kept. Only a passed test lets the caller save. When the
// service's format cannot be told, the person chooses it (told by the path the service serves, never by a company).
// Used by 設定 › AI (first use, 新增連線) and by the old key block in 「空間與成員」.

/** The wire formats a service may speak, told apart by the path they serve (never by a company). */
const FORMATS = [
  { id: "v1_messages", label: "Format A: /v1/messages" },
  { id: "v1_chat_completions", label: "Format B: /v1/chat/completions" },
] as const;
type FormatId = (typeof FORMATS)[number]["id"];

export type ConnectionDraft = { label: string; baseUrl: string; apiKey: string; protocol: FormatId | ""; inPrice: string; outPrice: string };
export const EMPTY_CONNECTION: ConnectionDraft = { label: "", baseUrl: "", apiKey: "", protocol: "", inPrice: "", outPrice: "" };

/** What a passed test learned: the format and the models the service itself lists (retired ones left out). */
export type TestedConnection = { protocol: string; models: ApiModelChoice[] };

/** The name to keep: what was typed, else the service's host. */
export function connectionLabel(draft: ConnectionDraft): string {
  if (draft.label.trim()) return draft.label.trim();
  try { return new URL(draft.baseUrl.trim()).host; } catch { return draft.baseUrl.trim(); }
}

const priceOrNull = (text: string): number | null => (text.trim() === "" ? null : Number(text));
/** Both prices or neither, each a number from 0 up; null when what was typed is not that. */
export function connectionPrices(draft: ConnectionDraft): { input: number | null; output: number | null } | null {
  const [input, output] = [priceOrNull(draft.inPrice), priceOrNull(draft.outPrice)];
  if ((input === null) !== (output === null) || [input, output].some((p) => p !== null && !(p >= 0))) return null;
  return { input, output };
}

/** The fields of a new key as the server takes them (POST /api/ai/credentials, and `api_new` of POST /api/ai/roles). */
export function connectionFields(draft: ConnectionDraft, tested: TestedConnection) {
  const prices = connectionPrices(draft)!;
  return {
    label: connectionLabel(draft), api_key: draft.apiKey.trim(), base_url: draft.baseUrl.trim(), protocol: tested.protocol,
    input_price_per_m: prices.input, output_price_per_m: prices.output,
  };
}

/** Whether the draft may be tested now. */
export const connectionTestable = (draft: ConnectionDraft): boolean => !!draft.baseUrl.trim() && !!draft.apiKey.trim() && connectionPrices(draft) !== null;

export default function ApiConnectionForm({ draft, onChange, tested, onTested, online, busy = false }: {
  draft: ConnectionDraft; onChange: (next: ConnectionDraft) => void;
  tested: TestedConnection | null; onTested: (result: TestedConnection | null) => void;
  online: boolean; busy?: boolean;
}) {
  const t = useT();
  const ids = { label: useId(), address: useId(), key: useId(), format: useId(), inPrice: useId(), outPrice: useId() };
  const [testing, setTesting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [chooseFormat, setChooseFormat] = useState(false);
  const [prices, setPrices] = useState(false);

  /** Any change to what the test asked invalidates its answer. */
  const edit = (next: ConnectionDraft, touchesTest: boolean) => {
    onChange(next);
    if (touchesTest) { onTested(null); setFailure(null); }
  };

  async function test() {
    if (testing || !connectionTestable(draft)) return;
    setTesting(true); setFailure(null);
    try {
      const answer = await reads.aiRuntime.testCredential({ base_url: draft.baseUrl.trim(), api_key: draft.apiKey.trim(), ...(draft.protocol ? { protocol: draft.protocol } : {}) });
      onTested({ protocol: answer.protocol, models: answer.models.filter((m) => m.lifecycle !== "retired") });
    } catch (error) {
      onTested(null);
      setChooseFormat((error as { code?: string })?.code === "protocol_undetected");
      setFailure(writeErrors.requestMessage(error, t("The test did not work. Check the address and the key.")));
    } finally { setTesting(false); }
  }

  const locked = busy || testing;
  return (
    <div className="member-key-form ai-connection-form">
      <label htmlFor={ids.address}>{t("Service address")}</label>
      <TextField id={ids.address} inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://" value={draft.baseUrl} disabled={locked}
        onChange={(e) => { edit({ ...draft, baseUrl: e.target.value }, true); setChooseFormat(false); }} />
      <label htmlFor={ids.key}>{t("API key")}</label>
      <TextField id={ids.key} type="password" autoComplete="off" spellCheck={false} value={draft.apiKey} disabled={locked}
        onChange={(e) => edit({ ...draft, apiKey: e.target.value }, true)} />
      <p className="member-hint">{t("It is kept encrypted on your server and never shown again; only its last four characters are.")}</p>
      {chooseFormat && (
        <>
          <p className="member-hint" role="alert">{t("Onden could not tell which format this service speaks. Choose one.")}</p>
          <label htmlFor={ids.format}>{t("Format of the service")}</label>
          <Select id={ids.format} value={draft.protocol} disabled={locked} onChange={(e) => edit({ ...draft, protocol: e.target.value as FormatId | "" }, true)}>
            <option value="">{t("Choose…")}</option>
            {FORMATS.map((f) => <option key={f.id} value={f.id}>{t(f.label)}</option>)}
          </Select>
        </>
      )}
      <label htmlFor={ids.label}>{t("Name for this key (optional)")}</label>
      <TextField id={ids.label} value={draft.label} maxLength={AI_NAME_MAX} placeholder={t("Taken from the address when left blank")} disabled={locked}
        onChange={(e) => edit({ ...draft, label: e.target.value }, false)} />
      <div className="ai-test-row">
        <Button variant="secondary" className="ai-touch" disabled={!online || locked || !connectionTestable(draft) || (chooseFormat && !draft.protocol)} onClick={() => void test()}>
          {testing ? t("Testing…") : t("Test")}
        </Button>
        {tested && (
          <span className="ai-test-ok" role="status">
            {tn("It works. 1 model is available.", "It works. {n} models are available.", tested.models.length)}
          </span>
        )}
        {failure && <span className="ai-test-fail" role="alert">{failure}</span>}
      </div>
      <Button variant="ghost" size="sm" className="ai-touch" aria-expanded={prices} onClick={() => setPrices(!prices)}>
        {prices ? t("Hide price fields") : t("Add prices (optional)")}
      </Button>
      {prices && (
        <>
          <p className="member-hint">{t("Optional: the price your service charges per million tokens. Leave both blank to see token counts only.")}</p>
          <label htmlFor={ids.inPrice}>{t("Price per million input tokens")}</label>
          <TextField id={ids.inPrice} inputMode="decimal" value={draft.inPrice} disabled={locked} onChange={(e) => edit({ ...draft, inPrice: e.target.value }, false)} />
          <label htmlFor={ids.outPrice}>{t("Price per million output tokens")}</label>
          <TextField id={ids.outPrice} inputMode="decimal" value={draft.outPrice} disabled={locked} onChange={(e) => edit({ ...draft, outPrice: e.target.value }, false)} />
          {connectionPrices(draft) === null && <p className="member-hint" role="alert">{t("Write both prices as numbers, or leave both blank.")}</p>}
        </>
      )}
    </div>
  );
}
