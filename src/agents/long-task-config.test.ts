import { describe, expect, it } from "vitest";
import {
  DEFAULT_LONG_TASK_MAX_WAIT_MS,
  resolveLongTaskConfig,
  resolveLongTaskProcessTimeoutSec,
  resolveLongTaskRetentionMsForStatus,
} from "./long-task-config.js";

describe("resolveLongTaskConfig", () => {
  it("uses event-wait defaults", () => {
    const resolved = resolveLongTaskConfig();
    expect(resolved.maxWaitMs).toBe(DEFAULT_LONG_TASK_MAX_WAIT_MS);
    expect(resolved.blockEndTurn).toBe(true);
  });

  it("reads tools.longTask from an OpenClaw config object", () => {
    const resolved = resolveLongTaskConfig({
      tools: {
        longTask: {
          maxWaitMs: 5_000,
          blockEndTurn: false,
          retention: { lostDays: 0.1 },
        },
      },
    });
    expect(resolved.maxWaitMs).toBe(5_000);
    expect(resolved.blockEndTurn).toBe(false);
    expect(resolved.retention.lostMs).toBe(8_640_000);
    expect(resolveLongTaskRetentionMsForStatus("lost", resolved.retention)).toBe(8_640_000);
    expect(resolveLongTaskRetentionMsForStatus("succeeded", resolved.retention)).toBe(
      resolved.retention.succeededMs,
    );
  });

  it("maps maxWaitMs to a whole-second process timeout", () => {
    expect(resolveLongTaskProcessTimeoutSec(1_800_000)).toBe(1_800);
    expect(resolveLongTaskProcessTimeoutSec(1_500)).toBe(2);
    expect(resolveLongTaskProcessTimeoutSec(1)).toBe(1);
  });
});
