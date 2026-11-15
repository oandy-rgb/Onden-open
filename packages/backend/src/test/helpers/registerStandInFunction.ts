import { registerFunctionId } from "../../services/functionRefs.js";

/** Tag-function machinery tests (references, switches, packs, merge, extends) were written with review as the example function.
 *  Review has no tag function since migration 195 (a card is a note's or paragraph's own reference), so they register its id here as a
 *  second, stand-in tag function next to skills: the machinery still serves several functions, and the tests still exercise it.
 *  Nothing here is review behaviour; the shipped app never registers it. */
export function registerStandInFunction(): void {
  registerFunctionId("review");
}
