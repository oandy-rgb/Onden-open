import { useState } from "react";
import { Plus } from "lucide-react";

import { useAiEnabled } from "../../hooks/useModuleFilter";
import { useT } from "../../lib/i18n";
import { useIsOwner } from "../../lib/capabilities";
import { useSpaces } from "../../lib/spaces";
import type { SettingContext } from "../../lib/settingsTypes";
import { Button, Modal } from "../../components/ui";
import AiCard from "./AiCard";
import AiEditor from "./AiEditor";
import ChangeConnectionFlow from "./ChangeConnectionFlow";
import ConnectionCodeSteps from "./ConnectionCodeSteps";
import { CodeCard, KeyCard } from "./ConnectionCards";
import FirstUse from "./FirstUse";
import NewAiFlow from "./NewAiFlow";
import NewConnectionFlow from "./NewConnectionFlow";
import { deleteKey, revokeCode } from "./actions";
import { connectionOf, aiPageLayout, roleState, sortedRoles, type AiPageData } from "./model";
import { useAiPage } from "./useAiPage";
import "./ai.css";
import "./strings";

type Dialog = { kind: "connection" } | { kind: "ai" } | { kind: "change"; id: string } | { kind: "edit"; id: string };

// Settings › AI (owner only; docs/agents/decisions-ai-collaboration.md「設定 › AI」). A connection (an API key, or a
// connection code for the owner's own AI) and an AI are separate things. One connection and one AI is drawn as one
// card; anything else as two areas, 「連線」 and 「你的 AI」, from the same cards. Nothing here opens a space's
// 「讓 AI 讀」 switch.
export default function AiSettings({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const isOwner = useIsOwner();
  const aiOn = useAiEnabled();
  const { data, failed, reload } = useAiPage(ctx.online && isOwner);
  const { spaces } = useSpaces(ctx.online);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [fresh, setFresh] = useState<{ aiName: string; plaintext: string } | null>(null);
  const sharedSpaces = spaces.filter((s) => s.kind === "shared");

  if (!isOwner) return <p className="setting-note">{t("Only the owner can set up AI.")}</p>;
  if (!ctx.online) return <p className="setting-note">{t("Connect to manage AI.")}</p>;
  if (!data) {
    return failed
      ? <div><p className="setting-note" role="alert">{t("Could not load the AI settings.")}</p><Button variant="secondary" size="sm" className="ai-touch" onClick={() => void reload()}>{t("Try again")}</Button></div>
      : <p className="setting-note">{t("Loading…")}</p>;
  }

  const reloadIfDone = async (write: Promise<boolean>) => { if (await write) await reload(); };
  const layout = aiPageLayout(data);
  const close = () => setDialog(null);
  const roles = sortedRoles(data.roles);
  const roleCard = (role: AiPageData["roles"][number], merged: boolean) => {
    const connection = connectionOf(role, data);
    return (
      <AiCard key={role.actor_id} role={role} connection={connection} state={roleState(role, connection)} merged={merged} online={ctx.online}
        onEdit={() => setDialog({ kind: "edit", id: role.actor_id })} onChangeConnection={() => setDialog({ kind: "change", id: role.actor_id })}
        onDeleteKey={connection.kind === "key" ? () => void reloadIfDone(deleteKey(connection.key)) : undefined}
        onRevokeCode={connection.kind === "code" ? () => void reloadIfDone(revokeCode(connection.code)) : undefined} />
    );
  };
  const add = (
    <div className="ai-add">
      <Button variant="secondary" className="ai-touch" onClick={() => setDialog({ kind: "connection" })}><Plus size={14} aria-hidden="true" /> {t("New connection")}</Button>
      <Button variant="secondary" className="ai-touch" onClick={() => setDialog({ kind: "ai" })}><Plus size={14} aria-hidden="true" /> {t("New AI")}</Button>
    </div>
  );

  const editing = dialog?.kind === "edit" || dialog?.kind === "change" ? roles.find((r) => r.actor_id === dialog.id) : undefined;
  const editingConnection = editing ? connectionOf(editing, data) : null;

  return (
    <div className="ai-settings" data-layout={layout}>
      {fresh && (
        <ConnectionCodeSteps fresh={{ aiName: fresh.aiName, plaintext: fresh.plaintext }} onDone={() => setFresh(null)} />
      )}

      {layout === "first-use" && <FirstUse data={data} online={ctx.online} aiOn={aiOn} onDone={() => void reload()} onFresh={setFresh} />}

      {layout === "merged" && (
        <>
          <ul className="ai-list">{roles[0] && roleCard(roles[0], true)}</ul>
          {add}
        </>
      )}

      {layout === "split" && (
        <>
          <section className="ai-area" aria-label={t("Connections")}>
            <h3>{t("Connections")}</h3>
            {data.keys.length + data.codes.length === 0 ? <p className="setting-note">{t("No connection yet.")}</p> : (
              <ul className="ai-list">
                {data.keys.map((k) => <KeyCard key={k.id} keyConnection={k} data={data} online={ctx.online} onDelete={() => void reloadIfDone(deleteKey(k))} />)}
                {data.codes.map((c) => <CodeCard key={c.id} code={c} data={data} online={ctx.online} onRevoke={() => void reloadIfDone(revokeCode(c))} />)}
              </ul>
            )}
            <div className="ai-add"><Button variant="secondary" className="ai-touch" onClick={() => setDialog({ kind: "connection" })}><Plus size={14} aria-hidden="true" /> {t("New connection")}</Button></div>
          </section>
          <section className="ai-area" aria-label={t("Your AIs")}>
            <h3>{t("Your AIs")}</h3>
            {roles.length === 0 ? <p className="setting-note">{t("No AI yet.")}</p> : <ul className="ai-list">{roles.map((r) => roleCard(r, false))}</ul>}
            <div className="ai-add"><Button variant="secondary" className="ai-touch" onClick={() => setDialog({ kind: "ai" })}><Plus size={14} aria-hidden="true" /> {t("New AI")}</Button></div>
          </section>
        </>
      )}

      {dialog?.kind === "connection" && (
        <Modal label={t("New connection")} className="confirm-dialog-backdrop" onClose={close}>
          <div className="confirm-dialog ai-dialog">
            <h2 className="confirm-dialog-title">{t("New connection")}</h2>
            <NewConnectionFlow data={data} online={ctx.online} aiOn={aiOn} onDone={() => void reload()} onFresh={setFresh} onCancel={close} />
          </div>
        </Modal>
      )}
      {dialog?.kind === "ai" && (
        <Modal label={t("New AI")} className="confirm-dialog-backdrop" onClose={close}>
          <div className="confirm-dialog ai-dialog">
            <h2 className="confirm-dialog-title">{t("New AI")}</h2>
            <NewAiFlow data={data} online={ctx.online} aiOn={aiOn} onDone={() => void reload()} onFresh={setFresh} onCancel={close} />
          </div>
        </Modal>
      )}
      {dialog?.kind === "change" && editing && (
        <Modal label={t("Change connection of {name}", { name: editing.name })} className="confirm-dialog-backdrop" onClose={close}>
          <div className="confirm-dialog ai-dialog">
            <h2 className="confirm-dialog-title">{t("Change connection of {name}", { name: editing.name })}</h2>
            <ChangeConnectionFlow role={editing} data={data} online={ctx.online} aiOn={aiOn} onDone={() => void reload()} onFresh={setFresh} onCancel={close} />
          </div>
        </Modal>
      )}
      {dialog?.kind === "edit" && editing && editingConnection && (
        <Modal label={t("Edit {name}", { name: editing.name })} className="confirm-dialog-backdrop" onClose={close}>
          <div className="confirm-dialog ai-dialog ai-dialog--wide">
            <h2 className="confirm-dialog-title">{t("Edit {name}", { name: editing.name })}</h2>
            <AiEditor role={editing} connection={editingConnection} state={roleState(editing, editingConnection)} spaces={sharedSpaces} online={ctx.online}
              onChangeConnection={() => setDialog({ kind: "change", id: editing.actor_id })} onChanged={reload} onClose={close} />
            <div className="ai-flow-actions"><Button variant="primary" className="ai-touch" onClick={close}>{t("Done")}</Button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
