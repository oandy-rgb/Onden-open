import type { ContentNode } from "../../../lib/api";
import { lazyWithReload } from "../../../lib/lazyWithReload";
import { openModuleDialog } from "../../../lib/moduleDialog";

const ExportPptxDialog = lazyWithReload(() => import("./ExportPptxDialog"), { warm: false });

/** 「匯出 PPTX」's one way in (the 簡報 tab's button and the note's command both call it): opens the panel for `node`'s slides. */
export function openPptxExport(node: ContentNode, openNode?: (id: string) => void): void {
  openModuleDialog((close) => <ExportPptxDialog node={node} onOpenNode={openNode} onClose={close} />);
}
