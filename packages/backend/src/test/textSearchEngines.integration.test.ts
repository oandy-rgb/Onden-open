// The two text-search engines (services/textSearch.ts) answer the same corpus the same way where the
// product promises it: which notes match, which come first by title, and what the snippet highlights.
// The portable engine always runs (PGlite, or any Postgres); the pgroonga engine runs only on a
// database with the extension, so the production server checks both against each other.
// Where they differ on purpose (relevance order beyond the title tiers, OR/AND precedence) is
// listed in docs/architecture/portable-backend.md and is NOT asserted here.
import { describe, it, expect, beforeAll } from "vitest";
import { searchNodes } from "../services/nodeSearch.js";
import { pgroongaEngine, portableEngine, parsePortableQuery, resetTextSearchEngineChoice, textSearchEngine, type TextSearchEngine } from "../services/textSearch.js";
import { pool, q, getWorkspaceId } from "../db.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(DB);

describe("portable query reading", () => {
  it("words are AND, OR joins neighbours, -x excludes, quotes keep a phrase whole", () => {
    expect(parsePortableQuery("死結")).toEqual({ groups: [["死結"]], excluded: [] });
    expect(parsePortableQuery("死結 排程")).toEqual({ groups: [["死結"], ["排程"]], excluded: [] });
    expect(parsePortableQuery("死結 OR 排程 記憶體")).toEqual({ groups: [["死結", "排程"], ["記憶體"]], excluded: [] });
    expect(parsePortableQuery('"memory leak" -java')).toEqual({ groups: [["memory leak"]], excluded: ["java"] });
    expect(parsePortableQuery("-java")).toEqual({ groups: [], excluded: ["java"] });
    expect(parsePortableQuery("OR a")).toEqual({ groups: [["a"]], excluded: [] });
    expect(parsePortableQuery("a -")).toEqual({ groups: [["a"], ["-"]], excluded: [] });
  });

  it("builds parameters the SQL refers to, and escapes LIKE wildcards in the user's text", () => {
    const params: unknown[] = ["ws"];
    const sql = portableEngine.build("n", "100%_off", params);
    expect(params).toContain("%100\\%\\_off%");
    for (let i = 2; i <= params.length; i++) expect(`${sql.match} ${sql.order} ${sql.keywords}`).toContain(`$${i}`);
    expect(sql.match).not.toContain("100%");
  });

  it("a query of only exclusions matches nothing, as pgroonga does", () => {
    expect(portableEngine.build("n", "-java", []).match).toBe("(false OR false)");
  });
});

