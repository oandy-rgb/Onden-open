import type { ModuleScreenProps } from "../types";
import RssReaderPanel from "./RssReaderPanel";

// The reader as a full page (`?view=rss`). Keeping a note selected lets "Keep"
// promote an article into a real note in place.
export default function RssScreen({ online, target, onOpenNode, onRefresh, onImmersiveChange }: ModuleScreenProps) {
  return (
    <RssReaderPanel
      online={online}
      onOpenNode={onOpenNode}
      onRefresh={onRefresh}
      initialItemId={target?.itemId ?? null}
      initialSourceId={target?.sourceId ?? null}
      onArticleOpenChange={onImmersiveChange}
    />
  );
}
