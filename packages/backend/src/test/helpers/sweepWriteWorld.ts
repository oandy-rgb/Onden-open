// The objects the write-route sweep aims at (crossWorkspaceWriteSweep.integration.test.ts).
//
// buildSweepObjects() makes ONE workspace's worth of everything a write route can name — a note, a child, a tag, a
// task, a link, a whiteboard, a trashed note, a saved view, a second member with a token, an RSS source … — and
// returns their ids. The same builder serves the owner's own workspace (the route must succeed), and A (the objects
// an outsider aims at). It is deliberately smaller than the read sweep's world: it only needs one id per kind.

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { q } from "../../db.js";
import { createNote } from "../../services/noteCreate.js";
import { createTag } from "../../services/tagHierarchy.js";
import { createEdge } from "../../services/edgeWrites.js";
import { createStandaloneTask } from "../../services/standaloneTasks.js";
import { addWhiteboardTab } from "../../services/boardStore.js";
import { storeMedia } from "../../services/media.js";
import { createToken } from "../../services/agentTokens.js";
import { trashNode } from "../../services/nodeTrash.js";
import { addFunction } from "../../services/functionRefs.js";
import { addCredential } from "../../services/aiCredentials.js";
import { configureRunner, setRunnerEnabled } from "../../services/agentSessions.js";
import { setModuleImported } from "../../services/workspaceModules.js";
import { createPointer } from "../../services/pointers.js";
import { Readable } from "node:stream";
import { encodeInk } from "@onden/markdown/ink";
import { createSuggestions } from "../../services/aiSuggestions.js";
import { endSession, startSession } from "../../services/agentSessions.js";
import { updateNode } from "../../services/nodeUpdate.js";
import { callTool } from "../../services/agentTools/index.js";
import { setNodeAttribute } from "../../services/attributeWrites.js";
import { addCalendar } from "../../modules/external_calendars/store.js";
import { buildFullBackup } from "../../services/backupArchive.js";
import { stageBackupUpload } from "../../services/backupFile.js";
import { rewindWorkspace } from "../../services/history/rewind.js";
import { grade } from "../../modules/review/service.js";
import { setNoteCard } from "../../modules/review/cards.js";
import { muteKeyword } from "../../modules/rss/mutes.js";
import { freshWorkspace } from "./roundTripWorld.js";
import { placeTask } from "../../modules/tasks/placement.js";
import { awaitAllDispatchers } from "../../services/dispatcherQueue.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "./persistActor.js";
import { adminOnlySpace } from "./spaceFixtures.js";
import { seedView, seedViewElements } from "./seedView.js";
import { seedQ } from "./seedQ.js";
import { workspaceSwitch } from "./workspaceSwitch.js";

export type SweepSide = { ws: string; owner: ActorCtx; ownerExternalId: string };

/** Ids of one workspace's objects, plus the canary every title/body carries. */
export type SweepObjects = {
  ws: string;
  canary: string;
  note: string; child: string; otherNote: string; trashed: string;
  tag: string; otherTag: string;
  task: string; edge: string; canvas: string; event: string;
  noteView: string; tagView: string;
  space: string;
  /** the workspace's review module tag, and a task already placed in `note` */
  moduleTag: string; placedTask: string;
  /** a note in the shared space, which the agent is in and which allows external AI (the personal space does not) */
  aiNote: string;
  /** an agent with a runner (the handle of its @mention is `handle`), and a stored API key of the owner's */
  agent: string; handle: string; credential: string;
  /** a tag that already holds the review function */
  fnTag: string;
  /** a note carrying the review module's tag (a card) */
  reviewNote: string;
  /** a pointer under `child` to `otherNote`, the event that deleted `trashed`, an ended focus session on `task` */
  pointer: string; deleteEvent: string; focus: string;
  /** workspaces.membership_epoch when the world was built */
  epoch: string;
  member: string; memberToken: string;
  feed: string; article: string;
  media: string;
  attrKey: string;
  /** two @mentions in `aiNote`: one session still open, one cancelled; a pending suggestion of the open one */
  session: string; endedSession: string; suggestion: string;
  /** a note the agent edited (agentNote), that edit's event (agentEvent; an unreviewed change in the inbox) and its run (agentRun) */
  agentNote: string; agentEvent: string; agentRun: string;
  /** a tag pack the agent proposed and the owner has not decided (outbox approvals), a failed delivery and its kind */
  approval: string; deadEffect: string; deadKind: string;
  /** an ATTRIBUTE_CONFLICT event on `note` */
  conflictEvent: string;
  /** an external calendar of the owner's */
  calendar: string;
  /** a backup the owner staged for restoring, and a small zip (base64) to stage another from */
  upload: string; backupZipBase64: string;
  /** a note a rewind of the workspace deleted, and that rewind */
  rewindNote: string; rewindId: string;
  /** a save of `note`'s handwriting */
  inkEvent: string;
  /** a block node (a paragraph tagged with the review tag) */
  block: string;
  /** a keyword mute of the owner's */
  mute: string;
};

