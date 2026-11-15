// A skill button in a note's header (modules/skills) asks the open note's
// editor to write `@ai /[[skill]]` and send it. The editor (OverviewEditor)
// owns the text and the sending, the module owns the button, and core may not
// name a module: so the button calls this, and the editor listens.

type Listener = (skillTitle: string) => void;
const listeners = new Map<string, Listener>();

/** The editor of note `nodeId` takes hand-offs while it is open. Returns the stop function. */
export function listenForHandOff(nodeId: string, listener: Listener): () => void {
  listeners.set(nodeId, listener);
  return () => { if (listeners.get(nodeId) === listener) listeners.delete(nodeId); };
}

/** Ask note `nodeId`'s editor to hand the note to the AI with this skill.
 *  False when no editor has the note open (nothing was written or sent). */
export function requestHandOff(nodeId: string, skillTitle: string): boolean {
  const listener = listeners.get(nodeId);
  if (!listener) return false;
  listener(skillTitle);
  return true;
}
