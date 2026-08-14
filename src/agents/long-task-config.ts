/**
 * Resolves tools.longTask runtime defaults.
 * shortPolls is an internal state-machine slice count, not a model tool-call budget.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LongTaskConfig, LongTaskRetentionConfig } from "../config/types.tools.js";

export const DEFAULT_LONG_TASK_SHORT_POLLS = 4;
export const DEFAULT_LONG_TASK_SHORT_POLL_TIMEOUT_MS = 10_000;
export const DEFAULT_LONG_TASK_MAX_WAIT_MS = 1_800_000;
export const DEFAULT_LONG_TASK_BLOCK_END_TURN = true;
export const DEFAULT_LONG_TASK_RETENTION_SUCCEEDED_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_LONG_TASK_RETENTION_FAILED_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_LONG_TASK_RETENTION_LOST_MS = 24 * 60 * 60_000;
export const DEFAULT_LONG_TASK_RETENTION_OUTPUT_MS = 3 * 24 * 60 * 60_000;
export const DEFAULT_LONG_TASK_SUMMARY_MAX_CHARS = 4_000;

export type ResolvedLongTaskRetention = {
  succeededMs: number;
  failedMs: number;
  lostMs: number;
  outputMs: number;
};

export type ResolvedLongTaskConfig = {
  shortPolls: number;
  shortPollTimeoutMs: number;
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

function resolveRetentionMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function resolveLongTaskRetention(
  retention?: LongTaskRetentionConfig,
): ResolvedLongTaskRetention {
  return {
    succeededMs: resolveRetentionMs(
      retention?.succeededMs,
      DEFAULT_LONG_TASK_RETENTION_SUCCEEDED_MS,
    ),
    failedMs: resolveRetentionMs(retention?.failedMs, DEFAULT_LONG_TASK_RETENTION_FAILED_MS),
    lostMs: resolveRetentionMs(retention?.lostMs, DEFAULT_LONG_TASK_RETENTION_LOST_MS),
    outputMs: resolveRetentionMs(retention?.outputMs, DEFAULT_LONG_TASK_RETENTION_OUTPUT_MS),
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
    shortPolls: clampInt(configured?.shortPolls, DEFAULT_LONG_TASK_SHORT_POLLS, 1, 20),
    shortPollTimeoutMs: clampInt(
      configured?.shortPollTimeoutMs,
      DEFAULT_LONG_TASK_SHORT_POLL_TIMEOUT_MS,
      100,
      60_000,
    ),
    maxWaitMs: clampInt(configured?.maxWaitMs, DEFAULT_LONG_TASK_MAX_WAIT_MS, 1_000, 86_400_000),
    blockEndTurn: configured?.blockEndTurn !== false,
    retention: resolveLongTaskRetention(configured?.retention),
  };
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
