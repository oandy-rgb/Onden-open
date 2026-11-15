import { Trash2 } from "lucide-react";

import { useT } from "../../lib/i18n";
import type { Space } from "../../lib/spaces";
import { Button, TextField } from "../../components/ui";
import AiRoleDetail from "./AiRoleDetail";
import type { RowActions } from "./model";
import type { Roster, RosterPerson } from "./roster";

/** What belongs to a person as a whole, not to one space: an invite that is
 *  still waiting, handing the workspace over, leaving it, or an AI role's
 *  running and keys. Only the owner changes any of it. */
export default function PersonDetail({ person, roster, spaces, editable, online, actions, onTransfer }: {
  person: RosterPerson;
  roster: Roster;
  spaces: Space[];
  editable: boolean;
  online: boolean;
  actions: RowActions;
  onTransfer: () => void;
}) {
  const t = useT();
  if (person.type === "agent") {
    return (
      <>
        <AiRoleDetail person={person} roster={roster} spaces={spaces} editable={editable} online={online} actions={actions} />
        {editable && <RemoveButton person={person} online={online} actions={actions} />}
      </>
    );
  }
  return (
    <div className="person-detail">
      {person.isOwner && <p className="member-hint">{t("The owner manages every space and member and can't be removed.")}</p>}
      {editable && person.invitePending && <InviteLine person={person} online={online} actions={actions} />}
      {editable && person.isOwner && (
        <Button variant="danger" size="sm" onClick={onTransfer}>{t("Transfer ownership…")}</Button>
      )}
      {editable && !person.isOwner && <RemoveButton person={person} online={online} actions={actions} />}
    </div>
  );
}

function RemoveButton({ person, online, actions }: { person: RosterPerson; online: boolean; actions: RowActions }) {
  const t = useT();
  return (
    <Button variant="ghost" size="sm" className="member-remove" disabled={!online}
      aria-label={t("Remove {name}", { name: person.name })} onClick={() => void actions.remove(person)}>
      <Trash2 size={13} aria-hidden="true" /> {t("Move out of the workspace…")}
    </Button>
  );
}

function InviteLine({ person, online, actions }: { person: RosterPerson; online: boolean; actions: RowActions }) {
  const t = useT();
  const link = actions.inviteLinks[person.id];
  const expired = !!person.inviteExpiresAt && new Date(person.inviteExpiresAt).getTime() <= Date.now();
  return (
    <div className="member-invite">
      {link && (
        <div className="member-invite-link">
          <TextField readOnly value={link} aria-label={t("Invite link for {name}", { name: person.name })} onFocus={(e) => e.currentTarget.select()} />
          <Button variant="secondary" size="sm" onClick={() => void actions.copyInvite(person)}>{t("Copy invite link")}</Button>
        </div>
      )}
      <Button variant="ghost" size="sm" disabled={!online} onClick={() => void actions.regenerateInvite(person)}>{t("Make a new invite link")}</Button>
      <p className="member-hint">
        {link ? t("Send this link to them. It is shown only now, works once, and only for {email}.", { email: person.inviteEmail ?? "" })
          : expired ? t("The invite link expired. Make a new one to send.")
          : t("The invite link is shown only when it is made. Make a new one to get it again.")}
      </p>
    </div>
  );
}
