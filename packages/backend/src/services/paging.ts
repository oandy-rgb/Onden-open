// List paging — the one contract for `?limit=&offset=` (depth audit D66).
//
// Before this, seven routes parsed limit/offset seven ways: `Number("abc")`
// reached SQL as `LIMIT 'NaN'` (500), `?limit=-5` became `LIMIT -4` (500),
// and the answers came back as `hasMore`, `nextOffset` or a bare array.
//
// Request: `parsePage(query, { default, max })` → { limit, offset }.
//   limit   absent/blank → `default`; a positive integer, clamped to `max`.
//   offset  absent/blank → 0; a non-negative integer up to MAX_OFFSET.
//   Anything else is the caller's fault: a z.ZodError, which the HTTP error
//   boundary (httpError.apiOnError) answers as 400 bad_request.
//
// Response: `Page<T>` = { rows, total?, next } — `next` is the offset of the
// next page, or null when this page is the last. `pageOf` builds it from a
// query that fetched `limit + 1` rows (the probe row tells "there is more"
// without a COUNT).
//
// SQL: LIMIT/OFFSET are always bound parameters (`$n`), never interpolated.
//
// Not offset pages, so not this shape: /api/events (`since` is an event-id
// cursor), /api/inbox (a queue with facets; `since` is a date filter),
// /api/rss/items (a keyset cursor "<ts>~<id>") and /api/sync/membership (a
// keyset cursor over ids). They use parsePage for `limit` only.

import { z } from "zod";
import type { Page } from "@onden/contract";

/** Deepest offset a page may start at. Deeper than any real list, small
 *  enough that a typo'd 20-digit offset is refused instead of scanned. */
export const MAX_OFFSET = 1_000_000;

export type PageQuery = { limit?: string | null; offset?: string | null };
export type PageOptions = { default: number; max: number };
export type PageInput = { limit: number; offset: number };

const blank = (v: string | null | undefined) => v === undefined || v === null || v.trim() === "";

function pageSchema(opts: PageOptions) {
  return z.object({
    limit: z.string().nullish().transform((v, ctx) => {
      if (blank(v)) return opts.default;
      const t = v!.trim();
      if (!/^\d+$/.test(t) || Number(t) <= 0) {
        ctx.addIssue({ code: "custom", path: [], message: "limit must be a positive integer" });
        return z.NEVER;
      }
      return Math.min(Number(t), opts.max);
    }),
    offset: z.string().nullish().transform((v, ctx) => {
      if (blank(v)) return 0;
      const t = v!.trim();
      if (!/^\d+$/.test(t) || Number(t) > MAX_OFFSET) {
        ctx.addIssue({ code: "custom", path: [], message: `offset must be an integer from 0 to ${MAX_OFFSET}` });
        return z.NEVER;
      }
      return Number(t);
    }),
  });
}

/** `?limit=&offset=` → { limit, offset }; throws z.ZodError (→ 400) on bad input. */
export function parsePage(query: PageQuery, opts: PageOptions): PageInput {
  return pageSchema(opts).parse({ limit: query.limit ?? null, offset: query.offset ?? null });
}

/** parsePage without the throw, for pure builders that return their own error. */
export function safeParsePage(query: PageQuery, opts: PageOptions): { ok: true; page: PageInput } | { ok: false; error: string } {
  const r = pageSchema(opts).safeParse({ limit: query.limit ?? null, offset: query.offset ?? null });
  return r.success ? { ok: true, page: r.data } : { ok: false, error: r.error.issues[0]?.message ?? "bad page" };
}

/** A route's query string read the way parsePage wants it. */
export function pageQueryOf(c: { req: { query(name: string): string | undefined } }): PageQuery {
  return { limit: c.req.query("limit"), offset: c.req.query("offset") };
}

/** Bind LIMIT (limit + 1, the probe row) and OFFSET onto `params`; returns
 *  the SQL tail, e.g. "LIMIT $4 OFFSET $5". */
export function pageSql(page: PageInput, params: unknown[]): string {
  params.push(page.limit + 1);
  const limitIdx = params.length;
  params.push(page.offset);
  return `LIMIT $${limitIdx} OFFSET $${params.length}`;
}

/** The page from rows fetched with pageSql (one probe row past `limit`). */
export function pageOf<T>(fetched: T[], page: PageInput, total?: number): Page<T> {
  const more = fetched.length > page.limit;
  const rows = more ? fetched.slice(0, page.limit) : fetched;
  return { rows, ...(total === undefined ? {} : { total }), next: more ? page.offset + page.limit : null };
}

/** A `?days=`/`?limit=`-style count: a whole number in [min, max]. Absent or
 *  blank = `fallback`. Anything else — `1.5`, `12abc`, `-1`, out of range — is
 *  null, which the route answers as a 400 (never clamped, never `NaN`). */
export function parseCount(raw: string | null | undefined, { fallback, min = 1, max }: { fallback: number; min?: number; max: number }): number | null {
  if (blank(raw)) return fallback;
  const t = raw!.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** A boolean `?flag=`: true only for `on` (default "1"); absent or anything else is false. */
export function parseFlag(raw: string | null | undefined, on = "1"): boolean {
  return raw === on;
}
