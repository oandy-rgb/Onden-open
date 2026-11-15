import { Rss } from "lucide-react";
import { FilterChips, Pressable, type FilterChipOption } from "../../components/ui";
import { useT } from "../../lib/i18n";
import type { RssSource } from "./useRssUnread";
import type { RssCounts } from "./rssCounts";

// The row of small source tags at the top of the list: 全部 and each feed,
// scrolling sideways. It only picks what to look at; adding, fetching and
// editing feeds is the 「來源」 sheet (RssSourcesSheet), opened by the last
// button, or by a long press (contextmenu) on a tag.

/** The 「聲音」 view: the feeds of people, not publications. */
export const VOICES_VIEW = "voices";
/** 全部 as the row's value (the reader's own state says null). */
const ALL = "";

type Props = {
  sources: readonly RssSource[] | null;
  /** null = all, VOICES_VIEW, or a feed id. */
  active: string | null;
  counts: RssCounts;
  onPick: (sourceId: string | null) => void;
  onOpenSources: () => void;
};

export default function RssSourceBar({ sources, active, counts, onPick, onOpenSources }: Props) {
  const t = useT();
  const total = counts.total(sources);
  const options: FilterChipOption<string>[] = [
    { value: ALL, label: t("All"), count: total || undefined },
    ...((sources ?? []).some((s) => s.voice === "person") ? [{ value: VOICES_VIEW, label: t("Voices") }] : []),
    ...(sources ?? []).map((s) => ({
      value: s.id,
      label: `${s.last_error ? "⚠ " : ""}${s.title}`,
      count: counts.showFor(s.id) ? s.unseen : undefined,
      onContextMenu: onOpenSources,
    })),
  ];
  return (
    <FilterChips className="rss-source-bar" label={t("Feeds")} value={active ?? ALL} options={options}
      onChange={(value) => onPick(value === ALL ? null : value)}
      trailing={(
        <Pressable className="rss-sources-open" onClick={onOpenSources} title={t("Manage feeds")} aria-label={t("Manage feeds")}>
          <Rss size={15} aria-hidden />
        </Pressable>
      )} />
  );
}
