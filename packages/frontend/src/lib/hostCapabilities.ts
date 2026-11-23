// What the environment this page runs in can do at all — not what the person may do (that is lib/capabilities.ts,
// the server's permissions). The web and installed apps talk to a real server: accounts, other members and the
// membership check exist there. The local edition (src/browserApp: the backend in this browser, one person, no
// sign-in, nothing synced) has none of them, so their screens and the gate that waits for a membership check must
// not appear. One question for every caller instead of each screen guessing from something else (a session, a URL,
// a build flag).
//
// The answer is fixed for the life of the page: the shell that keeps the notes only on this device declares it
// (lib/localOnlyStatus.ts declareLocalOnlyHost) before it mounts the app, so code that runs before any screen — the
// sync engine raising the gate at boot — reads the same answer as the screens do.

import { isLocalOnlyHost } from "./localOnlyStatus";

type HostCapability =
  /** Signing in, signing out, switching account. */
  | "accounts"
  /** Other people: members, invites, sharing a space. */
  | "members"
  /** The workspace waits for the read-membership check (lib/data/syncEngine.ts, AppState.membershipGated). */
  | "membershipCheck";

/** Whether this environment has `capability`. */
export function hostCan(capability: HostCapability): boolean {
  switch (capability) {
    case "accounts":
    case "members":
    case "membershipCheck":
      // One person, one copy of the notes, no server to ask who else may read them.
      return !isLocalOnlyHost();
  }
}
