import { Bot, Trash2, Unplug } from "lucide-react";
import { useState } from "react";

import { useT } from "../../lib/i18n";
import { useRuntimeText } from "./aiRoleInfo";
import type { AiRoleInfo } from "./aiRoleInfo";
import { Button } from "../../components/ui";
import ConnectionCodeSteps from "./ConnectionCodeSteps";
import { ConnectionLine, KeyTestResult, useKeyTest } from "./ConnectionCards";
import type { RoleConnection, RoleState } from "./model";
import "./strings";

/** Why an AI is off, in one plain sentence. */
export function useOffReason() {
  const t = useT();
  const { reason } = useRuntimeText();
  return (code: string): string =>
    code === "key_deleted" ? t("The key it used was deleted.")
    : code === "no_connection" ? t("It has no connection yet.")
    : code === "external_ai_off" ? t("Give it “Can edit” in a space that lets AI read, so it can suggest changes there.")
    : reason(code);
}

/** One AI, the same card in both layouts. Merged (one connection, one AI): the connection line sits in the card with
 *  its own 「測試」 and 「換連線」. Split: a row of name, @name, what it runs on, model and state; an AI that lost its
 *  connection shows 「停用中」, the reason and 「換連線」 right there. 「編輯」 is always a button. */
export default function AiCard({ role, connection, state, merged, online, onEdit, onChangeConnection, onDeleteKey, onRevokeCode }: {
  role: AiRoleInfo; connection: RoleConnection; state: RoleState; merged: boolean; online: boolean;
  onEdit: () => void; onChangeConnection: () => void;
  /** Merged card only: the one connection is not drawn anywhere else, so its delete / revoke is here. */
  onDeleteKey?: () => void; onRevokeCode?: () => void;
}) {
  const t = useT();
  const offReason = useOffReason();
  const key = connection.kind === "key" ? connection.key : null;
  const test = useKeyTest(key?.id ?? "");
  const [how, setHow] = useState(false);
  const model = role.api?.model;
  const off = state.state === "off";
  // 「停用中」 is for an AI with no working connection; one that only needs a space to edit in is not stopped, just not ready.
  const lostConnection = state.state === "off" && (state.reason === "key_deleted" || state.reason === "no_connection");
  const seenAt = role.runtimes.find((r) => r.kind === "mcp")?.last_seen_at ?? null;
  const stateText = state.state === "ready" ? (connection.kind === "code" ? t("Connected") : t("Ready"))
    : state.state === "waiting" ? t("Waiting for it to connect") : state.state === "away" ? t("Not connected now")
    : state.state === "paused" ? t("Paused") : lostConnection ? t("Stopped") : t("Not ready yet");
  return (
    <li className={off ? "ai-card ai-card--ai is-off" : "ai-card ai-card--ai"} data-ai-state={state.state} data-merged={merged ? "yes" : "no"}>
      <div className="ai-card-head">
        <Bot size={16} aria-hidden="true" />
        <div className="ai-card-title">
          <strong>{role.name}</strong>
          <small>@{role.handle}</small>
        </div>
        <span className={`ai-state ai-state--${state.state}`}>{stateText}</span>
      </div>
      {off && <p className="ai-card-reason" role="status">{offReason(state.reason)}</p>}
      <p className="ai-card-line"><ConnectionLine connection={connection} seenAt={seenAt} />{model && !merged && <> · {model}</>}</p>
      {merged && model && <p className="ai-card-line">{t("Model: {model}", { model })}</p>}
      <div className="ai-card-actions">
        {merged && key && <Button variant="secondary" size="sm" className="ai-touch" disabled={!online || test.result === "testing"} onClick={() => void test.run()}>{t("Test")}</Button>}
        {(merged || off) && <Button variant={off ? "primary" : "secondary"} size="sm" className="ai-touch" disabled={!online} onClick={onChangeConnection}>{t("Change connection")}</Button>}
        <Button variant="secondary" size="sm" className="ai-touch" aria-label={t("Edit {name}", { name: role.name })} onClick={onEdit}>{t("Edit")}</Button>
        {merged && key && onDeleteKey && <Button variant="ghost" size="sm" className="ai-touch settings-text-danger" disabled={!online} aria-label={t("Delete the key “{name}”", { name: key.label })} onClick={onDeleteKey}><Trash2 size={13} aria-hidden="true" /> {t("Delete")}</Button>}
        {merged && connection.kind === "code" && <Button variant="secondary" size="sm" className="ai-touch" aria-expanded={how} onClick={() => setHow(!how)}>{t("How to connect")}</Button>}
        {merged && connection.kind === "code" && onRevokeCode && <Button variant="ghost" size="sm" className="ai-touch settings-text-danger" disabled={!online} aria-label={t("Revoke the connection code “{name}”", { name: connection.code.name || t("Code without a name") })} onClick={onRevokeCode}><Unplug size={13} aria-hidden="true" /> {t("Revoke code")}</Button>}
        {merged && <KeyTestResult result={test.result} />}
      </div>
      {merged && how && <ConnectionCodeSteps />}
    </li>
  );
}
