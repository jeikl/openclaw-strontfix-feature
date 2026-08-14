import { describe, expect, it } from "vitest";
import {
  DEFAULT_LONG_TASK_MAX_WAIT_MS,
  resolveLongTaskConfig,
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
});
