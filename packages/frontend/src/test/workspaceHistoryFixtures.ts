import { addDays, todayId } from "../lib/localDate";
import type { DayAgentRun, DayNote, Feed, FeedDay } from "@onden/contract";
import type { ActivityDay, DeletedNote } from "@onden/contract";

export function activityFixture(): ActivityDay[] {
  const today = todayId();
  return Array.from({ length: 14 }, (_, i) => ({ date: addDays(today, i - 13), you: i === 13 ? 6 : i, agents: i === 13 ? 12 : 0 }));
}

export const RUN: DayAgentRun = {
  run_id: "run-1",
  agent_name: "Claude",
  started_at: "2026-10-24T05:12:00Z",
  summary: "整理了讀書筆記",
  undone: false,
  notes: [
    { id: "n1", title: "演算法", space_id: null, added: 1, changed: 2, removed: 0 },
    { id: "n2", title: "作業系統", space_id: null, added: 0, changed: 1, removed: 0 },
    { id: "n3", title: "", space_id: null, added: 3, changed: 0, removed: 0 },
  ],
};

const YOU = [{ name: "你", kind: "human" as const }];

/** Today: one note edited (a changed paragraph under 「待辦」) and one new note. */
export function dayNotesFixture(): DayNote[] {
  return [
    {
      id: "n1", title: "演算法", space_id: null, edits: 5, first_at: "2026-10-24T06:10:00Z", last_at: "2026-10-24T07:07:00Z", actors: YOU, created: false,
      change: { added: 0, changed: 2, removed: 1, sections: ["待辦"], sample: "複習動態規劃的狀態轉移", sample_kind: "changed" },
      ink: null, board_ink: null,
    },
    {
      id: "n4", title: "新筆記", space_id: null, edits: 1, first_at: "2026-10-24T06:10:00Z", last_at: "2026-10-24T06:10:00Z", actors: YOU, created: true,
      change: { added: 3, changed: 0, removed: 0, sections: [], sample: "第一段內容", sample_kind: "added" },
      ink: null, board_ink: null,
    },
  ];
}

export function feedDayFixture(date = todayId(), over: Partial<FeedDay> = {}): FeedDay {
  // end_at: the server's end of that day (here: 23:59:59.999 UTC).
  return { date, end_at: `${date}T23:59:59.999Z`, notes: dayNotesFixture(), notes_total: 2, edits_total: 6, agent_runs: [RUN], rewinds: [], system_tidies: [], ...over };
}

/** Today (with the AI run) and yesterday; nothing older. */
export function feedFixture(): Feed {
  const today = todayId();
  return {
    days: [
      feedDayFixture(today),
      feedDayFixture(addDays(today, -1), {
        agent_runs: [], notes_total: 1, edits_total: 2,
        notes: [{
          id: "n9", title: "讀書計畫", space_id: null, edits: 2, first_at: "2026-10-23T02:00:00Z", last_at: "2026-10-23T02:26:00Z",
          actors: [{ name: "Claude", kind: "agent" }], created: false,
          change: { added: 0, changed: 0, removed: 1, sections: [], sample: "舊的第三章進度", sample_kind: "removed" },
          ink: null, board_ink: null,
        }],
      }),
    ],
    earlier_day: null,
  };
}

export const DELETED: DeletedNote[] = [{ id: "d1", title: "舊計畫", deleted_at: "2026-10-23T14:05:00Z", space_id: null, blank: false }];
