import { Suspense } from "react";
import type { ContentNode } from "../../lib/api";
import { drafts } from "../../lib/data";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { openModuleDialog } from "../../lib/moduleDialog";
import { displayTitle } from "../../lib/noteLabel";
import { slidesDataOf } from "./slidesDataOf";

const PresentationPlayer = lazyWithReload(() => import("./PresentationPlayer"));

/** 「開始播放」的唯一入口（⌘K、功能分頁、簡報分頁都走這裡）：播出筆記目前的文字，
 *  用使用者在簡報分頁選的版型與主題（`slides_data`），從第 `startAt` 頁開始。 */
export function presentNote(node: ContentNode, openNode: (id: string) => void, startAt = 0): void {
  // What the editor shows, saved or not.
  const markdown = drafts.read(node.id)?.markdown ?? node.markdown ?? "";
  const data = slidesDataOf(node);
  openModuleDialog((close) => (
    <Suspense fallback={null}>
      <PresentationPlayer markdown={markdown} title={displayTitle(node.title)} from={node} data={data} startAt={startAt} onClose={close} onOpenNode={openNode} />
    </Suspense>
  ));
}
