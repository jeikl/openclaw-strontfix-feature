/**
 * Hang hot-path tracer for jeikclaw internal diagnosis.
 *
 * Writes structured lines next to the external hang monitor logs so operators can
 * correlate process-external healthz hangs with internal sanitize/repair phases.
 *
 * Default path: /root/openclaw-monitor/logs/jeikclaw-internal-YYYY-MM-DD.log
 * Override: OPENCLAW_HANG_HOTPATH_LOG_DIR
 *
 * Timestamps are always Asia/Shanghai (北京时间) with explicit +08:00 offset.
 *
 * Logging is best-effort and synchronous (appendFileSync) so lines still land
 * when the event loop is under CPU spin and async flushes may starve.
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export type HangHotpathPhase = "before" | "during" | "after" | "warn" | "error" | "yield";

export type HangHotpathFields = Record<string, string | number | boolean | null | undefined>;

const DEFAULT_LOG_DIR = "/root/openclaw-monitor/logs";
const ENABLED =
  process.env.OPENCLAW_HANG_HOTPATH_TRACE !== "0" &&
  process.env.OPENCLAW_HANG_HOTPATH_TRACE !== "false";

let ensuredDir: string | null = null;
let seq = 0;

function resolveLogDir(): string {
  const raw = process.env.OPENCLAW_HANG_HOTPATH_LOG_DIR?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_LOG_DIR;
}

function beijingTimestamp(date = new Date()): string {
  // en-CA → YYYY-MM-DD, 24h clock parts for Asia/Shanghai
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  // Use a fixed +08:00 label (CST / 北京时间); DST not used in China.
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}.${ms}+08:00`;
}

function beijingDateStamp(date = new Date()): string {
  return beijingTimestamp(date).slice(0, 10);
}

function ensureLogDir(): string {
  const dir = resolveLogDir();
  if (ensuredDir === dir) {
    return dir;
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch {
    // ignore — write will no-op
  }
  ensuredDir = dir;
  return dir;
}

function resolveLogFile(): string {
  return path.join(ensureLogDir(), `jeikclaw-internal-${beijingDateStamp()}.log`);
}

function scrub(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.replace(/[\r\n\t]+/g, " ").slice(0, 500);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value)
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 500);
  } catch {
    return String(value).slice(0, 200);
  }
}

/**
 * Append one structured line. Never throws to callers.
 */
export function hangHotpathLog(
  site: string,
  phase: HangHotpathPhase,
  fields: HangHotpathFields = {},
): void {
  if (!ENABLED) {
    return;
  }
  try {
    seq += 1;
    const ts = beijingTimestamp();
    const parts: string[] = [
      `ts=${ts}`,
      `seq=${seq}`,
      `pid=${process.pid}`,
      `site=${scrub(site)}`,
      `phase=${phase}`,
    ];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) {
        continue;
      }
      parts.push(`${k}=${scrub(v)}`);
    }
    fs.appendFileSync(resolveLogFile(), `${parts.join(" ")}\n`, { encoding: "utf8", mode: 0o644 });
  } catch {
    // never break the gateway for diagnostics
  }
}

/**
 * Run a synchronous hot-path body with before/after (and durationMs) logging.
 */
export function hangHotpathSyncSpan<T>(site: string, fields: HangHotpathFields, body: () => T): T {
  const t0 = performance.now();
  hangHotpathLog(site, "before", { ...fields, t0_ms: Math.round(t0) });
  try {
    const result = body();
    const dt = performance.now() - t0;
    hangHotpathLog(site, "after", {
      ...fields,
      duration_ms: Math.round(dt * 1000) / 1000,
      ok: true,
    });
    if (dt >= 500) {
      hangHotpathLog(site, "warn", {
        ...fields,
        duration_ms: Math.round(dt * 1000) / 1000,
        reason: "slow_hotpath_ge_500ms",
      });
    }
    if (dt >= 5000) {
      hangHotpathLog(site, "warn", {
        ...fields,
        duration_ms: Math.round(dt * 1000) / 1000,
        reason: "critical_hotpath_ge_5s_event_loop_risk",
      });
    }
    return result;
  } catch (err) {
    const dt = performance.now() - t0;
    hangHotpathLog(site, "error", {
      ...fields,
      duration_ms: Math.round(dt * 1000) / 1000,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Async span with optional cooperative yields between stages.
 */
export async function hangHotpathAsyncSpan<T>(
  site: string,
  fields: HangHotpathFields,
  body: () => Promise<T>,
): Promise<T> {
  const t0 = performance.now();
  hangHotpathLog(site, "before", { ...fields, t0_ms: Math.round(t0) });
  try {
    const result = await body();
    const dt = performance.now() - t0;
    hangHotpathLog(site, "after", {
      ...fields,
      duration_ms: Math.round(dt * 1000) / 1000,
      ok: true,
    });
    if (dt >= 500) {
      hangHotpathLog(site, "warn", {
        ...fields,
        duration_ms: Math.round(dt * 1000) / 1000,
        reason: "slow_hotpath_ge_500ms",
      });
    }
    if (dt >= 5000) {
      hangHotpathLog(site, "warn", {
        ...fields,
        duration_ms: Math.round(dt * 1000) / 1000,
        reason: "critical_hotpath_ge_5s_event_loop_risk",
      });
    }
    return result;
  } catch (err) {
    const dt = performance.now() - t0;
    hangHotpathLog(site, "error", {
      ...fields,
      duration_ms: Math.round(dt * 1000) / 1000,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** Yield to the event loop so healthz can run during long async pipelines. */
export async function hangHotpathYield(site: string, stage: string): Promise<void> {
  hangHotpathLog(site, "yield", { stage });
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Progress tick inside long sync loops (call sparingly).
 * Uses wall clock to avoid flooding when N is huge.
 */
export function createHangHotpathProgress(
  site: string,
  everyMs = 1000,
): {
  tick: (fields: HangHotpathFields) => void;
  finish: (fields?: HangHotpathFields) => void;
} {
  let last = performance.now();
  let ticks = 0;
  return {
    tick(fields: HangHotpathFields) {
      const now = performance.now();
      if (now - last < everyMs) {
        return;
      }
      last = now;
      ticks += 1;
      hangHotpathLog(site, "during", { ...fields, progress_tick: ticks });
    },
    finish(fields: HangHotpathFields = {}) {
      hangHotpathLog(site, "during", { ...fields, progress_tick: ticks, progress_done: true });
    },
  };
}

export function hangHotpathLogPathToday(): string {
  return resolveLogFile();
}
