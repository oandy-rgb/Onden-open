import { describe, it, expect, afterEach } from "vitest";
import { createLogger, type LogLevel } from "../logger.js";

// logger.ts is the ops floor's single output chokepoint: every converted call
// site (`[http]`, `[outbox]`, `[dispatcher]`, `[task-scheduler]`, boot lines)
// funnels through it, so a regression here silently degrades EVERY operational
// signal at once. Three contracts are load-bearing:
//
//   1. Level filtering — LOG_LEVEL (default "info") is a severity floor;
//      an unknown value must fall back to "info", never to "log nothing".
//   2. LOG_FORMAT=json — one parseable JSON object per line with the fixed
//      envelope {ts, level, tag, msg} plus caller fields. Errors must survive
//      serialization (a raw Error JSON.stringifies to `{}`).
//   3. Human format (the default) — stays `[tag] message`, the shape docker
//      logs / grep habits are built around, with fields appended as key=value.
//
// The logger reads env PER CALL (dotenv/tests run after module import), so the
// env-fallback tests mutate process.env directly and restore in afterEach.

type Line = { level: LogLevel; line: string };

function capture(): { lines: Line[]; sink: (level: LogLevel, line: string) => void } {
  const lines: Line[] = [];
  return { lines, sink: (level, line) => lines.push({ level, line }) };
}

const envBefore = { LOG_LEVEL: process.env.LOG_LEVEL, LOG_FORMAT: process.env.LOG_FORMAT };
afterEach(() => {
  if (envBefore.LOG_LEVEL === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = envBefore.LOG_LEVEL;
  if (envBefore.LOG_FORMAT === undefined) delete process.env.LOG_FORMAT;
  else process.env.LOG_FORMAT = envBefore.LOG_FORMAT;
});

describe("logger — level filtering", () => {
  it("default floor is info: debug suppressed, info/warn/error pass", () => {
    delete process.env.LOG_LEVEL;
    const { lines, sink } = capture();
    const log = createLogger({ sink });
    log.debug("t", "d");
    log.info("t", "i");
    log.warn("t", "w");
    log.error("t", "e");
    expect(lines.map((l) => l.level)).toEqual(["info", "warn", "error"]);
  });

  it("explicit floor filters strictly below it", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, level: "warn" });
    log.debug("t", "d");
    log.info("t", "i");
    log.warn("t", "w");
    log.error("t", "e");
    expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("level=debug lets everything through", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, level: "debug" });
    log.debug("t", "d");
    log.info("t", "i");
    expect(lines).toHaveLength(2);
  });

  it("unknown LOG_LEVEL falls back to info (never to silence)", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, level: "verbose-typo" });
    log.debug("t", "d");
    log.info("t", "i");
    expect(lines.map((l) => l.level)).toEqual(["info"]);
  });

  it("reads LOG_LEVEL from env per call — a mid-process change takes effect", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, format: "human" }); // Test level changes independently of the host's LOG_FORMAT.
    process.env.LOG_LEVEL = "error";
    log.warn("t", "suppressed");
    process.env.LOG_LEVEL = "debug";
    log.debug("t", "now visible");
    expect(lines.map((l) => l.line)).toEqual(["[t] now visible"]);
  });
});

describe("logger — LOG_FORMAT=json", () => {
  it("emits one JSON object per line with {ts, level, tag, msg, ...fields}", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, format: "json" });
    log.info("http", "GET /api/site 200 12ms", { status: 200, ms: 12 });
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0].line);
    expect(obj.level).toBe("info");
    expect(obj.tag).toBe("http");
    expect(obj.msg).toBe("GET /api/site 200 12ms");
    expect(obj.status).toBe(200);
    expect(obj.ms).toBe(12);
    // ts must be a parseable ISO timestamp, not a locale string.
    expect(Number.isNaN(Date.parse(obj.ts))).toBe(false);
  });

  it("serializes Error fields with message + stack (raw Error stringifies to {})", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, format: "json" });
    log.error("outbox", "reap failed", { err: new Error("boom") });
    const obj = JSON.parse(lines[0].line);
    expect(obj.err.message).toBe("boom");
    expect(typeof obj.err.stack).toBe("string");
    expect(obj.err.stack).toContain("boom");
  });

  it("circular field values degrade to strings instead of dropping the line", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, format: "json" });
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    log.info("t", "circular", { loop });
    const obj = JSON.parse(lines[0].line);
    expect(obj.msg).toBe("circular");
    expect(typeof obj.loop).toBe("string");
  });

  it("reads LOG_FORMAT from env per call", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink });
    process.env.LOG_FORMAT = "json";
    log.info("t", "hello");
    expect(() => JSON.parse(lines[0].line)).not.toThrow();
  });
});

describe("logger — human format (default)", () => {
  it("keeps the historical `[tag] message` shape", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink }); // no LOG_FORMAT → human
    delete process.env.LOG_FORMAT;
    log.info("http", "GET /api/site 200 12ms");
    expect(lines[0].line).toBe("[http] GET /api/site 200 12ms");
  });

  it("appends fields as key=value", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink });
    delete process.env.LOG_FORMAT;
    log.warn("outbox", "re-dirtied mid-drain", { rows: 3 });
    expect(lines[0].line).toBe("[outbox] re-dirtied mid-drain rows=3");
  });

  it("renders Error fields as their stack (what console.error(msg, e) showed)", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink });
    delete process.env.LOG_FORMAT;
    log.error("dispatcher", "catchup failed", { err: new Error("kaput") });
    expect(lines[0].line).toContain("[dispatcher] catchup failed");
    expect(lines[0].line).toContain("kaput");
  });
});
