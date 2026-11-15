// A drawer item only tells Puck "insert this component type". The note or tag
// the owner dragged is in `prefillRef` (set when the drag started); when Puck
// reports the insert, the new component gets those props.
import type { PuckAction } from "@puckeditor/core";
import type { PuckComponentData, PuckData } from "@onden/site";
import type { Prefill } from "./BlocksPanel";
import { findComponent } from "./designModel";

type DispatchRef = { current: ((action: PuckAction) => void) | null };

export function prefillOnAction(prefillRef: { current: Prefill }, dispatchRef: DispatchRef) {
  return (action: PuckAction, next: { data: { content: unknown } }) => {
    if (action.type !== "insert") return;
    // Whatever was inserted, a pending choice belongs to this insert only.
    const pending = prefillRef.current;
    prefillRef.current = null;
    if (!pending || pending.type !== action.componentType) return;
    const [parentId, slot] = action.destinationZone.split(":");
    const home: PuckData = { root: { props: {} }, content: next.data.content as PuckComponentData[] };
    const list = slot === "default-zone" ? home.content : (findComponent(home, parentId!)?.props[slot!] as PuckComponentData[] | undefined);
    const inserted = list?.[action.destinationIndex];
    if (!inserted) return;
    // After Puck has finished the insert.
    queueMicrotask(() => dispatchRef.current?.({
      type: "replace", destinationZone: action.destinationZone, destinationIndex: action.destinationIndex,
      data: { ...inserted, props: { ...inserted.props, ...pending.props } },
    }));
  };
}
