// Browser app only: @onden/markdown's full.ts colours published pages with the common grammars, not all ~190.
import { common } from "lowlight";

export function fullGrammars() {
  return common;
}
