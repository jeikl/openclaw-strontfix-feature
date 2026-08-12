/**
 * Gateway-side aggregation of run_stage + thinking agent events into
 * server-persisted diagnosis cards (WebUI only; not model context).
 */
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import {
  saveRunStageCardToStore,
  type RunStageCardRecord,
  type RunStageStoreEntry,
  type RunStageThinkingSegment,
} from "../infra/run-stage-store.js";
import { logInfo } from "../logger.js";

type LiveCard = {
  id: string;
  sessionKey: string;
  runId: string;
  startedAt: number;
  endedAt: number | null;
  stages: RunStageStoreEntry[];
  thinkingText: string;
  thinkingSegments: RunStageThinkingSegment[];
  thinkingStartedAt: number | null;
};

const liveByRunId = new Map<string, LiveCard>();
let started = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
const dirtyRunIds = new Set<string>();

function scheduleFlush(runId: string): void {
  dirtyRunIds.add(runId);
  if (writeTimer) {
    return;
  }
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const ids = [...dirtyRunIds];
    dirtyRunIds.clear();
    for (const id of ids) {
      const card = liveByRunId.get(id);
      if (card) {
        flushCard(card);
      }
    }
  }, 200);
}

function flushCard(live: LiveCard): void {
  const thinkingDurationMs = live.thinkingSegments.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const record: RunStageCardRecord = {
    id: live.id,
    sessionKey: live.sessionKey,
    runId: live.runId,
    startedAt: live.startedAt,
    endedAt: live.endedAt,
    stages: live.stages.map((s) => ({ ...s })),
    thinkingText: live.thinkingText || null,
    thinkingDurationMs: thinkingDurationMs > 0 ? thinkingDurationMs : null,
    thinkingSegments: live.thinkingSegments.map((s) => ({ ...s })),
  };
  saveRunStageCardToStore(record);
  // logInfo(
  //   `[run-stage-card] flushCard id=${live.id} runId=${live.runId} stages=${live.stages.length} thinkingSegs=${live.thinkingSegments.length} endedAt=${live.endedAt}`,
  // );
}

function ensureLive(evt: AgentEventPayload): LiveCard | null {
  const runId = typeof evt.runId === "string" ? evt.runId.trim() : "";
  if (!runId) {
    return null;
  }
  let sessionKey =
    typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey.trim() : "";
  const existing = liveByRunId.get(runId);
  if (existing) {
    if (sessionKey && !existing.sessionKey) {
      existing.sessionKey = sessionKey;
    }
    return existing.sessionKey ? existing : null;
  }
  if (!sessionKey) {
    return null;
  }
  const card: LiveCard = {
    id: `stage-card:${runId}`,
    sessionKey,
    runId,
    startedAt: typeof evt.ts === "number" ? evt.ts : Date.now(),
    endedAt: null,
    stages: [],
    thinkingText: "",
    thinkingSegments: [],
    thinkingStartedAt: null,
  };
  liveByRunId.set(runId, card);
  // logInfo(`[run-stage-card] createLiveCard id=${card.id} runId=${runId} sessionKey=${sessionKey}`);
  return card;
}

function upsertStage(
  live: LiveCard,
  entry: {
    stage: string;
    label: string;
    phase: string;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
  },
): void {
  const activeIdx = live.stages.findIndex((s) => s.stage === entry.stage && s.active);
  if (entry.phase === "start") {
    if (activeIdx >= 0) {
      live.stages[activeIdx] = {
        ...live.stages[activeIdx],
        label: entry.label,
        startedAt: entry.startedAt,
        active: true,
        endedAt: null,
        durationMs: null,
      };
    } else {
      live.stages.push({
        stage: entry.stage,
        label: entry.label,
        startedAt: entry.startedAt,
        active: true,
        endedAt: null,
        durationMs: null,
      });
    }
    if (entry.stage === "thinking") {
      // Seal prior open thinking segment
      const last = live.thinkingSegments[live.thinkingSegments.length - 1];
      if (last && last.endedAt == null) {
        const now = entry.startedAt;
        last.endedAt = now;
        last.durationMs = Math.max(0, now - last.startedAt);
      }
      live.thinkingStartedAt = entry.startedAt;
      live.thinkingSegments.push({
        id: `${live.id}:think:${live.thinkingSegments.length}`,
        text: "",
        startedAt: entry.startedAt,
        endedAt: null,
        durationMs: null,
      });
    }
    return;
  }
  if (entry.phase === "end") {
    const endedAt = entry.endedAt ?? Date.now();
    const durationMs = entry.durationMs ?? Math.max(0, endedAt - entry.startedAt);
    if (activeIdx >= 0) {
      live.stages[activeIdx] = {
        ...live.stages[activeIdx],
        label: entry.label,
        active: false,
        endedAt,
        durationMs,
      };
    } else {
      live.stages.push({
        stage: entry.stage,
        label: entry.label,
        startedAt: entry.startedAt,
        active: false,
        endedAt,
        durationMs,
      });
    }
    if (entry.stage === "thinking") {
      const last = live.thinkingSegments[live.thinkingSegments.length - 1];
      if (last && last.endedAt == null) {
        last.endedAt = endedAt;
        last.durationMs = Math.max(0, endedAt - last.startedAt);
      }
      live.thinkingStartedAt = null;
    }
  }
}

