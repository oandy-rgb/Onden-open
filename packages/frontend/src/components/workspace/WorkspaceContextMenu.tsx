import { backgroundWrite } from "../../lib/data";
import type { useBoardWorkspace } from "../../hooks/useBoardWorkspace";
import type { useNodeCreation } from "../../hooks/useNodeCreation";
import type { useNodeSelection } from "../../hooks/useNodeSelection";
import ContextMenu from "../ContextMenu";
import type { CtxMenu } from "../../lib/ctxMenu";

type Props = {
  menu: CtxMenu;
  onClose: () => void;
  openNote: (id: string) => void;
  rename: Pick<ReturnType<typeof useNodeSelection>, "setRenamingNodeId" | "setRenameDraft">;
  creation: Pick<ReturnType<typeof useNodeCreation>, "createPointer" | "deletePointer" | "create">;
  board: Pick<ReturnType<typeof useBoardWorkspace>, "removeCanvasCard" | "setNodeColor" | "createCardAt" | "centerBoardOn">;
};

/** The one right-click menu (sidebar rows, board cards, the board itself,
 *  arrows), rendered outside the mode branches so it works in all modes. The
 *  menu runs a note's own actions itself (lib/data's nodeActions); this binds
 *  what only the shell has: navigation, the rename form, the board and pins. */
export default function WorkspaceContextMenu({ menu, onClose, openNote, rename, creation, board }: Props) {
  return (
    <ContextMenu
      menu={menu}
      onClose={onClose}
      onSelectNode={openNote}
      onStartRename={(id, title) => { rename.setRenamingNodeId(id); rename.setRenameDraft(title); }}
      onRemoveFromCanvas={board.removeCanvasCard}
      onCenterBoard={board.centerBoardOn}
      onSetNodeColor={backgroundWrite(board.setNodeColor)}
      onCreateInside={(kindId, parentId) => void creation.create(kindId, { parentId })}
      onCreatePointer={(targetId, parentId) => void creation.createPointer(targetId, parentId)}
      onDeletePointer={(pointerId) => void creation.deletePointer(pointerId)}
      onCreateAt={backgroundWrite(board.createCardAt)}
    />
  );
}
