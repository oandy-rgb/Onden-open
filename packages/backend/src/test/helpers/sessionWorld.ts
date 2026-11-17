// A workspace for the tests of temporary sessions (services/participantSessions.ts): an owner who can sign in, a member, two shared spaces and a
// helper that opens a session the way a request does (through the fresh-confirmation ticket). The test file itself mocks `db.js` getWorkspaceId and
// `auth.js` (vi.mock is hoisted per file), then passes the workspace id here.
import { randomUUID } from "node:crypto";
import { q } from "../../db.js";
import { openTemporarySession } from "../../services/participantSessions.js";
import type { ActorCtx } from "../../types.js";
import { setWorkspaceOwner } from "./setOwner.js";
import { makeSpace } from "./spaceFixtures.js";
import { seedQ } from "./seedQ.js";
import { ticketWithoutEvidence } from "./freshProofTicket.js";

export type Person = { id: string; ext: string; ctx: ActorCtx };

export async function newWorkspace(label: string): Promise<string> {
  return (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id::text`, [label, `${label}-${randomUUID()}`])).rows[0]!.id;
}

/** A person who can sign in (external id), in no space yet. */
export async function newPerson(workspaceId: string, name: string): Promise<Person> {
  const ext = `${name}-${randomUUID()}`;
  const id = (await q<{ id: string }>(`INSERT INTO actors (workspace_id, name, type, external_id) VALUES ($1,$2,'human',$3) RETURNING id::text`, [workspaceId, name, ext])).rows[0]!.id;
  return { id, ext, ctx: { id, name, type: "human" } };
}

export async function newNote(workspaceId: string, title: string, spaceId: string, markdown = `body of ${title}`): Promise<string> {
  return (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes(workspace_id, source_type, node_type, title, slug, markdown, space_id)
     VALUES($1,'manual','content',$2,$3,$4,$5) RETURNING id::text`, [workspaceId, title, randomUUID(), markdown, spaceId])).rows[0]!.id;
}

/** An owner and a member, and two shared spaces: A (owner and member edit) and B (owner edits, member not in it). */
export async function standardWorld(label: string) {
  const ws = await newWorkspace(label);
  const owner = await newPerson(ws, "Owner");
  const member = await newPerson(ws, "Member");
  await setWorkspaceOwner(ws, owner.id);
  const spaceA = await makeSpace(ws, "space A", [{ id: owner.id, permission: "edit" }, { id: member.id, permission: "edit" }]);
  const spaceB = await makeSpace(ws, "space B", [{ id: owner.id, permission: "edit" }]);
  return { ws, owner, member, spaceA, spaceB };
}

/** Open a session as `opener` through the service, with a ticket (the evidence check itself is freshProof.integration.test.ts). */
export async function openAs(opener: Person, ws: string, input: Parameters<typeof openTemporarySession>[2]): ReturnType<typeof openTemporarySession> {
  return openTemporarySession(opener.ctx, ws, input, await ticketWithoutEvidence(opener.ctx, "open_session"));
}
