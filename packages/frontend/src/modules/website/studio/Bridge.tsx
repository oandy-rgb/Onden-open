import { useEffect, useRef } from "react";
import { createUsePuck, type PuckAction } from "@puckeditor/core";
import type { PuckComponentData, PuckData } from "@onden/site";
import { nestingViolation, sameHome } from "./designModel";

const usePuck = createUsePuck();
const homeOf = (content: unknown): PuckData => ({ root: { props: {} }, content: content as PuckComponentData[] });

/** Watches the editor's data. Puck decides a drop by its static slot lists, which
 *  cannot say "an inner part may not hold a part" (they are one list per
 *  component type, whatever depth it sits at): a move the registry does not
 *  allow is undone here, so the saved data always passes validateDesignV2.
 *  Everything else is the new home page. */
export default function Bridge({ initial, onHome, onRefuse, dispatchRef }: {
  initial: PuckData;
  onHome: (home: PuckData) => void;
  onRefuse: () => void;
  dispatchRef: { current: ((action: PuckAction) => void) | null };
}) {
  const content = usePuck((s) => s.appState.data.content);
  const dispatch = usePuck((s) => s.dispatch);
  const lastGood = useRef(initial);
  useEffect(() => { dispatchRef.current = dispatch as (action: PuckAction) => void; }, [dispatch, dispatchRef]);
  useEffect(() => {
    const home = homeOf(content);
    if (nestingViolation(home)) {
      dispatch({ type: "setData", data: (previous) => ({ ...previous, content: lastGood.current.content as typeof previous.content }), recordHistory: false });
      onRefuse();
      return;
    }
    if (sameHome(home, lastGood.current)) return;
    lastGood.current = home;
    onHome(home);
  }, [content, dispatch, onHome, onRefuse]);
  return null;
}
