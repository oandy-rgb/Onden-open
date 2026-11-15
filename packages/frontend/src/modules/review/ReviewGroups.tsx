import type { ReviewGroup, ReviewGroups as ReviewGroupsAnswer } from "@onden/contract";
import { Button, Segmented } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import { useLiveResource } from "./useLiveResource";
import { reviewGroupByPref, type ReviewGroupBy } from "./reviewGroupPref";
import { placeOfGroup, type ReviewPlace } from "./reviewPlace";

// 「分組」 on the review status page: the tags, or the notes, whose cards can be practised on their own.
// One read (GET /api/review/groups) gives every row's numbers: what a session of that group gives today,
// under the same daily limit as everything else. This component only lays them out.

type Props = { online: boolean; onPractise: (place: ReviewPlace) => void };

export default function ReviewGroups({ online, onPractise }: Props) {
  const t = useT();
  const { value: by, save } = reviewGroupByPref.useValue();
  const mode: ReviewGroupBy = by ?? "tag";
  const { value: answer } = useLiveResource<ReviewGroupsAnswer, ReviewGroupsAnswer | null>(`/api/review/groups?by=${mode}`, (raw) => raw, null, 60_000);
  // A switch pressed a moment ago shows no rows of the other kind while its own are on the way.
  const rows = answer && answer.by === mode ? answer.groups : null;
  const busy = (row: ReviewGroup) => row.due + row.new > 0;

  return (
    <section aria-label={t("Groups")}>
      <h3>{t("Groups")}</h3>
      <Segmented<ReviewGroupBy> label={t("Group by")} value={mode} onChange={save} className="review-groups-switch"
        options={[{ value: "tag", label: t("By tag") }, { value: "note", label: t("By note") }]} />
      {rows === null ? <p className="review-status-note">{online ? t("Loading…") : t("Review status needs a connection.")}</p>
        : rows.length === 0 ? <p className="review-status-note">{t("No review cards yet. On a paragraph, choose “Make this block a review card” to add one.")}</p>
        : (
          <ul className="review-groups">
            {rows.map((row) => (
              <li key={row.id ?? "none"} className="review-group" data-quiet={!busy(row)}>
                <span className="review-group-name">{row.id === null ? t("No tag") : displayTitle(row.title)}</span>
                <span className="review-group-counts">
                  {t("{n} due", { n: row.due })} · {t("{n} new", { n: row.new })}
                </span>
                <Button type="button" variant="ghost" className="review-group-practise" disabled={!online || !busy(row)}
                  onClick={() => onPractise(placeOfGroup(mode, row.id))}>{t("Practise this group")}</Button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
