import type { Context } from "hono";
import { z } from "zod";

/** Largest value of a Postgres bigint (domain_events.id, outbox.id). */
const INT8_MAX = 9223372036854775807n;

/** A bigint id from a path or body (`/api/events/:event_id`, the inbox ids):
 *  digits only and within int8, else null. Digits alone let a 20-digit id
 *  through to a `::bigint` cast, where Postgres throws "out of range" and the
 *  caller sees a 500 instead of the 400 every other malformed id gets. */
export function parseBigintId(raw: string): string | null {
  return /^\d+$/.test(raw) && BigInt(raw) <= INT8_MAX ? raw : null;
}

/** Request body as JSON. A body that is present but not valid JSON is always a
 *  400 (httpError maps the SyntaxError) — it never runs with defaults, because a
 *  truncated body looks the same as one that was never sent. `optional: true`
 *  accepts only a body with no bytes at all and reads it as `{}`. */
export async function readJsonBody(c: Context, opts: { optional?: boolean } = {}): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "" && opts.optional) return {};
  return JSON.parse(text);
}

/** `schema.parse` of the request body: bad JSON or a body the schema refuses is a 400. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S, opts: { optional?: boolean } = {}): Promise<z.output<S>> {
  return schema.parse(await readJsonBody(c, opts));
}

/** `schema.parse` of the query string: a name given once is a string, a name listed in `repeated` is an array of every
 *  value given (`?note=a&note=b`; absent when never given). A query the schema refuses is a 400. */
export function parseQuery<S extends z.ZodType>(c: Context, schema: S, opts: { repeated?: readonly string[] } = {}): z.output<S> {
  const given = c.req.queries();
  const query: Record<string, string | string[]> = {};
  for (const [name, values] of Object.entries(given)) query[name] = opts.repeated?.includes(name) ? values : values[0]!;
  return schema.parse(query);
}

/** A uuid path parameter (`/:id`). Anything else is a 400 — never a 404, a
 *  silent success or a Postgres "invalid input syntax for type uuid" 500. */
export function uuidParam(c: Context, name: string): string {
  return z.string().uuid().parse(c.req.param(name));
}

/** A uuid query parameter (`?space=`); absent is `undefined` when `optional`, a
 *  400 otherwise. Same 400 as uuidParam for anything that is not a uuid. */
export function uuidQuery(c: Context, name: string): string;
export function uuidQuery(c: Context, name: string, opts: { optional: true }): string | undefined;
export function uuidQuery(c: Context, name: string, opts: { optional?: boolean } = {}): string | undefined {
  const raw = c.req.query(name);
  if (raw === undefined && opts.optional) return undefined;
  return z.string().uuid().parse(raw);
}
