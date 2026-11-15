// The kinds of block the studio can insert, as the 區塊 column lists them and
// the `/` menu offers them. A kind is a component type plus the starting props
// that make it the thing it is named for (「筆記摘要」 is a `note` shown as its
// first paragraph); which note or tag is chosen afterwards, on the right.
import type { ReactNode } from "react";
import { createUsePuck, type Config } from "@puckeditor/core";
import { PART_TYPES, PATTERN_TYPES, type PuckComponentData } from "@onden/site";
import { insertAfter } from "./designModel";
import { ASSET_INFO, KIND_INFO } from "./assetInfo";
import { containsTitle } from "../../../lib/noteSearch";

const usePuck = createUsePuck();

export type BlockKind = { id: string; type: string; label: string; description: string; icon: ReactNode; props?: Record<string, unknown> };
/** 零件 = content that goes on the page; 版面配置 = how the page is arranged. */
export type BlockTab = "parts" | "layout";
export const BLOCK_TABS: readonly { id: BlockTab; label: string }[] = [{ id: "parts", label: "零件" }, { id: "layout", label: "版面配置" }];
export type BlockGroup = { tab: BlockTab; title: string; hint: string; kinds: BlockKind[] };

export function blockGroups(config: Config): BlockGroup[] {
  const label = (type: string) => config.components[type]?.label ?? type;
  const shape = (type: string): BlockKind => ({ id: `part-${type}`, type, label: label(type), description: ASSET_INFO[type]?.description ?? "", icon: ASSET_INFO[type]?.icon() });
  const kind = (id: string, type: string, props?: Record<string, unknown>): BlockKind => {
    const info = KIND_INFO[id]!;
    return { id: `kind-${id}`, type, label: info.label, description: info.description, icon: info.icon(), props };
  };
  return [
    {
      tab: "parts", title: "內容", hint: "網站上要讀的東西。選哪一篇、哪個標籤，到右邊的屬性。",
      kinds: [
        kind("note", "note"),
        kind("tag_view", "tag_view"),
        kind("recent", "tag_view", { sort: "new", limit: 5, viewKind: "list" }),
        { id: "part-timeline", type: "timeline", label: label("timeline"), description: ASSET_INFO.timeline!.description, icon: ASSET_INFO.timeline!.icon() },
      ],
    },
    {
      tab: "parts", title: "文字與圖片", hint: "一篇筆記的不同露出方式。",
      kinds: [kind("summary", "note", { display: "first" }), kind("picture_card", "note", { display: "card" }), kind("title_only", "note", { display: "title" })],
    },
    { tab: "layout", title: "排版", hint: "把東西排成欄、格子。", kinds: PART_TYPES.map(shape) },
    { tab: "layout", title: "現成區塊", hint: "換上自己的內容就能用。", kinds: PATTERN_TYPES.map(shape) },
  ];
}

/** The groups with only the kinds the search matches; it also reads the sentence, so 「格子」 finds 卡片格. */
export function filterGroups(groups: readonly BlockGroup[], query: string): BlockGroup[] {
  const needle = query.trim().toLowerCase();
  return groups
    .map((group) => ({ ...group, kinds: group.kinds.filter((k) => needle === "" || containsTitle(needle, `${k.label} ${k.description}`)) }))
    .filter((group) => group.kinds.length > 0);
}

/** Inserts a block after the selection (or at the end of the page). */
export function useInsertBlock(config: Config) {
  const dispatch = usePuck((s) => s.dispatch);
  const selectedId = usePuck((s) => (s.selectedItem?.props.id as string | undefined) ?? null);
  const content = usePuck((s) => s.appState.data.content);
  return (type: string, props: Record<string, unknown>) => {
    const defaults = (config.components[type]?.defaultProps ?? {}) as Record<string, unknown>;
    const component = { type, props: { id: "new", ...defaults, ...props } } as PuckComponentData;
    const { home } = insertAfter({ root: { props: {} }, content: content as PuckComponentData[] }, selectedId, component);
    dispatch({ type: "setData", data: (previous) => ({ ...previous, content: home.content as typeof previous.content }) });
  };
}
