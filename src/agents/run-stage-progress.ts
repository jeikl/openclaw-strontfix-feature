/**
 * Control-UI run stage progress: emit only high-latency milestones so operators
 * can see where a turn spends wall time (sanitize, model first token, tools…).
 *
 * Stream: `run_stage` on the shared agent event bus.
 * Payload: { stage, label, phase: "start"|"end", startedAt, endedAt?, durationMs? }
 */
import { emitAgentEvent } from "../infra/agent-events.js";

/** Stages that commonly dominate TTFT / turn latency. Keep this list short. */
export const RUN_STAGE_LABELS = {
  startup: "启动/鉴权/插件",
  sanitize: "历史修复 sanitize",
  compaction: "上下文压缩",
  prompt: "组装 prompt",
  model_first: "等待模型首包",
  thinking: "模型思考",
  reply: "模型正文输出",
  tool: "工具执行",
  finalize: "回合收尾",
} as const;

export type RunStageId = keyof typeof RUN_STAGE_LABELS;

type StageClock = {
  startedAt: number;
};

const activeStagesByRun = new Map<string, Map<RunStageId, StageClock>>();

function stageMap(runId: string): Map<RunStageId, StageClock> {
  let map = activeStagesByRun.get(runId);
  if (!map) {
    map = new Map();
    activeStagesByRun.set(runId, map);
  }
  return map;
}

function resolveLabel(stage: RunStageId, detail?: string): string {
  const base = RUN_STAGE_LABELS[stage];
  const trimmed = detail?.trim();
  return trimmed ? `${base} · ${trimmed}` : base;
}

export type RunStageEmitParams = {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
  stage: RunStageId;
  detail?: string;
};

/** Begin a stage (no-op if already open for the same stage). */
export function beginRunStage(params: RunStageEmitParams): void {
  if (!params.runId) {
    return;
  }
  const map = stageMap(params.runId);
  if (map.has(params.stage)) {
    return;
  }
  const startedAt = Date.now();
  map.set(params.stage, { startedAt });
  const label = resolveLabel(params.stage, params.detail);
  try {
    emitAgentEvent({
      runId: params.runId,
      stream: "run_stage",
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      data: {
        stage: params.stage,
        label,
        phase: "start",
        startedAt,
      },
    });
  } catch {
    // never break the run for UI diagnostics
  }
}

/** End a stage and emit durationMs. Returns duration or null if stage was not open. */
export function endRunStage(params: RunStageEmitParams): number | null {
  if (!params.runId) {
    return null;
  }
  const map = activeStagesByRun.get(params.runId);
  const clock = map?.get(params.stage);
  if (!clock) {
    return null;
  }
  map?.delete(params.stage);
  if (map && map.size === 0) {
    activeStagesByRun.delete(params.runId);
  }
  const endedAt = Date.now();
  const durationMs = Math.max(0, endedAt - clock.startedAt);
  const label = resolveLabel(params.stage, params.detail);
  try {
    emitAgentEvent({
      runId: params.runId,
      stream: "run_stage",
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      data: {
        stage: params.stage,
        label,
        phase: "end",
        startedAt: clock.startedAt,
        endedAt,
        durationMs,
      },
    });
  } catch {
    // ignore
  }
  return durationMs;
}

/** End every open stage for a run (lifecycle end / abort). */
export function endAllRunStages(params: {
  runId: string;
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
}): void {
  const map = activeStagesByRun.get(params.runId);
  if (!map || map.size === 0) {
    activeStagesByRun.delete(params.runId);
    return;
  }
  const stages = [...map.keys()];
  for (const stage of stages) {
    endRunStage({ ...params, stage });
  }
}

/** True when this stage is currently open for the run. */
export function isRunStageActive(runId: string, stage: RunStageId): boolean {
  return Boolean(activeStagesByRun.get(runId)?.has(stage));
}
