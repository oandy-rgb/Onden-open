// "Confirm that it is you": the one dialog that asks before something that hands out or destroys a lot (the file of all notes today; the full
// backup and the export next). It shows what is about to happen (`explanation`), asks for the password again (or, in the browser version whose one
// local person has a public password, for a press of the button), and on success hands the caller the short-lived single-use ticket
// (lib/data/freshProof.ts) to send with the request. It does the request itself NOT: the caller does, with the ticket.
//
//   <ReconfirmDialog purpose="snapshot_export" title={…} explanation={<p>…</p>} confirmLabel={…} withoutPassword={…} onProof={(ticket) => …} onClose={…} />

import { useState, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { freshProof, type FreshProofPurpose } from "../lib/data";
import { t } from "../lib/i18n";
import { Button, FieldError, Modal, TextField } from "./ui";
import "./ReconfirmDialog.css";

export function ReconfirmDialog({ purpose, title, explanation, confirmLabel, withoutPassword, onProof, onClose }: {
  purpose: FreshProofPurpose;
  title: string;
  /** What is about to happen, in plain words, above the confirmation. */
  explanation: ReactNode;
  confirmLabel: string;
  /** The browser version: one local person, no password to type; the button is the confirmation. A server that wants the password anyway says so
   *  (`fresh_proof_password_needed`) and the dialog then asks for it. */
  withoutPassword: boolean;
  /** Called with the ticket once confirmed; the dialog stays up (and busy) until it settles. */
  onProof: (ticket: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [askPassword, setAskPassword] = useState(!withoutPassword);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function confirm() {
    setProblem(null);
    setBusy(true);
    try {
      const ticket = await freshProof.issue(purpose, askPassword ? { kind: "password", password } : { kind: "acknowledgement" });
      await onProof(ticket);
    } catch (error) {
      if (error instanceof ApiError && error.code === "fresh_proof_password_needed") setAskPassword(true);
      setProblem(error instanceof ApiError ? error.message : t("The password could not be checked right now. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal label={title} busy={busy} onClose={onClose}>
      <div className="reconfirm-dialog">
        <h3 className="reconfirm-title">{title}</h3>
        {explanation}
        {askPassword && (
          <label className="reconfirm-field">
            <span>{t("Your password, to confirm that it is you")}</span>
            <TextField type="password" value={password} autoComplete="current-password" onChange={(event) => { setPassword(event.target.value); setProblem(null); }} />
          </label>
        )}
        {problem && <FieldError>{problem}</FieldError>}
        <div className="reconfirm-actions">
          <Button type="button" onClick={() => void confirm()} disabled={busy || (askPassword && password === "")}>{confirmLabel}</Button>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</Button>
        </div>
      </div>
    </Modal>
  );
}