describe.skipIf(!isTestDb)("text engines on one corpus (DB)", () => {
  let WS = "";
  let admin: ActorCtx = { id: "", name: "Engine admin", role: "admin", type: "human" };
  const stamp = `${Date.now()}`;
  const title: Record<string, string> = {};
  const word = (s: string) => `${s}${stamp}`;

  const add = async (key: string, noteTitle: string, markdown: string) => {
    title[key] = noteTitle;
    await seedQ(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1,'manual','content',$2,$3,$4)`,
      [WS, noteTitle, `eng-${key}-${stamp}`, markdown],
    );
  };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    admin = await persistActor(WS, admin);
    await add("deadlock", `死結${stamp}`, "兩個行程互相等待對方的資源");
    await add("deadlockGuide", `死結與預防${stamp}`, "銀行家演算法");
    await add("sched", `排程${stamp}`, "CPU 排程與死結的關係，死結 死結");
    await add("mem", `記憶體${stamp}`, "分頁與分段");
    await add("java", `Java${stamp}`, `${word("leak")} memory leak in Java`);
    await add("cpp", `Cpp${stamp}`, `${word("leak")} memory leak in C++`);
  });

  const titles = async (query: string) => (await searchNodes(WS, query, admin, 50)).map((r) => r.title).filter((t) => t.endsWith(stamp));

  describe.each<[string, TextSearchEngine]>([["portable", portableEngine], ["pgroonga", pgroongaEngine]])("%s engine", (name, engine) => {
    let available = true;
    beforeAll(async () => {
      resetTextSearchEngineChoice();
      available = name === "portable" || (await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pgroonga'`)).rows.length > 0;
      process.env.ONDEN_SEARCH_ENGINE = name;
    });
    const run = (fn: () => Promise<void>) => async () => { if (available) await fn(); };

    it("finds a two-character Chinese word in title or body", run(async () => {
      expect(await titles(`死結${stamp}`)).toEqual([title.deadlock]);
      const bodyHits = await titles("死結");
      expect(bodyHits).toEqual(expect.arrayContaining([title.deadlock, title.deadlockGuide, title.sched]));
      expect(bodyHits).not.toContain(title.mem);
    }));

    it("puts the exact title, then the title that starts with the word, before the rest", run(async () => {
      const rank = word(`rankword${name}`); // per engine: both run in one workspace, and the other's notes would rank too
      const heavy = `Notes on ${rank}`;
      for (const [key, t, body] of [["heavy", heavy, `${rank} `.repeat(60)], ["prefix", `${rank} primer`, `${rank}`], ["exact", rank.toUpperCase(), "short"]] as const) {
        const slug = `eng-${key}-${name}-${stamp}`;
        await seedQ(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1,'manual','content',$2,$3,$4) ON CONFLICT DO NOTHING`, [WS, t, slug, body]);
      }
      expect((await searchNodes(WS, rank, admin, 50)).map((r) => r.title).slice(0, 3)).toEqual([rank.toUpperCase(), `${rank} primer`, heavy]);
    }));

    it("orders titles exact, then prefix, then containing the text whole, then the rest", run(async () => {
      const label = word(`tier${name}`);
      // "Tier 6" with a number: the words alone also match "Tier 166 …" (both words in the title).
      const base = `Tier ${label}`;
      for (const [key, t, body] of [
        ["words", `Tier 166 ${label}`, `${label} `.repeat(80)], ["body", "Unrelated title", `${base} in the body`],
        ["contains", `My ${base} draft`, ""], ["prefix", `${base} primer`, ""], ["exact", base, ""],
        // Glued onto the typed text (`Tier x0` for `Tier x`): ILIKE finds it, pgroonga's tokenizer does not (it matches
        // whole tokens), so this row is only part of the portable engine's answer (docs/architecture/portable-backend.md).
        ...(name === "portable" ? [["glued", `${base}0`, ""]] as const : []),
      ] as const) {
        await seedQ(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1,'manual','content',$2,$3,$4) ON CONFLICT DO NOTHING`, [WS, t, `eng-tier-${key}-${name}-${stamp}`, body]);
      }
      const found = (await searchNodes(WS, base, admin, 50)).map((r) => r.title);
      const glued = name === "portable" ? [`${base}0`] : [];
      // Exact, then a title starting with the text (at a word boundary on both engines; glued on, portable only),
      // then one containing it whole.
      expect(found[0]).toBe(base);
      expect(new Set(found.slice(1, 2 + glued.length))).toEqual(new Set([`${base} primer`, ...glued]));
      expect(found[2 + glued.length]).toBe(`My ${base} draft`);
      // The last two (words apart in the title; text only in the body) are matches, after every tier above.
      expect(new Set(found.slice(3 + glued.length))).toEqual(new Set([`Tier 166 ${label}`, "Unrelated title"]));
    }));

    it("OR matches either side", run(async () => {
      expect(new Set(await titles(`${title.deadlock} OR ${title.mem}`.replace(/ /g, " ")))).toEqual(new Set([title.deadlock, title.mem]));
    }));

    it("-word excludes, a quoted phrase must appear together", run(async () => {
      expect(await titles(`${word("leak")} -Java`)).toEqual([title.cpp]);
      expect(await titles(`"memory leak" ${word("leak")} -C++`)).toEqual([title.java]);
      expect(await titles(`"leak memory" ${word("leak")}`)).toEqual([]);
    }));

    it("highlights the words that matched, not the excluded ones", run(async () => {
      const hit = (await searchNodes(WS, `${word("leak")} -Java`, admin, 50)).find((r) => r.title === title.cpp)!;
      expect(hit.snippet?.text).toContain(word("leak"));
      expect(hit.snippet?.ranges.length).toBeGreaterThan(0);
    }));

    it("keeps the result shape: id, title, slug, node_type, snippet, is_task", run(async () => {
      const [row] = await searchNodes(WS, `${word("leak")} -Java`, admin, 50);
      expect(Object.keys(row!).sort()).toEqual(["id", "is_task", "node_type", "slug", "snippet", "title"]);
    }));
  });

  it("chooses pgroonga when the extension exists, portable when it does not", async () => {
    delete process.env.ONDEN_SEARCH_ENGINE;
    resetTextSearchEngineChoice();
    const hasPgroonga = (await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pgroonga'`)).rows.length > 0;
    expect((await textSearchEngine()).name).toBe(hasPgroonga ? "pgroonga" : "portable");
  });
});
