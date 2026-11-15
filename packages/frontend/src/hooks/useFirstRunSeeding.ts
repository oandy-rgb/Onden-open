import { randomUUID } from "../lib/uuid";
import { useEffect, useRef } from "react";
import { useAppSelector, useOnline } from "../lib/appStore";
import { noteWriter } from "../lib/data";
import { beginFirstRunLanding, finishFirstRunLanding } from "../lib/firstRunLanding";
import { PREFS, getPref, prefsAvailable, setPref } from "../lib/prefs";

/** A brand-new workspace's first run: a truly empty workspace gets a few
 *  example notes that teach Onden. Features are imported in Settings ›
 *  Modules only (there is no first-run picker). */
export function useFirstRunSeeding({ refresh }: { refresh: () => Promise<void> }): void {
  const bootstrapped = useAppSelector((s) => s.bootstrapped);
  const online = useOnline();
  const membershipGated = useAppSelector((s) => s.membershipGated);
  const exampleSeedEligible = useAppSelector((s) => s.data.example_seed_eligible);
  const nodeCount = useAppSelector((s) => s.data.nodes.length);

  // First-run onboarding seed (pattern: super-productivity example-tasks, MIT).
  // On a TRULY empty workspace, plant a handful of ordinary, editable notes
  // whose BODY teaches Onden (src/data/exampleNotes.ts). They are created via
  // the same offline-aware note writer the New button uses — never a raw fetch.
  //
  // The seed is gated to fire exactly once and never again:
  //   1. A fresh server eligibility hint AND settled membership, online and
  //      empty. A scoped actor's empty projection is NOT a new workspace;
  //      neither a local cache nor an older server can opt into auto-creation.
  //   2. The `onden.exampleSeeded` guard (PREFS.exampleSeeded) — set as soon as we
  //      begin, so deleting the examples (or a reload) never re-seeds.
  //   3. A Settings-independent opt-out: `onden.exampleSeed=off` disables it
  //      entirely (power users / automated setups can pre-set this).
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (!bootstrapped || !online || membershipGated || exampleSeedEligible !== true) return;
    if (nodeCount !== 0) return;
    // Storage blocked — treat as already-seeded, never seed.
    if (!prefsAvailable(PREFS.exampleSeeded)) return;
    if (getPref(PREFS.exampleSeeded) === "1" || getPref(PREFS.exampleSeedOptOut) === "off") { seededRef.current = true; return; }
    // Claim the seed synchronously BEFORE any await so a re-render / second
    // mount can't race a duplicate batch (idempotent by construction).
    seededRef.current = true;
    setPref(PREFS.exampleSeeded, "1"); // best-effort
    beginFirstRunLanding();
    void (async () => {
      let welcomeNoteId: string | null = null;
      const { getExampleNotes } = await import("../data/exampleNotes"); // the teaching notes load only for a first run
      for (const ex of getExampleNotes()) {
        // One create with the teaching body: the note writer mints the id
        // (its Idempotency-Key) and queues offline. A separate body write
        // after the create could find the note gone from the store when a
        // refresh landed in between, leaving an empty example; and the
        // examples arrive without a 「已建立」 toast each.
        const id = randomUUID();
        const created = await noteWriter.create({ id, title: ex.title, markdown: ex.markdown }).catch(() => null);
        if (created && !welcomeNoteId) welcomeNoteId = id; // the first example opens on first launch
      }
      await refresh().catch(() => {});
      finishFirstRunLanding(welcomeNoteId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot; guarded by seededRef + the localStorage flag, keyed on the loaded-&-empty signal
  }, [bootstrapped, online, membershipGated, exampleSeedEligible, nodeCount]);
}
