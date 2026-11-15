// The one picture 「空間與成員」 draws: every person and AI helper as a row, and
// for each shared space what they may do there. The owner's picture comes from
// two reads (the overview of spaces, the roster of people); anyone else sees
// the people who share their spaces, read-only. Personal spaces never appear.

import { reads } from "../../lib/data";
import { spaceApi, type Space } from "../../lib/spaces";
import type { SpaceOverview, SpacePermission } from "@onden/contract";
import type { EffectiveReach } from "@onden/contract";

export type RosterSpace = Pick<Space, "id" | "name" | "is_default" | "capabilities"> & { kind: "shared" };

export type RosterPerson = {
  id: string;
  name: string;
  type: "human" | "agent";
  isOwner: boolean;
  /** Invited by email; nobody has signed in with that address yet. */
  invitePending: boolean;
  inviteEmail: string | null;
  inviteExpiresAt: string | null;
  /** Their permission in each shared space they are in; absent = 不在. */
  permissions: Record<string, SpacePermission>;
  /** AI helpers: live keys, and how many of them can write. */
  liveKeys: number;
  writeKeys: number;
  /** AI helpers: why it cannot read or write in a space it is in. */
  reach: Record<string, { read: EffectiveReach; write: EffectiveReach }>;
  /** Has signed in at least once (an invited person has not; ownership can only go to one who has). */
  signedIn: boolean;
};

/** `meId`: the person looking at this screen (the owner, or a member's own id). */
export type Roster = { spaces: RosterSpace[]; people: RosterPerson[]; ownerId: string | null; meId: string | null };

/** What `GET /api/actors` returns that this page uses. */
export type ActorRow = {
  id: string;
  name: string;
  type: "human" | "agent";
  external_id: string | null;
  is_owner?: boolean;
  is_system?: boolean;
  invite_email?: string | null;
  invite_pending?: boolean;
  invite_expires_at?: string | null;
};

/** The owner's roster from the two reads. The built-in System account is not a
 *  person here, and a person nobody put in a space is still a row. */
export function ownerRoster(overview: SpaceOverview, actors: ActorRow[]): Roster {
  const permissions = new Map<string, Record<string, SpacePermission>>();
  const reach = new Map<string, RosterPerson["reach"]>();
  for (const space of overview.spaces) {
    for (const m of space.members) {
      permissions.set(m.actor_id, { ...permissions.get(m.actor_id), [space.id]: m.permission });
      if (m.effective) reach.set(m.actor_id, { ...reach.get(m.actor_id), [space.id]: m.effective });
    }
  }
  const keys = new Map(overview.agents.map((a) => [a.actor_id, a]));
  return {
    ownerId: overview.owner_id,
    meId: overview.owner_id,
    spaces: overview.spaces.map(({ id, name, is_default, capabilities }) => ({ id, name, is_default, capabilities, kind: "shared" as const })),
    people: actors.filter((a) => !a.is_system).map((a) => ({
      id: a.id, name: a.name, type: a.type,
      isOwner: a.is_owner === true || a.id === overview.owner_id,
      invitePending: a.invite_pending === true,
      inviteEmail: a.invite_email ?? null,
      inviteExpiresAt: a.invite_expires_at ?? null,
      permissions: permissions.get(a.id) ?? {},
      liveKeys: keys.get(a.id)?.live_tokens ?? 0,
      writeKeys: keys.get(a.id)?.write_tokens ?? 0,
      reach: reach.get(a.id) ?? {},
      signedIn: a.external_id !== null,
    })),
  };
}

export async function loadOwnerRoster(): Promise<Roster> {
  const [overview, actors] = await Promise.all([spaceApi.overview(), reads.people.actors<ActorRow>()]);
  return ownerRoster(overview, actors);
}

const rank = (p: RosterPerson, myId: string | null) => (p.id === myId ? 0 : p.type === "human" ? 1 : 2);

/** Everyone else's picture: the people in the shared spaces I am in, read-only. */
export async function loadMemberRoster(spaces: readonly Space[], myId: string | null): Promise<Roster> {
  const shared = spaces.filter((s) => s.kind === "shared");
  const lists = await Promise.all(shared.map((s) => spaceApi.members(s.id)));
  const people = new Map<string, RosterPerson>();
  shared.forEach((space, i) => {
    for (const m of lists[i]!) {
      const person = people.get(m.id) ?? {
        id: m.id, name: m.name, type: m.type, isOwner: false, invitePending: false, inviteEmail: null, inviteExpiresAt: null,
        permissions: {}, liveKeys: 0, writeKeys: 0, reach: {}, signedIn: true,
      };
      person.permissions[space.id] = m.permission;
      people.set(m.id, person);
    }
  });
  return {
    ownerId: null,
    meId: myId,
    spaces: shared.map(({ id, name, is_default, capabilities }) => ({ id, name, is_default, capabilities, kind: "shared" as const })),
    // Me first, then people, then AI helpers.
    people: [...people.values()].sort((a, b) => rank(a, myId) - rank(b, myId)),
  };
}

/** The shared spaces a person has a membership in. */
export const spacesOf = (person: RosterPerson): string[] => Object.keys(person.permissions);

/** A space as the list knows it: shared spaces from the roster, my own personal one. */
export type SpaceRef = Pick<Space, "id" | "kind">;

/** Where a person stands in a space. The owner is in every shared space and
 *  only me is in my personal one, neither through a membership row. */
export type Presence = "owner" | SpacePermission | "none";

export function presenceIn(roster: Roster, person: RosterPerson, space: SpaceRef): Presence {
  if (space.kind === "personal") return person.id === roster.meId ? "owner" : "none";
  if (person.isOwner) return "owner";
  return person.permissions[space.id] ?? "none";
}

/** The people and AI roles that can see a space, the viewer first. */
export function inSpace(roster: Roster, space: SpaceRef): RosterPerson[] {
  return roster.people.filter((p) => presenceIn(roster, p, space) !== "none");
}

/** How many spaces a person is in, out of the ones listed. */
export function spaceCountOf(roster: Roster, person: RosterPerson, spaces: readonly SpaceRef[]): number {
  return spaces.filter((s) => presenceIn(roster, person, s) !== "none").length;
}
