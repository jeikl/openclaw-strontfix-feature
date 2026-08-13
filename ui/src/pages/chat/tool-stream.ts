// Control UI module implements app tool stream behavior.
import { stripInlineDirectiveTagsForDelivery } from "../../../../src/utils/directive-tags.js";
import type { ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import { formatUnknownText, truncateText } from "../../lib/format.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";
import {
  appendThinkingToSegments,
  createRunStageCardId,
  joinThinkingSegmentsForDisplay,
  saveRunStageCardEverywhere,
  sealOpenThinkingSegments,
  type ChatRunStageCard,
  type ChatThinkingSegment,
} from "./run-stage-ui.ts";

const TOOL_STREAM_LIMIT = 50;
const TOOL_STREAM_THROTTLE_MS = 80;
const TOOL_OUTPUT_CHAR_LIMIT = 120_000;

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  sessionKey?: string;
  agentId?: string;
  data: Record<string, unknown>;
};

type SessionOperationEventPayload = {
  operationId?: string;
  operation?: string;
  phase?: string;
  sessionKey?: string;
  agentId?: string;
  ts?: number;
  completed?: boolean;
  reason?: string;
};

export type ToolStreamEntry = {
  toolCallId: string;
  runId: string;
  sessionKey?: string;
  name: string;
  args?: unknown;
  output?: string;
  startedAt: number;
  updatedAt: number;
  message: Record<string, unknown>;
};

type ToolStreamHost = {
  sessionKey: string;
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null } | null;
  hello?: {
    snapshot?: {
      sessionDefaults?: SessionDefaultsSnapshot;
    };
  } | null;
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  /** Live model reasoning/thinking stream (Control UI only; not channel delivery). */
  chatThinkingStream?: string | null;
  /**
   * Run ids the user (or phantom cleanup) already stopped. Late agent events
   * from those runs must not re-adopt chatRunId or resurrect "思考中".
   */
  chatAbortedRunIds?: Set<string>;
  /** High-latency run stages with wall-clock timing (Control UI only). */
  chatRunStages?: ChatRunStageEntry[];
  chatStreamSegments: ChatStreamSegment[];
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
  chatToolMessages: Record<string, unknown>[];
  toolStreamSyncTimer: number | null;
  sessions: Pick<SessionCapability, "setModelOverride">;
};

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
};

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveModelLabel(provider: unknown, model: unknown): string | null {
  const modelValue = toTrimmedString(model);
  if (!modelValue) {
    return null;
  }
  const providerValue = toTrimmedString(provider);
  if (providerValue) {
    const prefix = `${providerValue}/`;
    if (
      normalizeLowercaseStringOrEmpty(modelValue).startsWith(
        normalizeLowercaseStringOrEmpty(prefix),
      )
    ) {
      const trimmedModel = modelValue.slice(prefix.length).trim();
      if (trimmedModel) {
        return `${providerValue}/${trimmedModel}`;
      }
    }
    return `${providerValue}/${modelValue}`;
  }
  const slashIndex = modelValue.indexOf("/");
  if (slashIndex > 0) {
    const p = modelValue.slice(0, slashIndex).trim();
    const m = modelValue.slice(slashIndex + 1).trim();
    if (p && m) {
      return `${p}/${m}`;
    }
  }
  return modelValue;
}

type FallbackAttempt = {
  provider: string;
  model: string;
  reason: string;
};

function parseFallbackAttemptSummaries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => toTrimmedString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function parseFallbackAttempts(value: unknown): FallbackAttempt[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: FallbackAttempt[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const provider = toTrimmedString(item.provider);
    const model = toTrimmedString(item.model);
    if (!provider || !model) {
      continue;
    }
    const reason =
      toTrimmedString(item.reason)?.replace(/_/g, " ") ??
      toTrimmedString(item.code) ??
      (typeof item.status === "number" ? `HTTP ${item.status}` : null) ??
      toTrimmedString(item.error) ??
      "error";
    out.push({ provider, model, reason });
  }
  return out;
}

