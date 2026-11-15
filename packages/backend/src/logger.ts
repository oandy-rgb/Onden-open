// ── Structured leveled logger ────────────────────────────────────────────
// Zero-dependency adapter over console — NOT a logging framework. The server
// has always logged `[tag] message` lines straight to stdout/stderr and every
// operational habit (docker logs, grep, the request-log middleware) is built
// around that shape, so the default "human" format keeps it byte-for-byte:
// `[outbox] reap failed` still reads as `[outbox] reap failed`. What the
// adapter adds is the two knobs a deployment actually needs:
//
//   LOG_LEVEL  = debug|info|warn|error (default "info") — severity floor.
//   LOG_FORMAT = json — one JSON object per line ({ts, level, tag, msg,
//                ...fields}) for log shippers; anything else = human format.
//
// Both are read PER CALL, not at module load: dotenv/test setup may run after
// this module is imported (ESM import hoisting), and tests flip the env
// mid-process. The cost is two property reads per log line — irrelevant next
// to the I/O of the line itself.
//
// API mirrors the existing call sites (`console.error("[outbox] reap failed", e)`)
// with the tag split out and the error carried as a field:
//
//   log.error("outbox", "reap failed", { err: e });
//
// Errors are special-cased in both formats — a raw Error JSON.stringifies to
// `{}` (message/stack are non-enumerable), which is exactly the silent
// information loss a structured format must not introduce.

import { config, onConfigWarning } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Unknown/typo'd LOG_LEVEL falls back to "info" rather than throwing or going
// silent: a misconfigured logger that suppresses everything is worse than one
// that ignores the misconfiguration.
function parseLevel(raw: string | undefined): LogLevel {
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

// Error → plain object. `stack` already begins with "Name: message", but we
// keep `message` as its own key so JSON consumers can filter on it without
// parsing the stack string.
function errorToPlain(e: Error): Record<string, unknown> {
  return { message: e.message, ...(e.stack ? { stack: e.stack } : {}) };
}

// Human rendering of a field value. Strings pass through unquoted (the human
// format optimizes for eyeballs, not parsers); Errors render their stack (the
// same thing `console.error(msg, e)` printed before); everything else goes
// through JSON.stringify with a String() fallback for circular structures.
function humanValue(v: unknown): string {
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export interface LoggerOptions {
  /** Severity floor; overrides LOG_LEVEL. Tests inject this. */
  level?: string;
  /** "json" for line-JSON output; overrides LOG_FORMAT. */
  format?: string;
  /** Output sink; overrides the console.* default. Tests capture lines here. */
  sink?: (level: LogLevel, line: string) => void;
}

export interface Logger {
  debug(tag: string, msg: string, fields?: LogFields): void;
  info(tag: string, msg: string, fields?: LogFields): void;
  warn(tag: string, msg: string, fields?: LogFields): void;
  error(tag: string, msg: string, fields?: LogFields): void;
}

// Default sink keeps the console-method ↔ severity mapping the raw call sites
// had (warn → console.warn, error → console.error), so stderr/stdout routing
// and any console capture in the test harness behave exactly as before.
function consoleSink(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const sink = opts.sink ?? consoleSink;

  const emit = (level: LogLevel, tag: string, msg: string, fields?: LogFields): void => {
    const floor = parseLevel(opts.level ?? config.str("LOG_LEVEL"));
    if (RANK[level] < RANK[floor]) return;

    const format = opts.format ?? config.str("LOG_FORMAT");
    if (format === "json") {
      const record: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level,
        tag,
        msg,
      };
      for (const [k, v] of Object.entries(fields ?? {})) {
        record[k] = v instanceof Error ? errorToPlain(v) : v;
      }
      let line: string;
      try {
        line = JSON.stringify(record);
      } catch {
        // Circular field values must not take the whole log line down — coerce
        // every field to a string and keep the envelope intact.
        for (const k of Object.keys(record)) record[k] = String(record[k]);
        line = JSON.stringify(record);
      }
      sink(level, line);
      return;
    }

    // Human format: the historical `[tag] message` line, with any structured
    // fields appended as ` key=value` so nothing passed to the logger is lost.
    let line = `[${tag}] ${msg}`;
    for (const [k, v] of Object.entries(fields ?? {})) {
      line += ` ${k}=${humanValue(v)}`;
    }
    sink(level, line);
  };

  return {
    debug: (tag, msg, fields) => emit("debug", tag, msg, fields),
    info: (tag, msg, fields) => emit("info", tag, msg, fields),
    warn: (tag, msg, fields) => emit("warn", tag, msg, fields),
    error: (tag, msg, fields) => emit("error", tag, msg, fields),
  };
}

/** The process-wide logger. Level/format resolve from the env on every call. */
export const log = createLogger();
onConfigWarning((msg) => log.warn("config", msg));
