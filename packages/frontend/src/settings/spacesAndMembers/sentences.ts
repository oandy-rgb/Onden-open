import { useT, tn } from "../../lib/i18n";
import type { Space } from "../../lib/spaces";
import { inSpace, spaceCountOf, type Roster, type RosterPerson } from "./roster";

const NAMES_SHOWN = 3;

/** The one plain sentence above the columns: who sees the space that is
 *  selected, or how many spaces the person that is selected is in. */
export function useSelectionSentence() {
  const t = useT();
  const names = (list: RosterPerson[]) => list.length <= NAMES_SHOWN + 1
    ? list.map((p) => p.name).join(t(", "))
    : t("{names} and {n} more", { names: list.slice(0, NAMES_SHOWN).map((p) => p.name).join(t(", ")), n: list.length - NAMES_SHOWN });
  return {
    space(roster: Roster, space: Space): string {
      if (space.kind === "personal") return t("Only you can see this. People you invite can't either.");
      const others = inSpace(roster, space).filter((p) => p.id !== roster.meId);
      if (others.length === 0) return t("Only you for now. Once you add someone, they can see these notes.");
      return t("You and {names} can see the notes here.", { names: names(others) });
    },
    person(roster: Roster, person: RosterPerson, spaces: readonly Space[]): string {
      const n = spaceCountOf(roster, person, spaces);
      return n === 0 ? t("{name}: not in any space", { name: person.name })
        : tn("{name}: in 1 space", "{name}: in {n} spaces", n, { name: person.name });
    },
  };
}

/** A space's one line under its name in the list. */
export function useAudienceText() {
  const t = useT();
  return (roster: Roster, space: Space): string => {
    if (space.kind === "personal") return t("Only you");
    const others = inSpace(roster, space).filter((p) => p.id !== roster.meId);
    const mine = inSpace(roster, space).some((p) => p.id === roster.meId);
    if (others.length === 0) return mine ? t("Only you") : t("Nobody yet");
    return !mine ? t("{n} people", { n: others.length })
      : tn("You and 1 other", "You and {n} others", others.length);
  };
}