function extractToolOutputText(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = record.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const entry = item as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string") {
        return entry.text;
      }
      return null;
    })
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function formatToolOutput(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const contentText = extractToolOutputText(value);
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (contentText) {
    text = contentText;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = formatUnknownText(value);
    }
  }
  const truncated = truncateText(text, TOOL_OUTPUT_CHAR_LIMIT);
  if (!truncated.truncated) {
    return truncated.text;
  }
  return `${truncated.text}\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function resolveSessionStatusModelOverride(result: unknown): string | null | undefined {
  const details = readRecord(readRecord(result)?.details);
  if (!details || details.changedModel !== true) {
    return undefined;
  }
  if (Object.hasOwn(details, "modelOverride")) {
    const override = toTrimmedString(details.modelOverride);
    return override;
  }
  const model = toTrimmedString(details.model);
  if (!model) {
    return undefined;
  }
  const provider = toTrimmedString(details.modelProvider);
  return provider ? `${provider}/${model}` : model;
}

function syncSessionStatusModelOverride(host: ToolStreamHost, data: Record<string, unknown>) {
  const result = data.result;
  const details = readRecord(readRecord(result)?.details);
  const targetSessionKey = toTrimmedString(details?.sessionKey) ?? host.sessionKey;
  if (!uiSessionEventMatches(host, targetSessionKey, toTrimmedString(details?.agentId))) {
    return;
  }
  const override = resolveSessionStatusModelOverride(result);
  if (override === undefined) {
    return;
  }
  host.sessions.setModelOverride(targetSessionKey, override);
}

function buildToolStreamMessage(entry: ToolStreamEntry): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  content.push({
    type: "toolcall",
    name: entry.name,
    arguments: entry.args ?? {},
  });
  if (entry.output) {
    content.push({
      type: "toolresult",
      name: entry.name,
      text: entry.output,
    });
  }
  return {
    role: "assistant",
    toolCallId: entry.toolCallId,
    runId: entry.runId,
    content,
    timestamp: entry.startedAt,
  };
}

function trimToolStream(host: ToolStreamHost) {
  if (host.toolStreamOrder.length <= TOOL_STREAM_LIMIT) {
    return;
  }
  const overflow = host.toolStreamOrder.length - TOOL_STREAM_LIMIT;
  const removed = host.toolStreamOrder.splice(0, overflow);
  for (const id of removed) {
    host.toolStreamById.delete(id);
  }
}

function syncToolStreamMessages(host: ToolStreamHost) {
  host.chatToolMessages = host.toolStreamOrder
    .map((id) => host.toolStreamById.get(id)?.message)
    .filter((msg): msg is Record<string, unknown> => Boolean(msg));
}

function flushToolStreamSync(host: ToolStreamHost) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
  syncToolStreamMessages(host);
}

function scheduleToolStreamSync(host: ToolStreamHost, force = false) {
  if (force) {
    flushToolStreamSync(host);
    return;
  }
  if (host.toolStreamSyncTimer != null) {
    return;
  }
  host.toolStreamSyncTimer = window.setTimeout(
    () => flushToolStreamSync(host),
    TOOL_STREAM_THROTTLE_MS,
  );
}

export function resetToolStream(host: ToolStreamHost) {
  if (host.toolStreamSyncTimer != null) {
    clearTimeout(host.toolStreamSyncTimer);
    host.toolStreamSyncTimer = null;
  }
  host.toolStreamById.clear();
  host.toolStreamOrder = [];
  host.chatToolMessages = [];
  host.chatStreamSegments = [];
  if ("chatThinkingStream" in host) {
    host.chatThinkingStream = null;
  }
  // Do NOT clear chatRunStages here — stage cards are kept for diagnosis and
  // persisted client-side; resetToolStream runs on many terminal paths.
}

function upsertRunStage(host: ToolStreamHost, entry: ChatRunStageEntry): void {
  const stages = Array.isArray(host.chatRunStages) ? [...host.chatRunStages] : [];
  const index = stages.findIndex((s) => s.stage === entry.stage && s.active);
  if (index >= 0 && entry.active) {
    stages[index] = { ...stages[index], ...entry };
  } else if (!entry.active) {
    // Close the active row for this stage id, or append a completed row.
    const activeIdx = stages.findIndex((s) => s.stage === entry.stage && s.active);
    if (activeIdx >= 0) {
      stages[activeIdx] = {
        ...stages[activeIdx],
        ...entry,
        active: false,
      };
    } else {
      stages.push({ ...entry, active: false });
    }
  } else {
    stages.push(entry);
  }
  host.chatRunStages = stages;
  persistLiveRunStageCard(host, stages);
}

type RunStageHostFields = ToolStreamHost & {
  chatRunStageCardId?: string | null;
  chatRunStageCards?: ChatRunStageCard[];
  chatThinkingStream?: string | null;
  chatThinkingStreamBase?: string | null;
  chatThinkingNewRoundPending?: boolean;
};

/**
 * Seal the current live diagnosis card (if any) so the next agent runId starts
 * a fresh card. Multi-round tool loops share one runId and stay on one card;
 * a new channel/webchat turn always gets a new runId.
 */
function sealLiveRunStageCard(host: ToolStreamHost, endedAt = Date.now()): void {
  const hostAny = host as RunStageHostFields;
  const stages = Array.isArray(host.chatRunStages) ? host.chatRunStages : [];
  if (!hostAny.chatRunStageCardId || stages.length === 0) {
    return;
  }
  const sealedStages = stages.map((s) =>
    s.active
      ? {
          ...s,
          active: false,
          endedAt: s.endedAt ?? endedAt,
          durationMs: s.durationMs ?? Math.max(0, endedAt - s.startedAt),
        }
      : s,
  );
  host.chatRunStages = sealedStages;
  // Force-complete: persistLiveRunStageCard only seals when a reply stage finished.
  // Channel turns that abort mid-stage still need a closed history card.
  try {
    const cardId = hostAny.chatRunStageCardId;
    const prevCard = (hostAny.chatRunStageCards ?? []).find((c) => c.id === cardId);
    const thinkingSegments = sealOpenThinkingSegments(prevCard?.thinkingSegments?.slice() ?? []);
    const totalThinkingMs = thinkingSegments.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
    const startedAt =
      sealedStages.length > 0
        ? sealedStages.reduce((min, s) => Math.min(min, s.startedAt), sealedStages[0].startedAt)
        : endedAt;
    const card: ChatRunStageCard = {
      id: cardId,
      sessionKey: hostAny.sessionKey,
      runId: hostAny.chatRunId ?? null,
      startedAt,
      endedAt,
      stages: sealedStages.map((s) => ({ ...s })),
      thinkingText:
        joinThinkingSegmentsForDisplay(thinkingSegments) ||
        hostAny.chatThinkingStream?.trim() ||
        prevCard?.thinkingText ||
        null,
      thinkingDurationMs:
        totalThinkingMs > 0 ? totalThinkingMs : (prevCard?.thinkingDurationMs ?? null),
      thinkingSegments,
    };
    const client = (host as { client?: import("../../api/gateway.ts").GatewayBrowserClient | null })
      .client;
    saveRunStageCardEverywhere(card, client);
    const prev = Array.isArray(hostAny.chatRunStageCards) ? hostAny.chatRunStageCards : [];
    hostAny.chatRunStageCards = [...prev.filter((c) => c.id !== card.id), card];
  } catch {
    // ignore
  }
}

/**
 * Adopt a new agent runId for diagnosis cards. Same runId keeps accumulating
 * rounds; a different runId finalizes the previous card and opens a new one.
 */
function adoptRunStageTurn(host: ToolStreamHost, runId: string): boolean {
  if (!runId) {
    return false;
  }
  if (host.chatRunId === runId) {
    return false;
  }
  const hostAny = host as RunStageHostFields;
  // Prefer reusing the card that already belongs to this runId (history hydrate /
  // page refresh mid-turn). Never steal another turn's open card.
  const matching = (hostAny.chatRunStageCards ?? []).find((c) => c.runId === runId);
  if (host.chatRunId && host.chatRunId !== runId) {
    sealLiveRunStageCard(host);
  }
  host.chatRunId = runId;
  host.chatRunStages = matching?.stages?.length ? matching.stages.map((s) => ({ ...s })) : [];
  hostAny.chatRunStageCardId = matching?.id ?? createRunStageCardId(runId);
  hostAny.chatThinkingStream = matching?.thinkingText ?? null;
  hostAny.chatThinkingStreamBase = "";
  hostAny.chatThinkingNewRoundPending = false;
  if (matching?.thinkingSegments?.length) {
    // Keep segments; next thinking burst may append.
  }
  return true;
}

/** UI-only: mirror live stages + multi-round thinking into localStorage cards. */
function persistLiveRunStageCard(
  host: ToolStreamHost,
  stages: ChatRunStageEntry[],
  opts?: { forceNewThinkingSegment?: boolean },
): void {
  try {
    const hostAny = host as ToolStreamHost & {
      sessionKey?: string;
      chatRunId?: string | null;
      chatRunStageCardId?: string | null;
      chatRunStageCards?: ChatRunStageCard[];
      chatThinkingStream?: string | null;
    };
    if (!hostAny.sessionKey || (stages.length === 0 && !hostAny.chatThinkingStream?.trim())) {
      return;
    }
    const cardId = hostAny.chatRunStageCardId ?? createRunStageCardId(hostAny.chatRunId ?? null);
    hostAny.chatRunStageCardId = cardId;
    const startedAt =
      stages.length > 0
        ? stages.reduce((min, s) => Math.min(min, s.startedAt), stages[0].startedAt)
        : Date.now();
    // A round is only "done" once its reply has completed. Checking just
    // `every(!active)` would seal a card the moment a new round's `model_first`
    // ends with nothing else started, which makes the live round render as a
    // history card while it is still running.
    const allDone =
      stages.length > 0 &&
      stages.some((s) => s.stage === "reply" && !s.active) &&
      stages.every((s) => !s.active);
    const thinkingStage = stages.find((s) => s.stage === "thinking" && s.active);
    const thinkingText = hostAny.chatThinkingStream?.trim() || "";
    const prevCard = (hostAny.chatRunStageCards ?? []).find((c) => c.id === cardId);
    let thinkingSegments: ChatThinkingSegment[] = prevCard?.thinkingSegments?.slice() ?? [];
    if (thinkingText) {
      thinkingSegments = appendThinkingToSegments({
        cardId,
        segments: thinkingSegments,
        text: thinkingText,
        forceNewSegment: opts?.forceNewThinkingSegment === true,
      });
    }
    if (allDone) {
      thinkingSegments = sealOpenThinkingSegments(thinkingSegments);
    }
    const totalThinkingMs = thinkingSegments.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
    const card: ChatRunStageCard = {
      id: cardId,
      sessionKey: hostAny.sessionKey,
      runId: hostAny.chatRunId ?? null,
      startedAt,
      endedAt: allDone
        ? stages.reduce((max, s) => Math.max(max, s.endedAt ?? 0), 0) || Date.now()
        : null,
      stages: stages.map((s) => ({ ...s })),
      thinkingText:
        joinThinkingSegmentsForDisplay(thinkingSegments) ||
        thinkingText ||
        prevCard?.thinkingText ||
        null,
      thinkingDurationMs:
        totalThinkingMs > 0
          ? totalThinkingMs
          : thinkingStage
            ? Math.max(0, Date.now() - thinkingStage.startedAt)
            : (prevCard?.thinkingDurationMs ?? null),
      thinkingSegments,
    };
    const client = (host as { client?: import("../../api/gateway.ts").GatewayBrowserClient | null })
      .client;
    saveRunStageCardEverywhere(card, client);
    const prev = Array.isArray(hostAny.chatRunStageCards) ? hostAny.chatRunStageCards : [];
    hostAny.chatRunStageCards = [...prev.filter((c) => c.id !== card.id), card];
  } catch {
    // ignore
  }
}

function handleRunStageEvent(host: ToolStreamHost, payload: AgentEventPayload): void {
  const hostAny = host as RunStageHostFields;
  if (payload.runId) {
    adoptRunStageTurn(host, payload.runId);
  }
  if (host.chatRunStages.length === 0 && hostAny.chatRunStageCardId) {
    const existing = (hostAny.chatRunStageCards ?? []).find(
      (c) => c.id === hostAny.chatRunStageCardId && (!payload.runId || c.runId === payload.runId),
    );
    if (existing?.stages?.length) {
      host.chatRunStages = existing.stages.map((s) => ({ ...s }));
    }
  }
  const data = payload.data ?? {};
  const stage = typeof data.stage === "string" ? data.stage.trim() : "";
  if (!stage) {
    return;
  }
  const label = (typeof data.label === "string" && data.label.trim()) || stage;
  const phase = typeof data.phase === "string" ? data.phase : "";
  const startedAt =
    typeof data.startedAt === "number" && Number.isFinite(data.startedAt)
      ? data.startedAt
      : typeof payload.ts === "number"
        ? payload.ts
        : Date.now();
  if (phase === "start") {
    // One stage card + one thinking card for the whole turn: stages keep
    // appending to the same card. A new thinking burst just seals the previous
    // round's thinking segment (so the thinking card shows one segment per round
    // with a prominent divider) and resets the stream buffer to the new round.
    if (stage === "thinking") {
      const hostAny = host as ToolStreamHost & {
        chatThinkingStream?: string | null;
        chatThinkingStreamBase?: string | null;
        chatThinkingNewRoundPending?: boolean;
      };
      // Remember prior rounds' full text so cumulative thinking payloads can be
      // stripped down to the current round's text.
      hostAny.chatThinkingStreamBase =
        (hostAny.chatThinkingStreamBase ?? "") + (hostAny.chatThinkingStream ?? "");
      hostAny.chatThinkingStream = "";
      // If there was already thinking, the next token starts a new segment.
      if (hostAny.chatThinkingStreamBase.trim()) {
        hostAny.chatThinkingNewRoundPending = true;
      }
    }
    upsertRunStage(host, {
      stage,
      label,
      startedAt,
      active: true,
      durationMs: null,
      endedAt: null,
    });
    return;
  }
  if (phase === "end") {
    const endedAt =
      typeof data.endedAt === "number" && Number.isFinite(data.endedAt) ? data.endedAt : Date.now();
    const durationMs =
      typeof data.durationMs === "number" && Number.isFinite(data.durationMs)
        ? Math.max(0, data.durationMs)
        : Math.max(0, endedAt - startedAt);
    upsertRunStage(host, {
      stage,
      label,
      startedAt,
      endedAt,
      durationMs,
      active: false,
    });
    // Keep the persisted card in sync with completed stages so a finished round
    // shows its full stage list (and collapses) before the next round starts.
    const stages = Array.isArray(host.chatRunStages) ? host.chatRunStages : [];
    persistLiveRunStageCard(host, stages);
  }
}

/** Merge cumulative text / delta thinking payloads into the live Control UI buffer. */
export function resolveThinkingStreamText(
  previous: string | null | undefined,
  data: Record<string, unknown> | undefined,
  baseText?: string | null,
): string | null {
  if (!data || typeof data !== "object") {
    return previous ?? null;
  }
  let nextText = typeof data.text === "string" ? data.text : "";
  const nextDelta = typeof data.delta === "string" ? data.delta : "";
  const prev = typeof previous === "string" ? previous : "";

  if (baseText && nextText.startsWith(baseText)) {
    nextText = nextText.slice(baseText.length);
  }

  if (nextText) {
    if (!prev || nextText.startsWith(prev) || nextText.length >= prev.length) {
      return nextText;
    }
  }
  if (nextDelta) {
    return `${prev}${nextDelta}`;
  }
  if (nextText) {
    return nextText;
  }
  return prev || null;
}

export type CompactionStatus = {
  phase: "active" | "retrying" | "complete";
  runId: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

/** One high-latency milestone for Control UI stage timing panel. */
export type ChatRunStageEntry = {
  stage: string;
  label: string;
  startedAt: number;
  endedAt?: number | null;
  durationMs?: number | null;
  active: boolean;
  detail?: string | null;
};

export type FallbackStatus = {
  phase?: "active" | "cleared";
  selected: string;
  active: string;
  previous?: string;
  reason?: string;
  attempts: string[];
  occurredAt: number;
};

type CompactionHost = ToolStreamHost & {
  compactionStatus?: CompactionStatus | null;
  compactionClearTimer?: number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: number | null;
  requestUpdate?: () => void;
};

const COMPACTION_TOAST_DURATION_MS = 5000;
const COMPACTION_ACTIVE_STALE_TIMEOUT_MS = 5 * 60_000;
const FALLBACK_TOAST_DURATION_MS = 8000;

function clearCompactionTimer(host: CompactionHost) {
  if (host.compactionClearTimer != null) {
    window.clearTimeout(host.compactionClearTimer);
    host.compactionClearTimer = null;
  }
}

function scheduleCompactionClear(
  host: CompactionHost,
  delayMs = COMPACTION_TOAST_DURATION_MS,
  expected?: { phase?: CompactionStatus["phase"]; runId?: string | null },
) {
  host.compactionClearTimer = window.setTimeout(() => {
    const current = host.compactionStatus;
    if (expected?.phase && current?.phase !== expected.phase) {
      return;
    }
    if (expected?.runId && current?.runId !== expected.runId) {
      return;
    }
    host.compactionStatus = null;
    host.compactionClearTimer = null;
    host.requestUpdate?.();
  }, delayMs);
}

function setCompactionComplete(host: CompactionHost, runId: string) {
  host.compactionStatus = {
    phase: "complete",
    runId,
    startedAt: host.compactionStatus?.startedAt ?? null,
    completedAt: Date.now(),
  };
  scheduleCompactionClear(host, COMPACTION_TOAST_DURATION_MS, { phase: "complete", runId });
}

export function handleSessionOperationEvent(
  host: ToolStreamHost,
  payload?: SessionOperationEventPayload,
) {
  if (!payload || payload.operation !== "compact") {
    return;
  }
  const sessionKey = toTrimmedString(payload.sessionKey);
  const agentId = toTrimmedString(payload.agentId) ?? undefined;
  if (!sessionKey || !uiSessionEventMatches(host, sessionKey, agentId)) {
    return;
  }

  const operationId = toTrimmedString(payload.operationId) ?? `session-compact:${sessionKey}`;
  const compactionHost = host as CompactionHost;

  if (payload.phase === "start") {
    clearCompactionTimer(compactionHost);
    compactionHost.compactionStatus = {
      phase: "active",
      runId: operationId,
      startedAt: Date.now(),
      completedAt: null,
    };
    scheduleCompactionClear(compactionHost, COMPACTION_ACTIVE_STALE_TIMEOUT_MS, {
      phase: "active",
      runId: operationId,
    });
    return;
  }

  if (payload.phase !== "end") {
    return;
  }
  if (
    compactionHost.compactionStatus?.runId &&
    compactionHost.compactionStatus.runId !== operationId
  ) {
    return;
  }
  clearCompactionTimer(compactionHost);
  if (payload.completed === true) {
    setCompactionComplete(compactionHost, operationId);
    return;
  }
  compactionHost.compactionStatus = null;
}

function handleCompactionEvent(host: CompactionHost, payload: AgentEventPayload) {
  const data = payload.data ?? {};
  const phase = typeof data.phase === "string" ? data.phase : "";
  const completed = data.completed === true;

  clearCompactionTimer(host);

  if (phase === "start") {
    host.compactionStatus = {
      phase: "active",
      runId: payload.runId,
      startedAt: Date.now(),
      completedAt: null,
    };
    scheduleCompactionClear(host, COMPACTION_ACTIVE_STALE_TIMEOUT_MS, {
      phase: "active",
      runId: payload.runId,
    });
    return;
  }
  if (phase === "end") {
    if (data.willRetry === true && completed) {
      // Compaction already succeeded, but the run is still retrying.
      // Keep that distinct state until the matching lifecycle end arrives.
      host.compactionStatus = {
        phase: "retrying",
        runId: payload.runId,
        startedAt: host.compactionStatus?.startedAt ?? Date.now(),
        completedAt: null,
      };
      scheduleCompactionClear(host, COMPACTION_ACTIVE_STALE_TIMEOUT_MS, {
        phase: "retrying",
        runId: payload.runId,
      });
      return;
    }
    if (completed) {
      setCompactionComplete(host, payload.runId);
      return;
    }
    host.compactionStatus = null;
  }
}

function handleLifecycleCompactionEvent(host: CompactionHost, payload: AgentEventPayload) {
  const data = payload.data ?? {};
  const phase = toTrimmedString(data.phase);
  if (phase !== "end" && phase !== "error") {
    return;
  }

  // We scope lifecycle cleanup to the visible chat session first, then
  // use runId only to match the specific compaction retry we started tracking.
  const accepted = resolveAcceptedSession(host, payload, { allowSessionScopedWhenIdle: true });
  if (!accepted.accepted) {
    return;
  }
  if (host.compactionStatus?.phase !== "retrying") {
    return;
  }
  if (host.compactionStatus.runId && host.compactionStatus.runId !== payload.runId) {
    return;
  }

  setCompactionComplete(host, payload.runId);
}

function resolveAcceptedSession(
  host: ToolStreamHost,
  payload: AgentEventPayload,
  options?: {
    allowSessionScopedWhenIdle?: boolean;
  },
): { accepted: boolean; sessionKey?: string } {
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  if (sessionKey && !uiSessionEventMatches(host, sessionKey, toTrimmedString(payload.agentId))) {
    return { accepted: false };
  }
  if (!host.chatRunId && options?.allowSessionScopedWhenIdle && sessionKey) {
    return { accepted: true, sessionKey };
  }
  // Fallback: only accept session-less events for the active run.
  if (!sessionKey && host.chatRunId && payload.runId !== host.chatRunId) {
    return { accepted: false };
  }
  if (host.chatRunId && payload.runId !== host.chatRunId) {
    return { accepted: false };
  }
  if (!host.chatRunId) {
    return { accepted: false };
  }
  return { accepted: true, sessionKey };
}

function handleLifecycleFallbackEvent(host: CompactionHost, payload: AgentEventPayload) {
  const data = payload.data ?? {};
  const phase = payload.stream === "fallback" ? "fallback" : toTrimmedString(data.phase);
  if (payload.stream === "lifecycle" && phase !== "fallback" && phase !== "fallback_cleared") {
    return;
  }

  const accepted = resolveAcceptedSession(host, payload, { allowSessionScopedWhenIdle: true });
  if (!accepted.accepted) {
    return;
  }

  const selected =
    resolveModelLabel(data.selectedProvider, data.selectedModel) ??
    resolveModelLabel(data.fromProvider, data.fromModel);
  const active =
    resolveModelLabel(data.activeProvider, data.activeModel) ??
    resolveModelLabel(data.toProvider, data.toModel);
  const previous =
    resolveModelLabel(data.previousActiveProvider, data.previousActiveModel) ??
    toTrimmedString(data.previousActiveModel);
  if (!selected || !active) {
    return;
  }
  if (phase === "fallback" && selected === active) {
    return;
  }

  const reason = toTrimmedString(data.reasonSummary) ?? toTrimmedString(data.reason);
  const attempts = (() => {
    const summaries = parseFallbackAttemptSummaries(data.attemptSummaries);
    if (summaries.length > 0) {
      return summaries;
    }
    return parseFallbackAttempts(data.attempts).map((attempt) => {
      const modelRef = resolveModelLabel(attempt.provider, attempt.model);
      return `${modelRef ?? `${attempt.provider}/${attempt.model}`}: ${attempt.reason}`;
    });
  })();

  if (host.fallbackClearTimer != null) {
    window.clearTimeout(host.fallbackClearTimer);
    host.fallbackClearTimer = null;
  }
  host.fallbackStatus = {
    phase: phase === "fallback_cleared" ? "cleared" : "active",
    selected,
    active: phase === "fallback_cleared" ? selected : active,
    previous:
      phase === "fallback_cleared"
        ? (previous ?? (active !== selected ? active : undefined))
        : undefined,
    reason: reason ?? undefined,
    attempts,
    occurredAt: Date.now(),
  };
  host.fallbackClearTimer = window.setTimeout(() => {
    host.fallbackStatus = null;
    host.fallbackClearTimer = null;
  }, FALLBACK_TOAST_DURATION_MS);
}

function readPreambleProgressEvent(
  payload: AgentEventPayload,
): { text: string; itemId?: string } | null {
  if (payload.stream !== "item") {
    return null;
  }
  const data = payload.data ?? {};
  if (data.kind !== "preamble") {
    return null;
  }
  const rawItemId =
    typeof data.itemId === "string" && data.itemId.trim()
      ? data.itemId
      : typeof data.id === "string" && data.id.trim()
        ? data.id
        : null;
  const itemId = rawItemId?.trim();
  const progressText = normalizePreambleProgressText(data.progressText);
  if (!progressText && !itemId) {
    return null;
  }
  return {
    text: progressText,
    ...(itemId ? { itemId } : {}),
  };
}

function normalizePreambleProgressText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const stripped = stripInlineDirectiveTagsForDelivery(value).text.trim();
  const normalized = stripped.replace(/^[\s*_`~]+|[\s*_`~]+$/gu, "").trim();
  return /^NO_REPLY$/iu.test(normalized) ? "" : stripped;
}

function handlePreambleProgressEvent(host: ToolStreamHost, payload: AgentEventPayload): boolean {
  const progress = readPreambleProgressEvent(payload);
  if (!progress) {
    return false;
  }
  if (progress.itemId && !progress.text.trim()) {
    host.chatStreamSegments = host.chatStreamSegments.filter(
      (segment) => segment.itemId !== progress.itemId,
    );
    return true;
  }
  const existingIndex = progress.itemId
    ? host.chatStreamSegments.findIndex((segment) => segment.itemId === progress.itemId)
    : -1;
  if (existingIndex >= 0) {
    const existing = host.chatStreamSegments[existingIndex];
    if (!existing) {
      return true;
    }
    host.chatStreamSegments = host.chatStreamSegments.map((segment, index) =>
      index === existingIndex ? { ...segment, text: progress.text } : segment,
    );
    return true;
  }
  const last = host.chatStreamSegments[host.chatStreamSegments.length - 1];
  if (!progress.itemId && last && !last.toolCallId && last.text === progress.text) {
    return true;
  }
  host.chatStreamSegments = [
    ...host.chatStreamSegments,
    {
      text: progress.text,
      ts: Date.now(),
      ...(progress.itemId ? { itemId: progress.itemId } : {}),
    },
  ];
  return true;
}

export function handleAgentEvent(host: ToolStreamHost, payload?: AgentEventPayload) {
  if (!payload) {
    return;
  }

  // Filter by session only. Don't check chatRunId because the client sets it
  // to a client-generated UUID (via generateUUID in sendChatMessage), while
  // agent events arrive with the server's engine runId.
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : undefined;
  if (sessionKey && !uiSessionEventMatches(host, sessionKey, toTrimmedString(payload.agentId))) {
    return;
  }

  const abortedRunIds = host.chatAbortedRunIds;
  const isAbortedRun =
    Boolean(payload.runId) && abortedRunIds instanceof Set && abortedRunIds.has(payload.runId);

  // Handle compaction events
  if (payload.stream === "compaction") {
    if (isAbortedRun) {
      return;
    }
    handleCompactionEvent(host as CompactionHost, payload);
    return;
  }

  if (payload.stream === "lifecycle") {
    const phase = typeof payload.data?.phase === "string" ? payload.data.phase : "";
    if (payload.runId && (phase === "start" || phase === "end" || phase === "error")) {
      // start: adopt run so subsequent stages bind to this turn
      // end/error: seal after handlers so compaction/fallback still see run id
      if (phase === "start") {
        // A genuine new lifecycle start supersedes prior abort suppression.
        abortedRunIds?.delete(payload.runId);
        adoptRunStageTurn(host, payload.runId);
      }
    }
    if (isAbortedRun && phase !== "end" && phase !== "error") {
      return;
    }
    handleLifecycleCompactionEvent(host as CompactionHost, payload);
    handleLifecycleFallbackEvent(host as CompactionHost, payload);
    if (phase === "end" || phase === "error") {
      sealLiveRunStageCard(host, typeof payload.ts === "number" ? payload.ts : Date.now());
      const hostAny = host as RunStageHostFields;
      hostAny.chatRunStageCardId = null;
      host.chatRunStages = [];
      hostAny.chatThinkingStream = null;
      hostAny.chatThinkingStreamBase = "";
      hostAny.chatThinkingNewRoundPending = false;
      if (payload.runId) {
        host.chatAbortedRunIds ??= new Set();
        host.chatAbortedRunIds.add(payload.runId);
      }
    }
    return;
  }

  if (isAbortedRun) {
    // Drop late thinking/tool/stage events after Stop so the composer does not
    // flip back to "思考中" or re-show a live Stop target.
    return;
  }

  if (payload.stream === "fallback") {
    handleLifecycleFallbackEvent(host as CompactionHost, payload);
    return;
  }

  if (handlePreambleProgressEvent(host, payload)) {
    return;
  }

  // New agent runId = new user turn (channel or webchat). Multi-round tools share
  // one runId and keep appending to the same card; a different runId must not.
  if (
    payload.runId &&
    payload.runId !== host.chatRunId &&
    (payload.stream === "thinking" || payload.stream === "run_stage" || payload.stream === "tool")
  ) {
    adoptRunStageTurn(host, payload.runId);
  }

  // Live reasoning/thinking tokens (WebUI diagnosis only).
  if (payload.stream === "thinking") {
    const hostAny = host as ToolStreamHost & {
      chatThinkingStreamBase?: string | null;
      chatThinkingNewRoundPending?: boolean;
    };
    const next = resolveThinkingStreamText(
      host.chatThinkingStream,
      payload.data ?? {},
      hostAny.chatThinkingStreamBase,
    );
    if (typeof next === "string" && next.length > 0) {
      host.chatThinkingStream = next;
      if (!host.chatStreamStartedAt) {
        host.chatStreamStartedAt = Date.now();
      }
      // A fresh thinking burst after prior rounds starts a new segment so the
      // thinking card shows one segment per round with a prominent divider.
      const forceNew = hostAny.chatThinkingNewRoundPending === true;
      hostAny.chatThinkingNewRoundPending = false;
      // Persist thinking text onto the session stage card so it survives finalize/refresh.
      const stages = Array.isArray(host.chatRunStages) ? host.chatRunStages : [];
      persistLiveRunStageCard(host, stages, { forceNewThinkingSegment: forceNew });
    }
    return;
  }

  if (payload.stream === "run_stage") {
    // We already handled runId changes above, so handleRunStageEvent doesn't need to do it,
    // but handleRunStageEvent is resilient and its own check will be a no-op if already matching.
    handleRunStageEvent(host, payload);
    return;
  }

  if (payload.stream !== "tool") {
    return;
  }

  const data = payload.data ?? {};
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
  if (!toolCallId) {
    return;
  }
  const name = typeof data.name === "string" ? data.name : "tool";
  const phase = typeof data.phase === "string" ? data.phase : "";
  const args = phase === "start" ? data.args : undefined;
  const output =
    phase === "update"
      ? formatToolOutput(data.partialResult)
      : phase === "result"
        ? formatToolOutput(data.result)
        : undefined;
  if (name === "session_status" && phase === "result") {
    syncSessionStatusModelOverride(host, data);
  }

  const now = Date.now();
  let entry = host.toolStreamById.get(toolCallId);
  if (!entry) {
    // Commit any in-progress streaming text as a segment so it renders
    // above the tool card instead of below it.
    if (
      host.chatRunId &&
      payload.runId === host.chatRunId &&
      host.chatStream &&
      host.chatStream.trim().length > 0
    ) {
      host.chatStreamSegments = [
        ...host.chatStreamSegments,
        { text: host.chatStream, ts: now, toolCallId },
      ];
      host.chatStream = null;
      host.chatStreamStartedAt = null;
    }
    entry = {
      toolCallId,
      runId: payload.runId,
      sessionKey,
      name,
      args,
      output: output || undefined,
      startedAt: typeof payload.ts === "number" ? payload.ts : now,
      updatedAt: now,
      message: {},
    };
    host.toolStreamById.set(toolCallId, entry);
    host.toolStreamOrder.push(toolCallId);
  } else {
    entry.name = name;
    if (args !== undefined) {
      entry.args = args;
    }
    if (output !== undefined) {
      entry.output = output || undefined;
    }
    entry.updatedAt = now;
  }

  entry.message = buildToolStreamMessage(entry);
  trimToolStream(host);
  scheduleToolStreamSync(host, phase === "result");
}
