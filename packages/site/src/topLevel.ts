// Content may sit on the top level of the home page. It is drawn as if each
// component had a default `stack` around it, so a published page looks the
// same as when the studio wrapped them (before the top level took content).
// Pages already saved with a stack around their content are drawn as stored.
import type { PuckComponentData, PuckData } from "./design.js";
import { PARTS, kindOf } from "./registry.js";

/** `props.id` of the implicit stack drawn around a top-level content component. */
export const implicitStackId = (contentId: string) => `top-${contentId}`;

function defaultPartProps(): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(PARTS.stack.props)) {
    props[name] = spec.kind === "enum" || spec.kind === "int" ? spec.default : "";
  }
  return props;
}

/** For drawing only (never saved): each top-level content component inside its
 *  own default stack. Parts and patterns stay as they are. */
export function withImplicitStacks(home: PuckData): PuckData {
  if (!home.content.some((c) => kindOf(c.type) === "content")) return home;
  return {
    ...home,
    content: home.content.map((c): PuckComponentData => kindOf(c.type) !== "content" ? c : {
      type: "stack",
      props: { id: implicitStackId(c.props.id), ...defaultPartProps(), items: [c] },
    }),
  };
}
