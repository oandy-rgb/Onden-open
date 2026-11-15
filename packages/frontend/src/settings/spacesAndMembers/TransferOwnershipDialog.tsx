import { reloadPage } from "../../lib/api";
import { useId, useState } from "react";

import { addToast } from "../../lib/appStore";
import { sendWrite, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { Button, Modal, Select, TextField } from "../../components/ui";
import type { RosterPerson } from "./roster";

/** Hand the workspace to another person who has signed in. The new owner's name
 *  is typed back to confirm; nothing here is reachable by an AI helper or a
 *  member (the server refuses them too). The page reloads afterwards, because
 *  who the owner is decides what the whole app shows. */
export default function TransferOwnershipDialog({ candidates, onClose }: { candidates: RosterPerson[]; onClose: () => void }) {
  const t = useT();
  const selectId = useId();
  const nameId = useId();
  const [toId, setToId] = useState(candidates[0]?.id ?? "");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const target = candidates.find((p) => p.id === toId);

  async function transfer() {
    if (!target || typed !== target.name || busy) return;
    setBusy(true);
    try {
      await sendWrite("POST", "/api/workspace/owner-transfer", { to_actor_id: target.id, confirm_name: typed });
      addToast(t("{name} is now the owner.", { name: target.name }));
      reloadPage();
    } catch (error) {
      writeErrors.report(error, addToast);
      setBusy(false);
    }
  }

  return (
    <Modal label={t("Transfer ownership")} className="confirm-dialog-backdrop" busy={busy} onClose={onClose}>
      <form className="confirm-dialog" onSubmit={(e) => { e.preventDefault(); void transfer(); }}>
        <h2 className="confirm-dialog-title">{t("Transfer ownership")}</h2>
        {candidates.length === 0 ? (
          <p className="confirm-dialog-message">{t("Only someone who has already signed in can become the owner. Invite a person first.")}</p>
        ) : (
          <>
            <label htmlFor={selectId}>{t("New owner")}</label>
            <Select id={selectId} value={toId} disabled={busy} onChange={(e) => { setToId(e.target.value); setTyped(""); }}>
              {candidates.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <p className="confirm-dialog-message">
              {t("After this, {name} is the owner and you become an ordinary member who stays in your spaces. An AI helper or another member can't do this for you.", { name: target?.name ?? "" })}
            </p>
            <label htmlFor={nameId}>{t("Type “{name}” to confirm", { name: target?.name ?? "" })}</label>
            <TextField id={nameId} value={typed} autoComplete="off" disabled={busy} onChange={(e) => setTyped(e.target.value)} />
          </>
        )}
        <div className="confirm-dialog-actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>{t("Cancel")}</Button>
          {candidates.length > 0 && (
            <Button type="submit" variant="danger" disabled={busy || !target || typed !== target.name}>{busy ? t("Transferring…") : t("Transfer ownership")}</Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
