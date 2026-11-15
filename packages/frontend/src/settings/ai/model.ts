// 設定 › AI as data: the owner's connections (API keys and connection codes) and AIs, and how they relate.
// A connection and an AI are separate things: a key is kept on its own and an AI points at it (or, for an AI
// the owner connects themselves, it has connection codes). The page draws the same cards in three layouts that
// follow from the counts alone (aiPageLayout). No network here.
import type { AiRoleInfo } from "./aiRoleInfo";

export { AI_NAME_MAX } from "@onden/markdown";

export type KeyConnection = { kind: "key"; id: string; label: string; last4: string; baseUrl: string; createdAt: string };
/** A connection code belongs to one AI: it reaches the spaces that AI stands in. */
export type CodeConnection = { kind: "code"; id: string; actorId: string; name: string; lastUsedAt: string | null; access: "read" | "write" };
export type Connection = KeyConnection | CodeConnection;

export type AiPageData = { offered: boolean; keys: KeyConnection[]; codes: CodeConnection[]; roles: AiRoleInfo[] };

/** first-use: nothing yet. merged: exactly one connection and one AI, drawn as one card. split: anything else, two areas. */
export type AiPageLayout = "first-use" | "merged" | "split";

/** What an AI runs on right now. `lost`: it runs through the API but its key is gone (deleted, or never chosen). */
export type RoleConnection =
  | { kind: "key"; key: KeyConnection }
  | { kind: "code"; code: CodeConnection }
  | { kind: "lost" }
  | { kind: "none" };

export function connectionOf(role: AiRoleInfo, data: AiPageData): RoleConnection {
  if (role.default_runtime === "api") {
    const key = role.api?.credential_id ? data.keys.find((k) => k.id === role.api!.credential_id) : undefined;
    return key ? { kind: "key", key } : { kind: "lost" };
  }
  const code = data.codes.find((c) => c.actorId === role.actor_id);
  return code ? { kind: "code", code } : { kind: "none" };
}

/** The AIs that run on this key. */
export const rolesUsingKey = (key: KeyConnection, data: AiPageData): AiRoleInfo[] =>
  data.roles.filter((r) => r.default_runtime === "api" && r.api?.credential_id === key.id);

/** Whether the AI can run now. `off` carries the server's reason code (null = the connection itself is missing).
 *  An AI that connects by code is only "ready" while its software has come lately: `waiting` = never came, `away` = came
 *  before but not lately (`seenAt`). An API AI is ready as soon as its key and model are set. */
export type RoleState =
  | { state: "ready" } | { state: "paused" } | { state: "waiting" } | { state: "away"; seenAt: string }
  | { state: "off"; reason: "key_deleted" | "no_connection" | string };

/** How lately counts as "connected". The server only reports WHEN (`last_seen_at`: the later of the last poll for queued
 *  questions and the last call made with the AI's codes); it has no online/offline rule, so this one number is the page's
 *  rule. A client that fetches questions polls every ~25 s; two minutes is a few missed polls. */
const CONNECTED_RECENTLY_MS = 2 * 60_000;

export function roleState(role: AiRoleInfo, connection: RoleConnection, now: number = Date.now()): RoleState {
  if (connection.kind === "lost") return { state: "off", reason: "key_deleted" };
  if (connection.kind === "none") return { state: "off", reason: "no_connection" };
  if (!role.enabled) return { state: "paused" };
  const way = role.runtimes.find((r) => r.kind === role.default_runtime);
  if (way && !way.available) return { state: "off", reason: way.unavailable_reason ?? "unknown" };
  if (connection.kind === "code") {
    const seenAt = way?.last_seen_at ?? null;
    if (!seenAt) return { state: "waiting" };
    return now - new Date(seenAt).getTime() <= CONNECTED_RECENTLY_MS ? { state: "ready" } : { state: "away", seenAt };
  }
  return { state: "ready" };
}

/** AIs in the order the server lists them (by @name). */
export const sortedRoles = (roles: readonly AiRoleInfo[]): AiRoleInfo[] =>
  [...roles].sort((a, b) => a.handle.localeCompare(b.handle));

/** first-use: nothing yet. merged: exactly one connection and one AI, AND that connection is the one the AI runs on
 *  (otherwise a kept key or code would vanish into a card that says "no connection"). split: anything else. */
export function aiPageLayout(data: AiPageData): AiPageLayout {
  const connections = data.keys.length + data.codes.length;
  if (connections === 0 && data.roles.length === 0) return "first-use";
  if (connections !== 1 || data.roles.length !== 1) return "split";
  const own = connectionOf(data.roles[0]!, data);
  return own.kind === "key" || own.kind === "code" ? "merged" : "split";
}
