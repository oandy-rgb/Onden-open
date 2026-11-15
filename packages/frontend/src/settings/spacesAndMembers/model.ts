import type { Space } from "../../lib/spaces";
import type { Standing } from "../ai";
import type { Roster, RosterPerson } from "./roster";

/** What the screen can do to a person or a space. One set for both columns and
 *  both layers, so every way to change a standing says and undoes the same. */
export type RowActions = {
  /** Applies at once, then says what happened with a 復原. */
  changeStanding: (person: RosterPerson, space: Space, standing: Standing) => Promise<void>;
  allowAiRead: (space: Space) => Promise<void>;
  /** Out of the whole workspace; asks first. */
  remove: (person: RosterPerson) => Promise<void>;
  /** The one-time invite links this page made, by person, while they are still in memory. */
  inviteLinks: Record<string, string>;
  regenerateInvite: (person: RosterPerson) => Promise<void>;
  copyInvite: (person: RosterPerson) => Promise<void>;
  reload: () => void;
};

/** What every list needs to draw itself and act. */
export type ListContext = {
  roster: Roster;
  /** The owner changes things; a member sees the same lists read-only. */
  editable: boolean;
  online: boolean;
  /** `personId:spaceId` of the standing being written. */
  busyCell: string | null;
  actions: RowActions;
};
