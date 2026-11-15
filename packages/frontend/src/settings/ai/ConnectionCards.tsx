import { useState } from "react";
import { Cable, KeyRound, Trash2, Unplug } from "lucide-react";

import { tn, useT } from "../../lib/i18n";
import { dateLabel, agoLabel } from "../../lib/timeLabels";
import { Button } from "../../components/ui";
import { testKey } from "./actions";
import ConnectionCodeSteps from "./ConnectionCodeSteps";
import type { AiPageData, CodeConnection, KeyConnection } from "./model";
import { rolesUsingKey } from "./model";
import "./ai.css";
import "./strings";

/** The test result line under a key: the models it lists, or the plain reason it did not work. */
export function useKeyTest(keyId: string) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof testKey>> | "testing" | null>(null);
  return {
    result,
    run: async () => { setResult("testing"); setResult(await testKey(keyId)); },
  };
}
export function KeyTestResult({ result }: { result: ReturnType<typeof useKeyTest>["result"] }) {
  const t = useT();
  if (result === null) return null;
  if (result === "testing") return <span className="member-hint" role="status">{t("Testing…")}</span>;
  return result.ok
    ? <span className="ai-test-ok" role="status">{tn("It works. 1 model is available.", "It works. {n} models are available.", result.models)}</span>
    : <span className="ai-test-fail" role="alert">{result.message}</span>;
}

/** An API key: name, address, last four, 「測試」, who uses it, and 刪除 — all visible, none behind a menu. */
export function KeyCard({ keyConnection, data, online, onDelete }: {
  keyConnection: KeyConnection; data: AiPageData; online: boolean; onDelete: () => void;
}) {
  const t = useT();
  const test = useKeyTest(keyConnection.id);
  const users = rolesUsingKey(keyConnection, data);
  return (
    <li className="ai-card ai-card--connection" data-connection="key">
      <div className="ai-card-head">
        <KeyRound size={16} aria-hidden="true" />
        <div className="ai-card-title"><strong>{keyConnection.label}</strong><small>{keyConnection.baseUrl} · {t("Ends in {last4}", { last4: keyConnection.last4 })}</small></div>
      </div>
      <p className="ai-card-line">{users.length === 0 ? t("No AI is using it yet.") : t("Used by {names}", { names: users.map((r) => r.name).join(t(", ")) })}</p>
      <div className="ai-card-actions">
        <Button variant="secondary" size="sm" className="ai-touch" disabled={!online || test.result === "testing"} onClick={() => void test.run()}>{t("Test")}</Button>
        <Button variant="ghost" size="sm" className="ai-touch settings-text-danger" disabled={!online} aria-label={t("Delete the key “{name}”", { name: keyConnection.label })} onClick={onDelete}><Trash2 size={13} aria-hidden="true" /> {t("Delete")}</Button>
        <KeyTestResult result={test.result} />
      </div>
    </li>
  );
}

/** A connection code: its name, when it was last used, 「怎麼接」 and 撤銷. */
export function CodeCard({ code, data, online, onRevoke }: { code: CodeConnection; data: AiPageData; online: boolean; onRevoke: () => void }) {
  const t = useT();
  const [how, setHow] = useState(false);
  const owner = data.roles.find((r) => r.actor_id === code.actorId);
  return (
    <li className="ai-card ai-card--connection" data-connection="code">
      <div className="ai-card-head">
        <Cable size={16} aria-hidden="true" />
        <div className="ai-card-title">
          <strong>{code.name || t("Code without a name")}</strong>
          <small>{code.lastUsedAt ? t("Last used {date}", { date: dateLabel(code.lastUsedAt, "shortDateTime") }) : t("Never used")}</small>
        </div>
      </div>
      <p className="ai-card-line">{owner ? t("Used by {names}", { names: owner.name }) : t("No AI is using it yet.")}</p>
      <div className="ai-card-actions">
        <Button variant="secondary" size="sm" className="ai-touch" aria-expanded={how} onClick={() => setHow(!how)}>{t("How to connect")}</Button>
        <Button variant="ghost" size="sm" className="ai-touch settings-text-danger" disabled={!online} aria-label={t("Revoke the connection code “{name}”", { name: code.name || t("Code without a name") })} onClick={onRevoke}><Unplug size={13} aria-hidden="true" /> {t("Revoke code")}</Button>
      </div>
      {how && <ConnectionCodeSteps />}
    </li>
  );
}

/** One line saying what an AI runs on, for its card. `seenAt`: when its software last came (the server's `last_seen_at`). */
export function ConnectionLine({ connection, seenAt }: { connection: import("./model").RoleConnection; seenAt?: string | null }) {
  const t = useT();
  if (connection.kind === "key") return <>{t("Runs on the key “{name}” (ends in {last4})", { name: connection.key.label, last4: connection.key.last4 })}</>;
  if (connection.kind === "code") {
    return <>{seenAt
      ? t("Connects with a connection code. Last connected {when}.", { when: agoLabel(seenAt) })
      : t("Connects with a connection code. Nothing has connected yet.")}</>;
  }
  return <>{t("No connection yet.")}</>;
}
