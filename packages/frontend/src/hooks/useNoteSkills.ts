import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reads } from "../lib/data";
import type { NoteSkill } from "../lib/agentMentions";

/** A skill as GET /api/skills lists it, built-in or one of the person's notes,
 *  with its 「給 AI 用」 switch. */
export type CatalogueSkill = NoteSkill & { kind: "builtin" | "note"; aiUse: boolean };
type CatalogueRow = { id: string; name: string; description: string; kind: "builtin" | "note"; appliesTo?: string[]; aiUse?: boolean };

/** The person's skills (GET /api/skills): `skills` are the skill notes — what `@ai /`
 *  offers and which notes get a 「交給 AI」 button; `catalogue` also holds the
 *  built-in ones (the skills page). Undefined until a read finished, null when
 *  it failed (offline); `refresh` looks again — the `@ai /` menu does that each
 *  time it opens, so a skill made a moment ago is there. Nothing is read at all
 *  unless `autoload` (the skill buttons need it from the start; the menu asks
 *  when it opens). */
export function useNoteSkills({ autoload, online }: { autoload: boolean; online: boolean }) {
  const [catalogue, setCatalogue] = useState<CatalogueSkill[] | null | undefined>(undefined);
  // Each read gets a number; a later read, or leaving, makes an earlier one stale.
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const run = ++latest.current;
    try {
      const body = await reads.agentMentions.skills<CatalogueRow>();
      if (run !== latest.current) return;
      setCatalogue(body.skills.map((s) => ({ id: s.id, name: s.name, description: s.description, kind: s.kind, appliesTo: s.appliesTo ?? [], aiUse: s.aiUse !== false })));
    } catch { if (run === latest.current) setCatalogue(null); }
  }, []);

  useEffect(() => {
    if (autoload && online) void refresh();
    const counter = latest;
    return () => { counter.current++; };
  }, [autoload, online, refresh]);

  const skills = useMemo(() => catalogue === undefined || catalogue === null ? catalogue : catalogue.filter((s) => s.kind === "note"), [catalogue]);
  return { skills, catalogue, refresh };
}
