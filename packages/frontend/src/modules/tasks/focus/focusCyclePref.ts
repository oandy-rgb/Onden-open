// The cycle the next focus starts with. Lives with the lazy screens (only the start sheet reads it), so the boot bundle does not carry it.

import { createAccountPref } from "../../../lib/accountPrefStore";
import { PREFS } from "../../../lib/prefs";
import { parseFocusCycle, type FocusCycleSetting } from "../../../lib/focus";

/** The cycle (focus → break → focus …) the next focus starts with; none: one focus at a time. */
export const focusCyclePref = createAccountPref<FocusCycleSetting>({
  serverKey: "focusCycle",
  follows: "account", // a habit like the length: the same on every screen
  copy: PREFS.focusCycleCopy,
  parse: parseFocusCycle,
});

