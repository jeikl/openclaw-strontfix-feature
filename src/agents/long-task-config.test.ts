import { describe, expect, it } from "vitest";
import {
  DEFAULT_LONG_TASK_MAX_WAIT_MS,
  DEFAULT_LONG_TASK_SHORT_POLLS,
  DEFAULT_LONG_TASK_SHORT_POLL_TIMEOUT_MS,
  resolveLongTaskConfig,
  resolveLongTaskRetentionMsForStatus,
} from "./long-task-config.js";

describe("resolveLongTaskConfig", () => {
  it("uses internal state-machine defaults (4 short polls, not model calls)", () => {
    const resolved = resolveLongTaskConfig();
    expect(resolved.shortPolls).toBe(DEFAULT_LONG_TASK_SHORT_POLLS);
    expect(resolved.shortPolls).toBe(4);
    expect(resolved.shortPollTimeoutMs).toBe(DEFAULT_LONG_TASK_SHORT_POLL_TIMEOUT_MS);
    expect(resolved.maxWaitMs).toBe(DEFAULT_LONG_TASK_MAX_WAIT_MS);
    expect(resolved.blockEndTurn).toBe(true);
  });

  it("reads tools.longTask from an OpenClaw config object", () => {
    const resolved = resolveLongTaskConfig({
      tools: {
        longTask: {
          shortPolls: 2,
          shortPollTimeoutMs: 500,
          maxWaitMs: 5_000,
          blockEndTurn: false,
          retention: { lostMs: 1_000 },
        },
      },
    });
    expect(resolved.shortPolls).toBe(2);
    expect(resolved.shortPollTimeoutMs).toBe(500);
    expect(resolved.maxWaitMs).toBe(5_000);
    expect(resolved.blockEndTurn).toBe(false);
    expect(resolved.retention.lostMs).toBe(1_000);
    expect(resolveLongTaskRetentionMsForStatus("lost", resolved.retention)).toBe(1_000);
    expect(resolveLongTaskRetentionMsForStatus("succeeded", resolved.retention)).toBe(
      resolved.retention.succeededMs,
    );
  });
});