export const SWEEP_ATTR_KEY = "sweepattr";
/** A well-formed API key and the 32-byte secret that lets the server keep it (the test sets ONDEN_SECRET_KEY). */
export const SWEEP_API_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789WXYZ";
export const SWEEP_SECRET_KEY = "cd".repeat(32);

/** Every id and name this world minted that must never show up in another workspace. */
export function needlesOf(o: SweepObjects): string[] {
  return [o.canary, o.note, o.child, o.otherNote, o.trashed, o.tag, o.otherTag, o.task, o.edge, o.canvas, o.event,
    o.noteView, o.tagView, o.space, o.moduleTag, o.fnTag, o.agent, o.aiNote, o.credential, o.reviewNote, o.placedTask, o.pointer, o.deleteEvent, o.focus, o.member, o.memberToken, o.feed, o.article, o.media].concat([o.session, o.endedSession, o.suggestion, o.agentNote, o.agentEvent, o.agentRun, o.approval, o.deadEffect, o.deadKind, o.conflictEvent, o.calendar, o.upload, o.rewindNote, o.rewindId, o.block, o.mute])
    .filter((n) => n.length >= 12);
}

/** What each object needs built first. */
const NEEDS: Partial<Record<keyof SweepObjects, Array<keyof SweepObjects>>> = {
  note: ["tag"], child: ["note"], edge: ["note", "otherNote"], noteView: ["note", "tag"], tagView: ["tag"], event: ["note"],
  pointer: ["child", "otherNote"], reviewNote: [], fnTag: ["moduleTag"], handle: ["agent"], agent: ["note"], aiNote: ["space", "agent"], deleteEvent: ["trashed"], placedTask: ["note"], focus: ["task"], article: ["feed"],
  session: ["aiNote"], endedSession: ["aiNote"], suggestion: ["session"], agentNote: ["aiNote"], agentEvent: ["agentNote"], agentRun: ["agentEvent"],
  approval: ["agent"], deadEffect: ["deadKind"], conflictEvent: ["note"], upload: ["backupZipBase64"], rewindId: ["rewindNote"], inkEvent: ["note"], block: ["moduleTag"],
};

const collect = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
};
/** One small backup zip of a workspace of its own, made once and staged by every world that needs one. */
let donorZip: Promise<Buffer> | undefined;
function sweepDonorZip(): Promise<Buffer> {
  donorZip ??= (async () => {
    const donor = await freshWorkspace("sweepdonor");
    await createNote({ actor: donor.actor, workspaceId: donor.ws, title: "Donor note", markdown: "donor body", event: { uiContext: "test.sweep" } });
    const before = workspaceSwitch.ws;
    workspaceSwitch.ws = donor.ws;
    try { return await collect(await buildFullBackup(donor.actor, donor.ws)); } finally { workspaceSwitch.ws = before; }
  })();
  return donorZip;
}

/** The fields `content` reads: it runs once against a recorder, so a world only builds what its request names. */
export function fieldsUsed(content: (own: SweepObjects, ref: SweepObjects) => unknown): Set<keyof SweepObjects> {
  const used = new Set<keyof SweepObjects>();
  const recorder = new Proxy({} as SweepObjects, { get: (_t, key) => { used.add(key as keyof SweepObjects); return `placeholder-${String(key)}`; } });
  content(recorder, recorder);
  return used;
}

