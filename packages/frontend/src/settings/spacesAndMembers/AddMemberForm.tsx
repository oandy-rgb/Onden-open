import { useId, useState } from "react";

import { useT } from "../../lib/i18n";
import { spaceLabel } from "../../lib/spaces";
import { Button, TextField } from "../../components/ui";
import { PermissionControl, type Standing } from "../ai";
import type { RosterSpace } from "./roster";

export type NewPerson = {
  name: string;
  email: string;
  /** Only the spaces they join: 可看 or 可編輯. */
  standings: Array<{ spaceId: string; permission: "view" | "edit" }>;
};

/** Invite a person by email. Each shared space says whether they join it and
 *  with what; the space they were invited from starts as 可看. The caller does
 *  the writes and keeps the form's input if they fail. */
export default function AddMemberForm({ spaces, online, defaultSpaceId, onAdd, onCancel }: {
  spaces: RosterSpace[];
  online: boolean;
  defaultSpaceId?: string;
  onAdd: (person: NewPerson) => Promise<boolean>;
  onCancel: () => void;
}) {
  const t = useT();
  const nameId = useId();
  const emailId = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [standing, setStanding] = useState<Record<string, Standing>>(defaultSpaceId ? { [defaultSpaceId]: "view" } : {});
  const [busy, setBusy] = useState(false);
  const chosen = Object.entries(standing).filter(([, s]) => s !== "none") as Array<[string, "view" | "edit"]>;
  const ready = !!name.trim() && !!email.trim();

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const ok = await onAdd({ name: name.trim(), email: email.trim(), standings: chosen.map(([spaceId, permission]) => ({ spaceId, permission })) });
      if (ok) onCancel();
    } finally { setBusy(false); }
  }

  return (
    <form className="member-add" aria-label={t("Invite a person")} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label htmlFor={nameId}>{t("Name")}</label>
      <TextField id={nameId} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      <label htmlFor={emailId}>{t("Email")}</label>
      <TextField id={emailId} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
      <p className="member-hint">{t("You get a one-time link to send them. When they sign in through it with this email, they get the spaces you choose here.")}</p>
      <fieldset className="member-add-spaces">
        <legend>{t("Spaces they join")}</legend>
        {spaces.length === 0 ? <p className="member-hint">{t("There are no shared spaces yet. Create one with “New space” first.")}</p> : (
          <ul className="member-spaces">
            {spaces.map((space) => (
              <li key={space.id}>
                <span className="member-space-name">{spaceLabel(space)}</span>
                <PermissionControl label={t("{name} in {space}", { name: name.trim() || t("New member"), space: spaceLabel(space) })}
                  name={name.trim() || t("New member")} leave="skip" value={standing[space.id] ?? "none"} busy={busy} onChange={(next) => setStanding({ ...standing, [space.id]: next })} />
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <div className="member-add-actions">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>{t("Cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!online || busy || !ready}>{t("Invite")}</Button>
      </div>
    </form>
  );
}
