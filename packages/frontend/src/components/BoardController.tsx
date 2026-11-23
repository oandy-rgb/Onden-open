import { useLayoutEffect } from "react";
import { boardController } from "../hooks/boardController";
import { useBoardWorkspace } from "../hooks/useBoardWorkspace";

type Props = Parameters<typeof useBoardWorkspace>[0];

/** The board's hooks, run here so the shell's first JS does not carry them (hooks/boardController). It draws
 *  nothing; the board screen and the commands read what it publishes. Published in a layout effect so the
 *  screen shows the new state in the same frame. */
export default function BoardController(props: Props) {
  const board = useBoardWorkspace(props);
  useLayoutEffect(() => { boardController.publish(board); });
  useLayoutEffect(() => () => boardController.clear(), []);
  return null;
}
