// Moving notes that are marked for the site into a space that publishes: the
// one action behind both the publish dialog's "left out" list and the note's
// Share menu. Nothing moves until `move()` is called, after `ask()` has shown
// who gains access (spaces.md: a move changes who can read the note).
import { useState } from "react";
import { addToast } from "../../lib/appStore";
import { writeErrors } from "../../lib/data";
import { useCapabilities } from "../../lib/capabilities";
import { moveToSpace } from "../../lib/moveToSpace";
import { spaceApi, spaceLabel, useSpaces, type MovePreviewNumericEpoch, type Space } from "../../lib/spaces";

/** A note to move and the space it is in now. */
export type MoveCandidate = { nodeId: string; fromSpaceId: string };

export function usePublishMove(candidates: readonly MoveCandidate[], online: boolean, onMoved: () => void) {
  const { spaces } = useSpaces(online);
  const caps = useCapabilities(online);
  const [gain, setGain] = useState<MovePreviewNumericEpoch["gain"] | null>(null);
  const [working, setWorking] = useState(false);

  // A space that publishes and that I can write in; the default one ("Everyone")
  // first, as it is where a site's notes usually live.
  const destination: Space | undefined = spaces
    .filter((s) => s.kind === "shared" && s.capabilities.publish === true && caps.canMoveInto(s))
    .sort((a, b) => Number(b.is_default) - Number(a.is_default))[0];

  /** Look at who would gain access; the confirmation is shown from `gain`. */
  async function ask() {
    if (!destination || candidates.length === 0) return;
    setWorking(true);
    try {
      // Who gains depends on the space a note leaves: one look per source space.
      const firstPerSource = [...new Map(candidates.map((c) => [c.fromSpaceId, c.nodeId])).values()];
      const previews = await Promise.all(firstPerSource.map((id) => spaceApi.previewMove(id, destination.id)));
      const people = previews.flatMap((p) => p.gain.filter((m) => m.type !== "agent"));
      setGain([...new Map(people.map((m) => [m.id, m])).values()]);
    } catch (error) { writeErrors.report(error, addToast); }
    finally { setWorking(false); }
  }

  async function move() {
    if (!destination) return;
    setWorking(true);
    try {
      const { moved } = await moveToSpace(candidates.map((c) => c.nodeId), destination.id);
      if (moved > 0) onMoved();
    } finally { setWorking(false); setGain(null); }
  }

  return {
    destination, destinationName: destination ? spaceLabel(destination) : "",
    gain, working, ask, move, cancel: () => setGain(null),
  };
}
