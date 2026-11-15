// D76: one search snippet contract — plain text + highlight ranges — from the
// server and from the app's on-device index alike. Before: the server's
// pgroonga snippet arrived HTML-escaped (`Q&amp;A for &lt;tips&gt;` on
// screen), the local FTS snippet quoted raw markdown and marked itself up with
// `<mark>` (a note containing `<mark>` highlighted its own text), and the LIKE
// fallback (short or CJK queries) gave no snippet at all. The server is held
// to the same fixture (backend searchSnippets.integration.test.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import initSqlJs from "sql.js";
import type { Snippet } from "@onden/markdown";
import { prepareLocalDatabase } from "../lib/localDbSchema";
import { SnippetText } from "../components/SnippetText";
import fixtureJson from "../../../markdown/src/fixtures/searchSnippets.json";

const fixture = fixtureJson as unknown as {
  cases: Array<{ name: string; markdown: string; query: string; expected: Snippet }>;
};

const disk = vi.hoisted(() => ({ bytes: null as ArrayBuffer | null }));
vi.mock("../lib/indexedDbStorage", () => ({ idbLoad: async () => disk.bytes, idbSave: async (bytes: ArrayBuffer) => { disk.bytes = bytes; } }));
vi.mock("sql.js", async (original) => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});

let receive: (event: { data: { id: number; op: string; args: unknown[]; storageScope: string | null } }) => void;
let sequence = 0;
const replies = new Map<number, (reply: { ok: boolean; result?: unknown; error?: string }) => void>();

function rpc<T>(op: string, ...args: unknown[]): Promise<T> {
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => {
    replies.set(id, (reply) => (reply.ok ? resolve(reply.result as T) : reject(new Error(reply.error))));
    receive({ data: { id, op, args, storageScope: null } });
  });
}

const noteId = (i: number) => `note-${i}`;

async function snapshot(): Promise<ArrayBuffer> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  prepareLocalDatabase(db);
  db.run("INSERT INTO workspace (id, name, slug) VALUES ('w', 'Test', 'test')");
  fixture.cases.forEach((c, i) => {
    db.run("INSERT INTO nodes (id, source_type, node_type, title, slug, markdown) VALUES (?, 'local', 'content', ?, ?, ?)",
      [noteId(i), `Fixture ${i}`, `fixture-${i}`, c.markdown]);
  });
  db.run("INSERT INTO nodes (id, source_type, node_type, title, slug, markdown) VALUES ('t', 'local', 'content', 'Kafka title only', 'kafka-title', 'nothing here')");
  const bytes = db.export().buffer as ArrayBuffer;
  db.close();
  return bytes;
}

type Row = { id: string; snippet: Snippet | null };

beforeAll(async () => { disk.bytes = await snapshot(); });

beforeEach(async () => {
  vi.resetModules();
  const worker = { onmessage: null, postMessage: (reply: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    replies.get(reply.id)?.(reply); replies.delete(reply.id);
  } };
  vi.stubGlobal("self", worker);
  await import("../lib/localDbWorker");
  receive = worker.onmessage!;
  await rpc("initLocalDb");
});

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllTimers(); });

describe("local search snippets (on-device index)", () => {
  fixture.cases.forEach((c, i) => {
    it(`agrees with the shared fixture: ${c.name}`, async () => {
      const rows = await rpc<Row[]>("searchNodes", c.query);
      expect(rows.find((r) => r.id === noteId(i))?.snippet).toEqual(c.expected);
    });
  });

  it("gives a snippet on the LIKE fallback too (a one-character query)", async () => {
    const rows = await rpc<Row[]>("searchNodes", "識");
    const cjk = fixture.cases.findIndex((c) => c.name === "cjk");
    const snippet = rows.find((r) => r.id === noteId(cjk))?.snippet;
    expect(snippet?.ranges.map(([a, b]) => snippet.text.slice(a, b))).toEqual(["識", "識"]);
  });

  it("has no snippet for a title-only match", async () => {
    const rows = await rpc<Row[]>("searchNodes", "Kafka title");
    expect(rows).toEqual([{ id: "t", snippet: null }]);
  });

  it("does not read a note's own <mark> text as a highlight", async () => {
    const escaped = fixture.cases.findIndex((c) => c.name.startsWith("escapes"));
    const rows = await rpc<Row[]>("searchNodes", "tricks");
    const snippet = rows.find((r) => r.id === noteId(escaped))!.snippet!;
    expect(snippet.text).toBe("Q&A: <tips> & <mark>tricks</mark> on kafka");
    expect(snippet.ranges).toEqual([[20, 26]]);
  });
});

describe("SnippetText renders the contract", () => {
  const show = (snippet: Snippet) => {
    const { container } = render(<SnippetText snippet={snippet} markClassName="hl" />);
    return { text: container.textContent, marks: [...container.querySelectorAll("mark.hl")].map((m) => m.textContent), html: container.innerHTML };
  };

  it("shows & and < in a note literally (no entities, no markup)", () => {
    const { expected } = fixture.cases.find((c) => c.name.startsWith("escapes"))!;
    const out = show(expected);
    expect(out.text).toBe("Q&A: <tips> & <mark>tricks</mark> on kafka");
    expect(out.text).not.toContain("&amp;");
    expect(out.marks).toEqual(["kafka"]);
    // The note's own `<mark>` is text, escaped in the DOM, not an element.
    expect(out.html).toContain("&lt;mark&gt;tricks");
  });

  it("puts the highlights on the matched CJK characters", () => {
    expect(show(fixture.cases.find((c) => c.name === "cjk")!.expected).marks).toEqual(["共識", "共識"]);
  });

  it("puts the highlight on the right characters after astral emoji", () => {
    const out = show(fixture.cases.find((c) => c.name.startsWith("astral"))!.expected);
    expect(out.marks).toEqual(["kafka"]);
    expect(out.text).toBe("😀🎉 party 🎉 then kafka 😀 again");
  });

  it("highlights every term in a markdown body, quoting it as plain text", () => {
    const out = show(fixture.cases.find((c) => c.name.startsWith("markdown"))!.expected);
    expect(out.marks).toEqual(["Kafka", "Kafka", "streams", "kafka"]);
    expect(out.text).not.toMatch(/\*\*|\[\[|---|#/);
  });
});
