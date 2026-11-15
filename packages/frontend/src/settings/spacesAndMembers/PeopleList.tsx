import { useState, type ReactNode } from "react";
import { Bot, Plus, UserPlus } from "lucide-react";
import { cutToGraphemes } from "@onden/markdown";

import { useT } from "../../lib/i18n";
import { spaceLabel, type Space } from "../../lib/spaces";
import { Menu, MenuItem, usePopover, Button, Pressable } from "../../components/ui";
import AddAiRoleWizard from "./AddAiRoleWizard";
import AddMemberForm, { type NewPerson } from "./AddMemberForm";
import { PermissionControl } from "../ai";
import { presenceIn, type RosterPerson } from "./roster";
import type { ListContext } from "./model";
import { useAiEnabled } from "../../hooks/useModuleFilter";

/** The people and AI roles, one row each. With `space` the right side is each
 *  one's standing there, and those who are not in it sit under a small divider
 *  with 「加入」; without, the rows only select, and the selected one opens
 *  `detail` right under it. The last row invites someone or adds an AI role. */
export default function PeopleList({ people, space, selectedId, detail, defaultSpaceId, onSelect, onInvite, onAiCreated, ...ctx }: ListContext & {
  people: RosterPerson[];
  space: Space | null;
  selectedId: string | null;
  detail?: (person: RosterPerson) => ReactNode;
  defaultSpaceId?: string;
  onSelect: (person: RosterPerson) => void;
  onInvite: (person: NewPerson) => Promise<boolean>;
  onAiCreated: () => void;
}) {
  const t = useT();
  const here = space ? people.filter((p) => presenceIn(ctx.roster, p, space) !== "none") : people;
  const away = space ? people.filter((p) => presenceIn(ctx.roster, p, space) === "none") : [];
  const row = (person: RosterPerson) => <MemberRow key={person.id} person={person} space={space} selected={person.id === selectedId} detail={detail} onSelect={onSelect} {...ctx} />;
  return (
    <>
      <ul className="sm-list" aria-label={space ? t("Who is in {space}", { space: spaceLabel(space) }) : t("Members")}>
        {here.map(row)}
        {space && (away.length > 0 || space.kind === "personal") && (
          <li className="sm-divider">{space.kind === "personal" ? t("This is your own space. You can't add people.") : t("Not here")}</li>
        )}
        {away.map(row)}
        {ctx.editable && <AddRow roster={ctx.roster} online={ctx.online} defaultSpaceId={defaultSpaceId} onInvite={onInvite} onAiCreated={onAiCreated} />}
      </ul>
    </>
  );
}

function MemberRow({ person, space, selected, detail, onSelect, roster, editable, online, busyCell, actions }: ListContext & {
  person: RosterPerson;
  space: Space | null;
  selected: boolean;
  detail?: (person: RosterPerson) => ReactNode;
  onSelect: (person: RosterPerson) => void;
}) {
  const t = useT();
  const presence = space ? presenceIn(roster, person, space) : null;
  const ai = person.type === "agent";
  return (
    <li className={presence === "none" ? "sm-row is-away" : "sm-row"} data-person-type={person.type}>
      <Pressable className="sm-row-main" aria-current={selected ? "true" : undefined} onClick={() => onSelect(person)}>
        <span className={ai ? "sm-avatar sm-avatar--ai" : "sm-avatar"} aria-hidden="true">{cutToGraphemes(person.name, 1)}</span>
        <span className="sm-row-text">
          <span className="sm-row-name member-name">{person.name}</span>
          {(ai || person.invitePending) && <span className="sm-row-sub">{person.invitePending ? t("Invited, not signed in yet") : t("AI role")}</span>}
        </span>
      </Pressable>
      {space && presence === "owner" && <span className="standing standing--owner">{t("Owner")}</span>}
      {space && (presence === "view" || presence === "edit") && (
        <PermissionControl label={t("{name} in {space}", { name: person.name, space: spaceLabel(space) })} name={person.name}
          value={presence} readOnly={!editable || !online} busy={busyCell === `${person.id}:${space.id}`}
          onChange={(next) => void actions.changeStanding(person, space, next)} />
      )}
      {space && presence === "none" && editable && space.kind === "shared" && (
        <Button variant="secondary" size="sm" disabled={!online || busyCell === `${person.id}:${space.id}`}
          aria-label={t("Add {name} to {space}", { name: person.name, space: spaceLabel(space) })}
          onClick={() => void actions.changeStanding(person, space, ai ? "view" : "edit")}>
          {t("Add")}
        </Button>
      )}
      {selected && detail && <div className="sm-row-detail">{detail(person)}</div>}
    </li>
  );
}

/** 「＋ 邀請成員或加入 AI」: a menu of the two, and the form for the one chosen. */
function AddRow({ roster, online, defaultSpaceId, onInvite, onAiCreated }: {
  roster: ListContext["roster"]; online: boolean; defaultSpaceId?: string;
  onInvite: (person: NewPerson) => Promise<boolean>; onAiCreated: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<"person" | "ai" | null>(null);
  const aiOn = useAiEnabled();
  const menu = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false) });
  if (adding === "person") {
    return <li className="sm-row sm-row--form"><AddMemberForm spaces={roster.spaces} online={online} defaultSpaceId={defaultSpaceId} onAdd={onInvite} onCancel={() => setAdding(null)} /></li>;
  }
  if (adding === "ai") {
    return <li className="sm-row sm-row--form"><AddAiRoleWizard spaces={roster.spaces} online={online} defaultSpaceId={defaultSpaceId} onCreated={onAiCreated} onCancel={() => setAdding(null)} /></li>;
  }
  return (
    <li className="sm-row sm-row--add">
      {aiOn ? (
        <Pressable ref={menu.anchor} className="sm-row-main" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Plus size={16} aria-hidden="true" className="sm-row-icon" /> {t("Invite a member or add an AI")}
        </Pressable>
      ) : (
        <Pressable className="sm-row-main" onClick={() => setAdding("person")}>
          <Plus size={16} aria-hidden="true" className="sm-row-icon" /> {t("Invite a person")}
        </Pressable>
      )}
      {aiOn && open && (
        <Menu popover={menu} label={t("Invite a member or add an AI")}>
          <MenuItem onSelect={() => setAdding("person")}><UserPlus size={14} aria-hidden="true" /> {t("Invite a person")}</MenuItem>
          <MenuItem onSelect={() => setAdding("ai")}><Bot size={14} aria-hidden="true" /> {t("Add an AI role")}</MenuItem>
        </Menu>
      )}
    </li>
  );
}
