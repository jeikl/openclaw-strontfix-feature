/**
 * Resolves tools.longTask runtime defaults.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LongTaskConfig, LongTaskRetentionConfig } from "../config/types.tools.js";

export const DEFAULT_LONG_TASK_MAX_WAIT_MS = 1_800_000;
export const DEFAULT_LONG_TASK_BLOCK_END_TURN = true;
export const MS_PER_DAY = 24 * 60 * 60_000;
export const DEFAULT_LONG_TASK_RETENTION_SUCCEEDED_DAYS = 7;
export const DEFAULT_LONG_TASK_RETENTION_FAILED_DAYS = 7;
export const DEFAULT_LONG_TASK_RETENTION_LOST_DAYS = 1;
export const DEFAULT_LONG_TASK_RETENTION_OUTPUT_DAYS = 3;
export const DEFAULT_LONG_TASK_RETENTION_SUCCEEDED_MS =
  DEFAULT_LONG_TASK_RETENTION_SUCCEEDED_DAYS * MS_PER_DAY;
export const DEFAULT_LONG_TASK_RETENTION_FAILED_MS =
  DEFAULT_LONG_TASK_RETENTION_FAILED_DAYS * MS_PER_DAY;
export const DEFAULT_LONG_TASK_RETENTION_LOST_MS =
  DEFAULT_LONG_TASK_RETENTION_LOST_DAYS * MS_PER_DAY;
export const DEFAULT_LONG_TASK_RETENTION_OUTPUT_MS =
  DEFAULT_LONG_TASK_RETENTION_OUTPUT_DAYS * MS_PER_DAY;
export const DEFAULT_LONG_TASK_SUMMARY_MAX_CHARS = 4_000;

export type ResolvedLongTaskRetention = {
  succeededMs: number;
  failedMs: number;
  lostMs: number;
  outputMs: number;
};

export type ResolvedLongTaskConfig = {
  maxWaitMs: number;
  blockEndTurn: boolean;
  retention: ResolvedLongTaskRetention;
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function resolveRetentionDaysToMs(value: unknown, fallbackDays: number): number {
  const days =
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallbackDays;
  return Math.max(0, Math.round(days * MS_PER_DAY));
}

export function resolveLongTaskRetention(
  retention?: LongTaskRetentionConfig,
): ResolvedLongTaskRetention {
  return {
    succeededMs: resolveRetentionDaysToMs(
      retention?.succeededDays,
      DEFAULT_LONG_TASK_RETENTION_SUCCEEDED_DAYS,
    ),
    failedMs: resolveRetentionDaysToMs(
      retention?.failedDays,
      DEFAULT_LONG_TASK_RETENTION_FAILED_DAYS,
    ),
    lostMs: resolveRetentionDaysToMs(retention?.lostDays, DEFAULT_LONG_TASK_RETENTION_LOST_DAYS),
    outputMs: resolveRetentionDaysToMs(
      retention?.outputDays,
      DEFAULT_LONG_TASK_RETENTION_OUTPUT_DAYS,
    ),
  };
}

export function resolveLongTaskConfig(
  input?: LongTaskConfig | OpenClawConfig | null,
): ResolvedLongTaskConfig {
  const configured =
    input && typeof input === "object" && "tools" in input
      ? (input.tools?.longTask as LongTaskConfig | undefined)
      : (input as LongTaskConfig | undefined);
  return {
    maxWaitMs: clampInt(configured?.maxWaitMs, DEFAULT_LONG_TASK_MAX_WAIT_MS, 1_000, 86_400_000),
    blockEndTurn: configured?.blockEndTurn !== false,
    retention: resolveLongTaskRetention(configured?.retention),
  };
}

/** Process lifetime for exec, in seconds. Owned by tools.longTask.maxWaitMs. */
export function resolveLongTaskProcessTimeoutSec(maxWaitMs: number): number {
  return Math.max(1, Math.ceil(maxWaitMs / 1000));
}

export function resolveLongTaskRetentionMsForStatus(
  status: "succeeded" | "failed" | "timed_out" | "cancelled" | "lost",
  retention: ResolvedLongTaskRetention,
): number {
  if (status === "lost") {
    return retention.lostMs;
  }
  if (status === "succeeded") {
    return retention.succeededMs;
  }
  return retention.failedMs;
}
