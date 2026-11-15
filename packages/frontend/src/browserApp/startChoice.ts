// Whether the browser app's page opens on the choice "use it here / use it temporarily on this computer" (StartChoice).
// Only on a first visit: a build made with --start-choice, a browser that has no notes of ours (a returning person goes
// straight in), and an address that did not already decide (`?temp=1` is the temporary session, `?app=1` the ordinary one).
export function needsStartChoice(facts: { enabled: boolean; temporary: boolean; askedForApp: boolean; hadNotes: boolean }): boolean {
  return facts.enabled && !facts.temporary && !facts.askedForApp && !facts.hadNotes;
}
