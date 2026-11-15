import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { copyText } from "../../lib/clipboard";
import { ChevronLeft } from "lucide-react";

import { addToast } from "../../lib/appStore";
import { sendWrite, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { inviteLinkFor } from "../../lib/invite";
import { spaceFilterStore } from "../../lib/settingsRequest";
import { refreshSpaces, spaceApi, spaceLabel, useSpaces, type Space } from "../../lib/spaces";
import { canManageSpace, useIsOwner } from "../../lib/capabilities";
import { confirmDialog } from "../../components/ConfirmDialog";
import { Button } from "../../components/ui";
import type { SettingContext } from "../../lib/settingsTypes";
import type { NewPerson } from "./AddMemberForm";
import { useAiEnabled } from "../../hooks/useModuleFilter";
import PeopleList from "./PeopleList";
import PersonDetail from "./PersonDetail";
import { useAllowAiRead, useStandingWriter } from "../ai";
import SpaceList from "./SpaceList";
import SpaceSwitches from "./SpaceSwitches";
import TransferOwnershipDialog from "./TransferOwnershipDialog";
import type { ListContext, RowActions } from "./model";
import { loadMemberRoster, loadOwnerRoster, presenceIn, type Roster, type RosterPerson } from "./roster";
import { useSelectionSentence } from "./sentences";
import { useElementSize } from "../../hooks/useElementSize";
import "./SpacesAndMembers.css";

/** Wide enough for two columns, in px of the content area (not the window). */
const TWO_COLUMNS_MIN = 760;

// Settings › 空間與成員 (docs/agents/decisions-ui.md「空間與成員」).
// Two lists that follow each other: spaces and people (AI roles are people
// here). Select a space and the people list shows who is in it, each with a
// permission menu; select a person and the spaces list shows where they are.
// On a narrow content area the same lists are two layers: the lists, then a
// page for the one selected. A member sees the same lists read-only. Shortcuts
// (a note's space chip, a move) select a space (lib/settingsRequest.ts).
export default function SpacesAndMembers({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const sentence = useSelectionSentence();
  const isOwner = useIsOwner();
  const { spaces, loaded } = useSpaces(ctx.online);
  const requestedId = useSyncExternalStore(spaceFilterStore.subscribe, spaceFilterStore.get);
  // Not laid out yet counts as wide, so the first paint is the full layout.
  const [layoutNode, setLayoutNode] = useState<HTMLElement | null>(null);
  const layoutWidth = useElementSize(layoutNode)?.width ?? 0;
  const wide = layoutWidth === 0 || layoutWidth >= TWO_COLUMNS_MIN;
  const aiOn = useAiEnabled();
  const [loadedRoster, setRoster] = useState<Roster | null>(null);
  // AI off: its roles are not listed here (they stay, with their keys and sessions).
  const roster = useMemo<Roster | null>(
    () => (loadedRoster && !aiOn ? { ...loadedRoster, people: loadedRoster.people.filter((p) => p.type !== "agent") } : loadedRoster),
    [loadedRoster, aiOn],
  );
  const [failed, setFailed] = useState(false);
  const [transferring, setTransferring] = useState(false);
  // Which space and which person are selected. A person selected wins the other
  // column; the space stays remembered so selecting the same person again goes back to it.
  // `page` is only the narrow layout's second layer.
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [page, setPage] = useState(false);
  // The invite links made on this page, by person: the server shows one once.
  const [links, setLinks] = useState<Record<string, string>>({});
  const myId = spaces.find((s) => s.kind === "personal")?.owner_actor_id ?? null;

  const reload = useCallback(async () => {
    try {
      setRoster(isOwner ? await loadOwnerRoster() : await loadMemberRoster(spaces, myId));
      setFailed(false);
    } catch { setFailed(true); }
  }, [isOwner, spaces, myId]);
  const reloadNow = useRef(reload);
  reloadNow.current = reload;
  useEffect(() => { if (ctx.online && loaded) void reload(); }, [ctx.online, loaded, reload]);

  useEffect(() => {
    if (!requestedId) return;
    if (loaded) { setSpaceId(requestedId); setPersonId(null); setPage(true); }
    spaceFilterStore.clear();
  }, [requestedId, loaded]);

  const selectedSpace: Space | null = spaces.find((s) => s.id === spaceId) ?? spaces.find((s) => s.is_default && s.kind === "shared") ?? spaces[0] ?? null;

  const standing = useStandingWriter({
    previousOf: (personId, space) => {
      const who = roster?.people.find((p) => p.id === personId);
      const before = roster && who ? presenceIn(roster, who, space) : "none";
      return before === "owner" ? "edit" : before;
    },
    reload: () => reloadNow.current(),
  });
  const { change: changeStanding, busyCell } = standing;
  const allowAiRead = useAllowAiRead(() => reloadNow.current());

  const actions: RowActions = {
    changeStanding,
    allowAiRead: async (space) => { await allowAiRead(space); },
    async remove(person) {
      const message = person.type === "agent"
        ? t("Remove {name}? Its keys stop working and it leaves every space.", { name: person.name })
        : t("Remove {name}? They leave every space and can no longer sign in to this workspace.", { name: person.name });
      if (!(await confirmDialog(message, { confirmLabel: t("Remove"), danger: true }))) return;
      try { await sendWrite("DELETE", `/api/actors/${person.id}`); await refreshSpaces(); setPersonId(null); setPage(false); }
      catch (error) { writeErrors.report(error, addToast); }
      await reload();
    },
    inviteLinks: links,
    async regenerateInvite(person) {
      if (!(await confirmDialog(t("Make a new invite link for {name}? The old link stops working.", { name: person.name }), { confirmLabel: t("Make a new invite link") }))) return;
      try {
        const reply = await sendWrite<{ invite_path?: string }>("POST", `/api/actors/${person.id}/invite`, {});
        if (reply?.invite_path) setLinks((prev) => ({ ...prev, [person.id]: inviteLinkFor(reply.invite_path!) }));
      } catch (error) { writeErrors.report(error, addToast); }
      await reload();
    },
    async copyInvite(person) {
      await copyText(links[person.id]!, { what: "link" });
    },
    reload: () => void reload(),
  };

  /** Invite the person, then put them in the chosen spaces. If a space fails,
   *  the person exists and the spaces list offers the fix in place. */
  async function invite(person: NewPerson): Promise<boolean> {
    let created: { id?: string; invite_path?: string };
    try {
      created = await sendWrite<{ id?: string; invite_path?: string }>("POST", "/api/actors", { name: person.name, type: "human", email: person.email });
    } catch (error) { writeErrors.report(error, addToast); return false; }
    if (!created?.id) { await reload(); return true; }
    if (created.invite_path) setLinks((prev) => ({ ...prev, [created.id!]: inviteLinkFor(created.invite_path!) }));
    try {
      for (const s of person.standings) await spaceApi.setMember(s.spaceId, created.id, s.permission);
      await refreshSpaces();
    } catch (error) {
      writeErrors.report(error, addToast);
      addToast(t("{name} was added, but not to every space you chose. Select them to check their spaces.", { name: person.name }), "error");
    }
    await reload();
    return true;
  }

  const ordered = useMemo(() => {
    const people = roster?.people ?? [];
    const rank = (p: RosterPerson) => (p.type === "agent" ? 2 : p.isOwner || p.id === roster?.meId ? 0 : 1);
    return [...people].sort((a, b) => rank(a) - rank(b));
  }, [roster]);

  if (!ctx.online) return <p className="setting-note">{t("Connect to manage spaces and members.")}</p>;
  if (failed && !roster) {
    return (
      <div className="spaces-and-members">
        <p className="setting-note" role="alert">{t("Could not load the spaces and members.")}</p>
        <Button variant="secondary" size="sm" onClick={() => void reload()}>{t("Try again")}</Button>
      </div>
    );
  }
  if (!roster) return <p className="setting-note">{t("Loading…")}</p>;

  const person = ordered.find((p) => p.id === personId) ?? null;
  const heirs = roster.people.filter((p) => p.type === "human" && !p.isOwner && p.signedIn && !p.invitePending);
  const list: ListContext = { roster, editable: isOwner, online: ctx.online, busyCell, actions };
  const defaultSpaceId = selectedSpace?.kind === "shared" ? selectedSpace.id : undefined;
  const pickSpace = (space: Space) => { setSpaceId(space.id); setPersonId(null); setPage(true); };
  const pickPerson = (who: RosterPerson) => { setPersonId(wide && who.id === personId ? null : who.id); setPage(true); };
  const back = () => { setPage(false); setPersonId(null); };
  const detail = (who: RosterPerson) => (
    <PersonDetail person={who} roster={roster} spaces={spaces} editable={isOwner} online={ctx.online} actions={actions} onTransfer={() => setTransferring(true)} />
  );
  const switches = selectedSpace && canManageSpace(selectedSpace) ? <SpaceSwitches key={selectedSpace.id} space={selectedSpace} onChanged={() => void reload()} /> : null;
  const memberList = (space: Space | null, withDetail: boolean) => (
    <PeopleList {...list} people={ordered} space={space} selectedId={withDetail ? personId : null} detail={withDetail ? detail : undefined}
      defaultSpaceId={defaultSpaceId} onSelect={pickPerson} onInvite={invite} onAiCreated={() => void reload()} />
  );
  const spaceList = (who: RosterPerson | null) => (
    <SpaceList {...list} spaces={spaces} selectedId={who || (!wide && !page) ? null : selectedSpace?.id ?? null} person={who} onSelect={pickSpace}
      onCreated={(id) => { setSpaceId(id); setPersonId(null); }} />
  );
  const lead = person ? sentence.person(roster, person, spaces) : selectedSpace ? sentence.space(roster, selectedSpace) : "";

  let body;
  if (wide) {
    body = (
      <div className="sm-cols">
        <section className="sm-col" aria-label={t("Spaces")}>
          <h3>{t("Spaces")}</h3>
          {spaceList(person)}
          {!person && switches}
        </section>
        <section className="sm-col" aria-label={person ? t("Members") : t("Who is in {space}", { space: selectedSpace ? spaceLabel(selectedSpace) : "" })}>
          <h3>{person || !selectedSpace ? t("Members") : t("Who is in {space}", { space: spaceLabel(selectedSpace) })}</h3>
          {memberList(person ? null : selectedSpace, true)}
        </section>
      </div>
    );
  } else if (page && person) {
    body = (
      <section className="sm-page" aria-label={person.name}>
        <BackButton onBack={back} />
        <h3>{person.name}</h3>
        <p className="sm-sentence" role="status">{lead}</p>
        {spaceList(person)}
        {detail(person)}
      </section>
    );
  } else if (page && selectedSpace) {
    body = (
      <section className="sm-page" aria-label={spaceLabel(selectedSpace)}>
        <BackButton onBack={back} />
        <h3>{spaceLabel(selectedSpace)}</h3>
        <p className="sm-sentence" role="status">{lead}</p>
        {memberList(selectedSpace, false)}
        {switches}
      </section>
    );
  } else {
    body = (
      <>
        <section className="sm-section" aria-label={t("Spaces")}><h3>{t("Spaces")}</h3>{spaceList(null)}</section>
        <section className="sm-section" aria-label={t("Members")}><h3>{t("Members")}</h3>{memberList(null, false)}</section>
      </>
    );
  }

  return (
    <div className="spaces-and-members" ref={setLayoutNode} data-layout={wide ? "wide" : "narrow"}>
      <p className="setting-note">{t("The space a note is in decides who can see it.")}</p>
      {wide && lead && <p className="sm-sentence" role="status">{lead}</p>}
      {body}
      {transferring && <TransferOwnershipDialog candidates={heirs} onClose={() => setTransferring(false)} />}
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  const t = useT();
  return <Button variant="ghost" size="sm" className="sm-back" onClick={onBack}><ChevronLeft size={14} aria-hidden="true" /> {t("Back")}</Button>;
}
