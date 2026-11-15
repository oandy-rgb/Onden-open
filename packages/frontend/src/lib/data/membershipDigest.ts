import type { Sha256Hex } from "../hex";
// The readable set's digest, computed the way the server computes it
// (backend services/sync/membership.ts, GET /api/sync/membership/digest):
//   • ids sorted by UTF-16 code unit (JavaScript's default sort), joined with
//     "\n", UTF-8, SHA-256, lower-case hex → `digest`;
//   • a bucket is the ids sharing their first MEMBERSHIP_BUCKET_CHARS
//     characters; its digest is the same hash over its own ids, cut to the
//     first 16 hex digits.
// The membership reconcile (membershipReconcile.ts) compares its local set
// with the server's this way before paging, and pages only the buckets that
// differ. Equal digests are the only thing that lets it skip work.

export const MEMBERSHIP_BUCKET_CHARS = 2;
const BUCKET_DIGEST_HEX = 16;

export { webCryptoSha256, type Sha256Hex } from "../hex";

export type SetDigest = { count: number; digest: string; buckets: Record<string, string> };

/** The digest and bucket digests of `ids` (duplicates count once). */
export async function membershipDigestOf(ids: Iterable<string>, sha256: Sha256Hex): Promise<SetDigest> {
  const sorted = [...new Set(ids)].sort();
  const groups = new Map<string, string[]>();
  for (const id of sorted) {
    const key = bucketOf(id);
    const group = groups.get(key);
    if (group) group.push(id); else groups.set(key, [id]);
  }
  const buckets: Record<string, string> = {};
  await Promise.all([...groups].map(async ([key, group]) => {
    buckets[key] = (await sha256(group.join("\n"))).slice(0, BUCKET_DIGEST_HEX);
  }));
  return { count: sorted.length, digest: await sha256(sorted.join("\n")), buckets };
}

export function bucketOf(id: string): string {
  return id.slice(0, MEMBERSHIP_BUCKET_CHARS);
}

/** The buckets whose digests differ, including those only one side has. */
export function unequalBuckets(local: Record<string, string>, remote: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const [key, value] of Object.entries(local)) if (remote[key] !== value) out.add(key);
  for (const [key, value] of Object.entries(remote)) if (local[key] !== value) out.add(key);
  return [...out].sort();
}
