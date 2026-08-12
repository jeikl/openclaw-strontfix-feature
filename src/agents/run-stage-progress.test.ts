import { describe, expect, it } from "vitest";
import {
  beginRunStage,
  endAllRunStages,
  endRunStage,
  isRunStageActive,
  RUN_STAGE_LABELS,
} from "./run-stage-progress.js";

describe("run-stage-progress", () => {
  it("tracks begin/end duration and clears all stages", async () => {
    const runId = `test-${Date.now()}`;
    beginRunStage({ runId, stage: "sanitize" });
    expect(isRunStageActive(runId, "sanitize")).toBe(true);
    await new Promise((r) => setTimeout(r, 15));
    const ms = endRunStage({ runId, stage: "sanitize" });
    expect(ms).toBeGreaterThanOrEqual(10);
    expect(isRunStageActive(runId, "sanitize")).toBe(false);

    beginRunStage({ runId, stage: "model_first" });
    beginRunStage({ runId, stage: "thinking" });
    endAllRunStages({ runId });
    expect(isRunStageActive(runId, "model_first")).toBe(false);
    expect(isRunStageActive(runId, "thinking")).toBe(false);
  });

  it("exposes Chinese labels for key slow stages", () => {
    expect(RUN_STAGE_LABELS.sanitize).toContain("sanitize");
    expect(RUN_STAGE_LABELS.model_first).toContain("首包");
    expect(RUN_STAGE_LABELS.thinking).toContain("思考");
  });
});
