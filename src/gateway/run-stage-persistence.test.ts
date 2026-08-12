// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { listRunStageCardsForSession } from "../infra/run-stage-store.js";
import { startRunStagePersistence } from "./run-stage-persistence.js";

const NOW = new Date("2026-05-09T00:00:00.000Z").getTime();

function emitRunStage(
  runId: string,
  stage: string,
  label: string,
  phase: "start" | "end",
  startedAt: number,
  endedAt?: number,
) {
  emitAgentEvent({
    runId,
    stream: "run_stage",
    sessionKey: "main",
    data: { stage, label, phase, startedAt, ...(endedAt !== undefined ? { endedAt } : {}) },
  });
}

function emitThinking(runId: string, text: string) {
  emitAgentEvent({ runId, stream: "thinking", sessionKey: "main", data: { text } });
}

describe("gateway run-stage persistence single card", () => {
  let stateDir: string;
  let stop: (() => void) | null = null;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-run-stage-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    stop = startRunStagePersistence();
  });

  afterEach(() => {
    stop?.();
    stop = null;
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("keeps ONE accumulated card per run across multi-round thinking", () => {
    // Round 1: prep -> model_first -> thinking -> tool -> reply.
    emitRunStage("run-1", "startup", "启动", "start", NOW + 1);
    emitRunStage("run-1", "model_first", "等待模型首包", "start", NOW + 2);
    emitRunStage("run-1", "model_first", "等待模型首包", "end", NOW + 2, NOW + 10);
    emitRunStage("run-1", "thinking", "模型思考", "start", NOW + 11);
    emitThinking("run-1", "第一轮思考");
    emitRunStage("run-1", "thinking", "模型思考", "end", NOW + 11, NOW + 50);
    emitRunStage("run-1", "tool", "工具执行 · cron", "start", NOW + 51);
    emitRunStage("run-1", "tool", "工具执行 · cron", "end", NOW + 51, NOW + 100);
    emitRunStage("run-1", "reply", "模型正文输出", "start", NOW + 101);
    emitRunStage("run-1", "reply", "模型正文输出", "end", NOW + 101, NOW + 150);

    // Round 2: model_first -> thinking -> tool (exec2) -> reply — same card.
    emitRunStage("run-1", "model_first", "等待模型首包", "start", NOW + 151);
    emitRunStage("run-1", "model_first", "等待模型首包", "end", NOW + 151, NOW + 160);
    emitRunStage("run-1", "thinking", "模型思考", "start", NOW + 161);
    emitThinking("run-1", "第二轮思考");
    emitRunStage("run-1", "thinking", "模型思考", "end", NOW + 161, NOW + 200);
    emitRunStage("run-1", "tool", "工具调用 · exec2", "start", NOW + 201);
    emitRunStage("run-1", "tool", "工具调用 · exec2", "end", NOW + 201, NOW + 250);
    emitRunStage("run-1", "reply", "模型正文输出", "start", NOW + 251);
    emitRunStage("run-1", "reply", "模型正文输出", "end", NOW + 251, NOW + 300);

    // Terminal lifecycle flushes the card synchronously.
    emitAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      sessionKey: "main",
      data: { phase: "end" },
    });

    const cards = listRunStageCardsForSession("main");
    expect(cards.map((c) => c.id)).toEqual(["stage-card:run-1"]);

    const card = cards[0];
    expect(card?.stages.map((s) => s.stage)).toEqual([
      "startup",
      "model_first",
      "thinking",
      "tool",
      "reply",
      "model_first",
      "thinking",
      "tool",
      "reply",
    ]);
    // One thinking segment per round.
    expect(card?.thinkingSegments?.map((s) => s.text)).toEqual(["第一轮思考", "第二轮思考"]);
    expect(card?.endedAt).not.toBeNull();
  });
});