/** Build the objects in `wanted` (and what they need); the others are left empty. Default: everything. */
export async function buildSweepObjects(side: SweepSide, label: string, wanted?: ReadonlySet<keyof SweepObjects>): Promise<SweepObjects> {
  const { ws, owner: actor } = side;
  const need = new Set<keyof SweepObjects>();
  const add = (k: keyof SweepObjects) => { if (need.has(k)) return; need.add(k); for (const d of NEEDS[k] ?? []) add(d); };
  for (const k of wanted ?? (["note", "child", "otherNote", "trashed", "tag", "otherTag", "task", "edge", "canvas", "event", "noteView", "tagView", "space", "member",
    "memberToken", "feed", "article", "media", "moduleTag", "fnTag", "agent", "aiNote", "credential", "reviewNote", "placedTask", "pointer", "deleteEvent", "focus",
    "session", "endedSession", "suggestion", "agentRun", "approval", "deadEffect", "conflictEvent", "calendar", "upload", "rewindId", "inkEvent", "block", "mute"] as const)) add(k);
  if (need.has("memberToken")) add("member");
  const canary = `SWW${label}${randomUUID().slice(0, 8)}`;
  const c = (what: string) => `${canary}${what}`;
  const common = { actor, workspaceId: ws, spaceId: null, event: { uiContext: "test.sweep" } } as const;
  const id = (k: keyof SweepObjects) => (need.has(k) ? randomUUID() : "");
  const o: SweepObjects = {
    ws, canary, attrKey: SWEEP_ATTR_KEY, epoch: "", note: id("note"), child: id("child"), otherNote: id("otherNote"), trashed: id("trashed"),
    tag: "", otherTag: "", task: "", edge: "", canvas: id("canvas"), event: "", noteView: "", tagView: "", space: "", moduleTag: "", placedTask: "",
    pointer: "", deleteEvent: "", focus: "", reviewNote: id("reviewNote"), fnTag: "", agent: "", handle: "", aiNote: id("aiNote"), credential: "", member: "", memberToken: "", feed: "", article: "", media: "",
    session: "", endedSession: "", suggestion: "", agentNote: id("agentNote"), agentEvent: "", agentRun: "", approval: "", deadEffect: "", deadKind: need.has("deadKind") ? `sweepdead${canary.toLowerCase()}` : "",
    conflictEvent: "", calendar: "", upload: "", backupZipBase64: "", rewindNote: id("rewindNote"), rewindId: "", inkEvent: "", block: "", mute: "",
  };
  let agentActor: ActorCtx | undefined;
  if (need.has("tag")) o.tag = (await createTag({ actor, workspaceId: ws, name: c("Tag"), parentId: null })).id;
  if (need.has("otherTag")) o.otherTag = (await createTag({ actor, workspaceId: ws, name: c("OtherTag"), parentId: null })).id;
  if (need.has("note")) {
    await createNote({
      ...common, id: o.note, title: c("Title"), slug: c("slug").toLowerCase(),
      markdown: `${c("Body")} first\n\nsecond ${c("Para")}`, tagIds: [o.tag],
      attributes: [{ key: SWEEP_ATTR_KEY, value: c("AttrValue"), value_type: "text" }],
    });
  }
  if (need.has("child")) await createNote({ ...common, id: o.child, title: c("Child"), markdown: c("ChildBody"), parentId: o.note });
  if (need.has("otherNote")) await createNote({ ...common, id: o.otherNote, title: c("Other"), markdown: c("OtherBody") });
  if (need.has("trashed")) {
    await createNote({ ...common, id: o.trashed, title: c("Trashed"), markdown: c("TrashedBody") });
    await trashNode(actor, ws, o.trashed);
  }
  if (need.has("deleteEvent")) {
    o.deleteEvent = (await q<{ id: string }>(
      `SELECT max(id)::text AS id FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND event_type = 'NODE_DELETED'`, [ws, o.trashed])).rows[0]!.id;
  }
  if (need.has("edge")) o.edge = (await createEdge(actor, ws, { source_node_id: o.note, target_node_id: o.otherNote, edge_type: "sweep_edge", status: "active" })).id;
  if (need.has("task")) {
    o.task = await createStandaloneTask({
      actor, workspaceId: ws, spaceId: null, title: c("Task"), markdown: c("TaskBody"),
      fields: { _task_status: "todo", _task_when: "2026-06-11" }, uiContext: "test.sweep",
    });
  }
  if (need.has("canvas")) {
    await createNote({
      ...common, id: o.canvas, title: c("Canvas"), nodeType: "canvas", slug: `canvas-${o.canvas}`,
      event: { type: "CANVAS_CREATED", targetType: "canvas", uiContext: "test.sweep" },
      within: ({ nodeId }) => addWhiteboardTab(nodeId),
    });
  }
  if (need.has("tagView")) o.tagView = await seedView(o.tag, { name: c("TagView") });
  if (need.has("noteView")) {
    o.noteView = randomUUID();
    await seedViewElements(o.note, [{ id: o.noteView, tag_id: o.tag, name: c("NoteView"), layout: "list", filters: [], sorts: [], group_by: null, visible_fields: [], layout_config: {}, pin_order: 0 }]);
  }
  if (need.has("event")) {
    o.event = (await q<{ id: string }>(
      `SELECT min(id)::text AS id FROM domain_events WHERE workspace_id = $1 AND target_id = $2`, [ws, o.note])).rows[0]!.id;
  }
  if (need.has("space")) o.space = await adminOnlySpace(ws, c("Space"), [actor.id]);
  if (need.has("member")) {
    const member = await persistActor(ws, { id: "", name: c("Member"), type: "human", role: "viewer" });
    // signed in once (an owner transfer needs a person who has)
    await q(`UPDATE actors SET external_id = $2 WHERE id = $1`, [member.id, `sweep-member-${canary}`]);
    o.member = member.id;
    if (need.has("memberToken")) o.memberToken = (await createToken(member.id, { name: c("Token"), access: "read" })).id;
  }
  if (need.has("media")) {
    const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: { r: 9, g: 8, b: 7 } } }).png().toBuffer();
    const stored = await storeMedia(png, ".png", { actor, workspaceId: ws, origin: "upload" });
    if (!stored.ok) throw new Error(`media: ${stored.reason}`);
    o.media = stored.filename;
  }
  if (need.has("feed")) {
    o.feed = (await seedQ<{ id: string }>(
      `INSERT INTO rss_subscriptions (workspace_id, space_id, title, url, created_by_actor_id)
       SELECT $1, s.id, $2, $3, $4 FROM spaces s WHERE s.workspace_id = $1 AND s.is_default RETURNING id::text`,
      [ws, c("Feed"), `https://feed.test/${c("feedurl")}.xml`, actor.id])).rows[0]!.id;
  }
  if (need.has("article")) {
    o.article = (await seedQ<{ id: string }>(
      `INSERT INTO rss_staging (workspace_id, subscription_id, guid, title, body, published_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING id::text`,
      [ws, o.feed, `guid-${canary}`, c("Article"), c("ArticleBody")])).rows[0]!.id;
  }
  if (need.has("moduleTag")) {
    // A module with a tag of its own (skills; review has none since migration 195): the tag stands in wherever a route takes a module tag.
    o.moduleTag = ((await setModuleImported({ actor, workspaceId: ws, module: "skills", imported: true })) as { module_tag_id: string }).module_tag_id;
  }
  if (need.has("agent")) {
    agentActor = await persistActor(ws, { id: "", name: c("Agent"), type: "agent", role: "editor",
      tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null } });
    o.agent = agentActor.id;
    o.handle = `sw${randomUUID().slice(0, 8)}`;
    await configureRunner(ws, o.agent, { handle: o.handle }, { actor });
    await setRunnerEnabled(ws, o.agent, true, { actor });
  }
  if (need.has("aiNote")) {
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'edit') ON CONFLICT DO NOTHING`, [o.space, o.agent]);
    await createNote({ ...common, spaceId: o.space, id: o.aiNote, title: c("AiNote"),
      markdown: `${c("AiNoteBody")}\n\n@${o.handle} ${c("AskOne")} please tidy this\n\n@${o.handle} ${c("AskTwo")} please tidy this too` });
  }
  if (need.has("session")) {
    o.session = (await startSession(ws, { actor, nodeId: o.aiNote, target: { blockText: `@${o.handle} ${c("AskOne")} please tidy this` } })).session.id;
  }
  if (need.has("endedSession")) {
    o.endedSession = (await startSession(ws, { actor, nodeId: o.aiNote, target: { blockText: `@${o.handle} ${c("AskTwo")} please tidy this too` } })).session.id;
    await endSession(ws, o.endedSession, "cancelled", { failCode: "cancelled_by_user", endedBy: actor.id });
  }
  if (need.has("suggestion")) {
    const now = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [o.aiNote])).rows[0]!.markdown;
    const made = await createSuggestions(ws, { actor, proposer: { agentActorId: o.agent, sessionId: o.session }, nodeId: o.aiNote, proposedMarkdown: `${now}\n\n${c("Proposed")} added by the agent` });
    if (!made.suggestionId) throw new Error("sweep: the suggestion saved nothing");
    o.suggestion = made.suggestionId;
  }
  if (need.has("agentNote")) {
    await createNote({ ...common, spaceId: o.space, id: o.agentNote, title: c("AgentNote"), markdown: c("AgentNoteBody") });
    await updateNode(ws, o.agentNote, { markdown: `${c("AgentNoteBody")} the agent added this` }, { actor: agentActor! });
  }
  if (need.has("agentEvent")) {
    o.agentEvent = (await q<{ id: string }>(
      `SELECT max(id)::text AS id FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND actor_id = $3`, [ws, o.agentNote, o.agent])).rows[0]!.id;
  }
  if (need.has("agentRun")) o.agentRun = `legacy:${o.agent}:${o.agentEvent}`;
  if (need.has("approval")) {
    await callTool("proposeTagPack", { name: `sweeppack${canary.toLowerCase()}`, description: "a pack", fields: [{ name: "due", type: "date" }] }, { actor: agentActor!, workspaceId: ws });
    o.approval = (await q<{ id: string }>(
      `SELECT id::text FROM outbox WHERE workspace_id = $1 AND effect_kind = 'tag_pack' AND status = 'pending_approval' ORDER BY id DESC LIMIT 1`, [ws])).rows[0]!.id;
  }
  if (need.has("deadKind")) {
    o.deadEffect = (await seedQ<{ id: string }>(
      `INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload, status, last_error) VALUES ($1, $2, $3, '{"v":1}'::jsonb, 'dead', 'sweep') RETURNING id::text`,
      [ws, o.deadKind, canary])).rows[0]!.id;
  }
  if (need.has("conflictEvent")) {
    const key = "sweepconflict";
    await setNodeAttribute({ workspaceId: ws, actor, nodeId: o.note, attribute: { key, value: "one", value_type: "text" } });
    // written "an hour ago" by a client that had not seen the first value: the second write wins, and the first is recorded as overridden
    await setNodeAttribute({ workspaceId: ws, actor, nodeId: o.note, attribute: { key, value: "two", value_type: "text", client_updated_at: new Date(Date.now() - 3_600_000).toISOString(), client_edit_age_ms: 3_600_000 } });
    o.conflictEvent = (await q<{ id: string }>(
      `SELECT max(id)::text AS id FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND event_type = 'ATTRIBUTE_CONFLICT'`, [ws, o.note])).rows[0]?.id ?? "";
    if (!o.conflictEvent) throw new Error("sweep: no attribute conflict was recorded");
  }
  if (need.has("calendar")) {
    o.calendar = randomUUID();
    await addCalendar(ws, actor, { id: o.calendar, name: c("Calendar"), color: "#336699", href: `https://calendar.test/${c("calurl")}.ics`, host: "calendar.test" });
  }
  if (need.has("backupZipBase64")) o.backupZipBase64 = (await sweepDonorZip()).toString("base64");
  if (need.has("upload")) {
    const zip = await sweepDonorZip();
    o.upload = (await stageBackupUpload(actor.id, Readable.from([zip]), zip.length)).uploadId;
  }
  if (need.has("rewindNote")) {
    const before = (await q<{ t: Date }>(`SELECT now() AS t`)).rows[0]!.t;
    await createNote({ ...common, id: o.rewindNote, title: c("RewindNote"), markdown: c("RewindNoteBody") });
    if (need.has("rewindId")) {
      const done = await rewindWorkspace(ws, { at: new Date(before.getTime() - 1000), restoreIds: [], undeleteIds: [], deleteIds: [o.rewindNote] }, { actor });
      if (!done.rewind_id) throw new Error("sweep: the rewind changed nothing");
      o.rewindId = done.rewind_id;
    }
  }
  if (need.has("inkEvent")) {
    const stroke = { id: "s0", points: [[0, 0], [10, 10], [20, 5], [30, 30]] as Array<[number, number]>, color: "#112233", size: 2, toolId: "pen" };
    await setNodeAttribute({ workspaceId: ws, actor, nodeId: o.note, attribute: { key: "ink_data", value: encodeInk({ version: 1, strokes: [stroke], erased: {}, page: { width: 1000 } }), value_type: "text" } });
    o.inkEvent = (await q<{ id: string }>(
      `SELECT max(id)::text AS id FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND payload->>'key' = 'ink_data'`, [ws, o.note])).rows[0]!.id;
  }
  if (need.has("block")) {
    const tagName = "review"; // the review module's own word: the paragraph is a card (its own reference)
    const blockNote = (await createNote({ ...common, title: c("BlockNote"), markdown: `${c("BlockPara")} a paragraph on its own {${tagName}}\n\nsecond ${c("BlockPara2")}` })).node.id as string;
    o.block = (await q<{ id: string }>(`SELECT id::text FROM block_nodes WHERE workspace_id = $1 AND note_id = $2 ORDER BY created_at LIMIT 1`, [ws, blockNote])).rows[0]?.id ?? "";
    if (!o.block) throw new Error("sweep: the tagged paragraph made no block node");
    workspaceSwitch.ws = ws; // grade asks for the deployment's workspace, which the sweep's mock answers from here
    await grade(actor, blockNote, 3, new Date(), { kind: "block", id: o.block }); // so there is a grade to undo
  }
  if (need.has("mute")) o.mute = await muteKeyword(actor, ws, c("MutedWord"));
  if (need.has("credential")) {
    o.credential = (await addCredential(ws, { label: c("Key"), apiKey: SWEEP_API_KEY, baseUrl: "https://api.example.test/v1", protocol: "v1_messages" }, { actor })).id;
  }
  if (need.has("fnTag")) {
    o.fnTag = (await createTag({ actor, workspaceId: ws, name: c("FnTag"), parentId: null })).id;
    await addFunction({ actor, workspaceId: ws, holder: { kind: "node", id: o.fnTag }, functionId: "skills" });
  }
  if (need.has("reviewNote")) {
    await createNote({ ...common, id: o.reviewNote, title: c("Card"), markdown: c("CardBody") });
    workspaceSwitch.ws = ws; // setNoteCard asks for the deployment's workspace, which the sweep's mock answers from here
    await setNoteCard(actor, o.reviewNote, true);
  }
  if (need.has("placedTask")) {
    o.placedTask = await createStandaloneTask({ actor, workspaceId: ws, spaceId: null, title: c("Placed"), markdown: "", fields: { _task_status: "todo" }, uiContext: "test.sweep" });
    workspaceSwitch.ws = ws; // placeTask asks for the deployment's workspace, which the sweep's mock answers from here
    await placeTask(actor, o.placedTask, { note_id: o.note });
  }
  if (need.has("pointer")) o.pointer = (await createPointer(actor, ws, { targetId: o.otherNote, parentId: o.child, displayPrefix: undefined })).id;
  // An ENDED focus session (written directly): a person has one running at a time, and a running one would make
  // every later POST /api/tasks/focus of the same caller a 409.
  if (need.has("focus")) {
    o.focus = (await seedQ<{ id: string }>(
      `INSERT INTO focus_sessions (id, workspace_id, actor_id, task_id, started_at, ended_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '2 hours', now() - interval '1 hour') RETURNING id::text`,
      [ws, actor.id, o.task])).rows[0]!.id;
  }
  o.epoch = (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [ws])).rows[0]!.e;
  await awaitAllDispatchers();
  return o;
}