function ensureOpenThinkingSegment(live: LiveCard, ts: number): RunStageThinkingSegment {
  const last = live.thinkingSegments[live.thinkingSegments.length - 1];
  if (last && last.endedAt == null) {
    return last;
  }
  const seg: RunStageThinkingSegment = {
    id: `${live.id}:think:${live.thinkingSegments.length}`,
    text: "",
    startedAt: live.thinkingStartedAt ?? ts,
    endedAt: null,
    durationMs: null,
  };
  live.thinkingSegments.push(seg);
  return seg;
}

function applyThinkingPayload(live: LiveCard, data: Record<string, unknown>, ts: number): void {
  const full = typeof data.text === "string" ? data.text : "";
  const delta = typeof data.delta === "string" ? data.delta : "";
  if (!full && !delta) {
    return;
  }
  const seg = ensureOpenThinkingSegment(live, ts);
  if (full) {
    // Prefer cumulative full text when provided.
    if (!seg.text || full.startsWith(seg.text) || full.length >= seg.text.length) {
      seg.text = full;
    }
    live.thinkingText = full.length >= live.thinkingText.length ? full : live.thinkingText + full;
    if (live.thinkingSegments.length === 1) {
      live.thinkingText = full;
    }
    return;
  }
  seg.text = `${seg.text}${delta}`;
  live.thinkingText = `${live.thinkingText}${delta}`;
}

function handleEvent(evt: AgentEventPayload): void {
  try {
    if (evt.stream === "run_stage") {
      const live = ensureLive(evt);
      if (!live) {
        return;
      }
      const data = evt.data ?? {};
      const stage = typeof data.stage === "string" ? data.stage.trim() : "";
      if (!stage) {
        return;
      }
      const label = (typeof data.label === "string" && data.label.trim()) || stage;
      const phase = typeof data.phase === "string" ? data.phase : "";
      const startedAt =
        typeof data.startedAt === "number" && Number.isFinite(data.startedAt)
          ? data.startedAt
          : typeof evt.ts === "number"
            ? evt.ts
            : Date.now();
      upsertStage(live, {
        stage,
        label,
        phase,
        startedAt,
        endedAt:
          typeof data.endedAt === "number" && Number.isFinite(data.endedAt)
            ? data.endedAt
            : undefined,
        durationMs:
          typeof data.durationMs === "number" && Number.isFinite(data.durationMs)
            ? data.durationMs
            : undefined,
      });
      scheduleFlush(live.runId);
      return;
    }

    if (evt.stream === "thinking") {
      const live = ensureLive(evt);
      if (!live) {
        return;
      }
      const ts = typeof evt.ts === "number" ? evt.ts : Date.now();
      applyThinkingPayload(live, evt.data ?? {}, ts);
      scheduleFlush(live.runId);
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (phase !== "end" && phase !== "error" && phase !== "finishing") {
        return;
      }
      const live = liveByRunId.get(evt.runId);
      if (!live) {
        return;
      }
      const now = typeof evt.ts === "number" ? evt.ts : Date.now();
      live.endedAt = now;
      live.stages = live.stages.map((s) =>
        s.active
          ? {
              ...s,
              active: false,
              endedAt: s.endedAt ?? now,
              durationMs: s.durationMs ?? Math.max(0, now - s.startedAt),
            }
          : s,
      );
      live.thinkingSegments = live.thinkingSegments.map((s) =>
        s.endedAt == null
          ? {
              ...s,
              endedAt: now,
              durationMs: Math.max(0, now - s.startedAt),
            }
          : s,
      );
      flushCard(live);
      liveByRunId.delete(evt.runId);
      dirtyRunIds.delete(evt.runId);
    }
  } catch {
    // never break gateway for diagnosis persistence
  }
}

/** Start gateway-side run-stage diagnosis persistence (idempotent). */
export function startRunStagePersistence(): () => void {
  if (started) {
    return () => {};
  }
  started = true;
  const stop = onAgentEvent(handleEvent);
  return () => {
    stop();
    started = false;
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    // Flush remaining
    for (const card of liveByRunId.values()) {
      flushCard(card);
    }
    liveByRunId.clear();
    dirtyRunIds.clear();
  };
}
