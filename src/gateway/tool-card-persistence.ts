/**
 * Gateway-side aggregation of tool start/result events into
 * server-persisted Control UI tool cards (not model context).
 */
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import {
  saveToolCardToStore,
  type PersistedToolCard,
  type PersistedToolCardStatus,
} from "../infra/tool-card-store.js";

type LiveToolCard = PersistedToolCard;

const liveByCallId = new Map<string, LiveToolCard>();
let started = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
const dirtyCallIds = new Set<string>();
let sessionKeyResolver: ((runId: string) => string | null) | null = null;

function scheduleFlush(callId: string, immediate = false): void {
  dirtyCallIds.add(callId);
  if (immediate) {
    flushDirty();
    return;
  }
  if (writeTimer) {
    return;
  }
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushDirty();
  }, 200);
}

function flushDirty(): void {
  const ids = [...dirtyCallIds];
  dirtyCallIds.clear();
  for (const id of ids) {
    const card = liveByCallId.get(id);
    if (card) {
      saveToolCardToStore(card);
    }
  }
}

function resolveSessionKey(evt: AgentEventPayload): string {
  const fromEvent =
    typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey.trim() : "";
  if (fromEvent) {
    return fromEvent;
  }
  if (sessionKeyResolver && evt.runId) {
    return sessionKeyResolver(evt.runId)?.trim() ?? "";
  }
  return "";
}

function stringifyToolOutput(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function coerceArgs(data: Record<string, unknown>, name: string): unknown {
  if (data.args !== undefined) {
    return data.args;
  }
  if (data.arguments !== undefined) {
    return data.arguments;
  }
  if (data.input !== undefined) {
    return data.input;
  }
  const meta = typeof data.meta === "string" ? data.meta.trim() : "";
  if (!meta) {
    return undefined;
  }
  if (name === "exec" || name === "bash") {
    return { command: meta };
  }
  return meta;
}

function serializeInput(args: unknown): string | undefined {
  if (args === undefined || args === null) {
    return undefined;
  }
  if (typeof args === "string") {
    return args;
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return undefined;
  }
}

function upsertLive(params: {
  evt: AgentEventPayload;
  callId: string;
  name: string;
  args?: unknown;
  outputText?: string;
  isError?: boolean;
  status?: PersistedToolCardStatus;
  ended?: boolean;
}): LiveToolCard | null {
  const sessionKey = resolveSessionKey(params.evt);
  if (!sessionKey) {
    return null;
  }
  const ts = typeof params.evt.ts === "number" ? params.evt.ts : Date.now();
  const existing = liveByCallId.get(params.callId);
  const args = params.args !== undefined ? params.args : existing?.args;
  const card: LiveToolCard = {
    id: existing?.id ?? `tool:${params.callId}`,
    sessionKey: existing?.sessionKey || sessionKey,
    runId: params.evt.runId ?? existing?.runId ?? null,
    callId: params.callId,
    name: params.name || existing?.name || "tool",
    args,
    inputText: serializeInput(args) ?? existing?.inputText,
    outputText: params.outputText ?? existing?.outputText,
    isError: params.isError ?? existing?.isError,
    startedAt: existing?.startedAt ?? ts,
    endedAt: params.ended ? ts : (existing?.endedAt ?? null),
    status: params.status ?? existing?.status ?? (params.ended ? "completed" : "running"),
  };
  liveByCallId.set(params.callId, card);
  return card;
}

function handleEvent(evt: AgentEventPayload): void {
  try {
    const data = evt.data ?? {};
    const callId = typeof data.toolCallId === "string" ? data.toolCallId.trim() : "";
    const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : "tool";
    const phase = typeof data.phase === "string" ? data.phase : "";

    if (evt.stream === "tool" || evt.stream === "item" || evt.stream === "command_output") {
      if (!callId) {
        return;
      }
      if (evt.stream === "item" && data.kind !== "tool" && data.kind !== "command") {
        return;
      }
      const args = coerceArgs(data, name);
      const outputText =
        evt.stream === "command_output"
          ? stringifyToolOutput(data.output)
          : phase === "result"
            ? stringifyToolOutput(data.result)
            : phase === "update"
              ? stringifyToolOutput(data.partialResult)
              : undefined;
      const ended = phase === "result" || phase === "end";
      const isError = data.isError === true || (ended && data.status === "failed");
      const card = upsertLive({
        evt,
        callId,
        name,
        args,
        outputText,
        isError,
        status: isError ? "error" : ended ? "completed" : "running",
        ended,
      });
      if (card) {
        scheduleFlush(callId, ended);
      }
      return;
    }

    if (evt.stream === "lifecycle") {
      const life = typeof data.phase === "string" ? data.phase : "";
      if (life !== "end" && life !== "error" && life !== "finishing") {
        return;
      }
      for (const [callId, card] of liveByCallId) {
        if (card.runId !== evt.runId) {
          continue;
        }
        if (!card.endedAt) {
          card.endedAt = typeof evt.ts === "number" ? evt.ts : Date.now();
          if (card.status === "running") {
            card.status = card.outputText ? "completed" : "running";
          }
        }
        saveToolCardToStore(card);
        liveByCallId.delete(callId);
        dirtyCallIds.delete(callId);
      }
    }
  } catch {
    // never break gateway for WebUI tool-card persistence
  }
}

export function listLiveToolCardsForSession(sessionKey: string): PersistedToolCard[] {
  const key = sessionKey.trim();
  if (!key) {
    return [];
  }
  const out: PersistedToolCard[] = [];
  for (const card of liveByCallId.values()) {
    if (card.sessionKey === key) {
      out.push({ ...card });
    }
  }
  return out;
}

export function startToolCardPersistence(resolver?: (runId: string) => string | null): () => void {
  if (resolver) {
    sessionKeyResolver = resolver;
  }
  if (started) {
    return () => {};
  }
  started = true;
  const stop = onAgentEvent(handleEvent);
  return () => {
    stop();
    started = false;
    sessionKeyResolver = null;
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    for (const card of liveByCallId.values()) {
      saveToolCardToStore(card);
    }
    liveByCallId.clear();
    dirtyCallIds.clear();
  };
}
