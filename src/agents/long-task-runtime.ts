/**
 * Runtime-owned long-task state machine.
 * Short-polls and parks without model calls; only a folded terminal result
 * returns to the current turn.
 */
import fs from "node:fs";
import path from "node:path";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
} from "../config/sessions/paths.js";
import { loadSessionStore, resolveSessionStoreEntry } from "../config/sessions/store.js";
import { appendSessionTranscriptMessage } from "../config/sessions/transcript-append.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.runtime.js";
import { createAbortError, isAbortError } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readExecOutputLog, resolveExecOutputPath } from "../infra/gateway-stop-intent.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isTerminalTaskStatus } from "../tasks/task-executor-policy.js";
import {
  createTaskRecord,
  listTaskRecords,
  markTaskLostById,
  markTaskTerminalById,
  updateTaskProgressById,
} from "../tasks/task-registry.js";
import type { TaskRecord, TaskStatus } from "../tasks/task-registry.types.js";
import { getFinishedSession, getSession, waitForSessionExit } from "./bash-process-registry.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-runtime.js";
import {
  DEFAULT_LONG_TASK_SUMMARY_MAX_CHARS,
  resolveLongTaskConfig,
  resolveLongTaskRetentionMsForStatus,
  type ResolvedLongTaskConfig,
} from "./long-task-config.js";

const log = createSubsystemLogger("agents/long-task");

export type LongTaskPhase = "long_running";
export type LongTaskTerminalStatus = "succeeded" | "failed" | "timed_out" | "cancelled";

export type LongTaskFoldedResult = {
  status: LongTaskTerminalStatus;
  phase: LongTaskPhase;
  elapsedMs: number;
  exitCode: number | null;
  exitSignal?: string;
  timedOut: boolean;
  cancelled: boolean;
  summary: string;
  aggregated: string;
  sessionId: string;
  outputPath?: string;
  pid?: number;
  taskId?: string;
};

export type LongTaskWaiter = {
  taskId?: string;
  processSessionId: string;
  sessionKey?: string;
  agentId?: string;
  command: string;
  pid?: number;
  phase: LongTaskPhase;
  startedAt: number;
  deadlineAt: number;
  maxWaitMs: number;
  controller: AbortController;
  /** Resolves when process-exit notify arrives so the remaining wait aborts. */
  finished: { promise: Promise<void>; resolve: () => void };
  toolCallId?: string;
  outputPath?: string;
};

function createFinishedSignal(): { promise: Promise<void>; resolve: () => void } {
  let settled = false;
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      done();
    };
  });
  return { promise, resolve };
}

const waitersByProcessSession = new Map<string, LongTaskWaiter>();
const waitersByTaskId = new Map<string, LongTaskWaiter>();
const waitersBySessionKey = new Map<string, Set<string>>();

export type ExecTaskMeta = {
  phase: LongTaskPhase;
  pid?: number;
  sessionId: string;
  maxWaitMs: number;
  deadlineAt: number;
  toolCallId?: string;
  outputPath?: string;
};

function truncateSummary(value: string, maxChars = DEFAULT_LONG_TASK_SUMMARY_MAX_CHARS): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function encodeExecTaskMeta(meta: ExecTaskMeta): string {
  return `longtask ${JSON.stringify(meta)}`;
}

export function parseExecTaskMeta(
  task: Pick<TaskRecord, "progressSummary" | "sourceId">,
): ExecTaskMeta | null {
  const raw = task.progressSummary?.trim();
  if (raw?.startsWith("longtask ")) {
    try {
      const parsed = JSON.parse(raw.slice("longtask ".length)) as ExecTaskMeta;
      if (parsed && typeof parsed.sessionId === "string") {
        return { ...parsed, phase: "long_running" };
      }
    } catch {
      // Fall through to sourceId-only metadata.
    }
  }
  const sessionId = task.sourceId?.trim();
  if (!sessionId) {
    return null;
  }
  return {
    phase: "long_running",
    sessionId,
    maxWaitMs: 0,
    deadlineAt: 0,
  };
}

/** Wall-clock wait after a gateway restart. Never restarts maxWait from now. */
export function resolveLongTaskReattachTiming(params: {
  startedAt?: number;
  createdAt?: number;
  maxWaitMs?: number;
  deadlineAt?: number;
  now?: number;
  defaultMaxWaitMs: number;
}): {
  startedAt: number;
  maxWaitMs: number;
  deadlineAt: number;
  remainingMs: number;
  elapsedMs: number;
} {
  const now = params.now ?? Date.now();
  const startedAt =
    typeof params.startedAt === "number" &&
    Number.isFinite(params.startedAt) &&
    params.startedAt > 0
      ? params.startedAt
      : typeof params.createdAt === "number" &&
          Number.isFinite(params.createdAt) &&
          params.createdAt > 0
        ? params.createdAt
        : now;
  const maxWaitMs =
    typeof params.maxWaitMs === "number" &&
    Number.isFinite(params.maxWaitMs) &&
    params.maxWaitMs > 0
      ? params.maxWaitMs
      : params.defaultMaxWaitMs;
  const deadlineAt =
    typeof params.deadlineAt === "number" &&
    Number.isFinite(params.deadlineAt) &&
    params.deadlineAt > 0
      ? params.deadlineAt
      : startedAt + maxWaitMs;
  return {
    startedAt,
    maxWaitMs,
    deadlineAt,
    remainingMs: Math.max(0, deadlineAt - now),
    elapsedMs: Math.max(0, now - startedAt),
  };
}

function formatReattachedLongTaskNotice(params: {
  status: LongTaskTerminalStatus | "lost";
  elapsedMs: number;
  command: string;
  kind: "exit" | "timeout" | "abort" | "lost";
  outputPath?: string;
}): string {
  const seconds = Math.max(0, Math.round(params.elapsedMs / 1000));
  const head =
    params.kind === "exit"
      ? `Long task finished after gateway restart (${seconds}s from original start).`
      : params.kind === "timeout"
        ? `Long task timed out after gateway restart (${seconds}s from original start).`
        : params.kind === "lost"
          ? `Long task lost after gateway restart (${seconds}s from original start). Backing process is gone.`
          : `Long task cancelled after gateway restart (${seconds}s from original start).`;
  const lines = [
    head,
    `status: ${params.status}`,
    `elapsedMs: ${params.elapsedMs}`,
    `command: ${params.command.slice(0, 160)}`,
  ];
  if (params.outputPath) {
    lines.push(`outputPath: ${params.outputPath}`);
  }
  return lines.join("\n");
}

/** Best-effort process-end time when the pid is already gone after restart. */
function resolveMissingExecTaskEndedAt(params: {
  task: TaskRecord;
  meta: ExecTaskMeta | null;
  now?: number;
}): number {
  const now = params.now ?? Date.now();
  const started =
    typeof params.task.startedAt === "number" && params.task.startedAt > 0
      ? params.task.startedAt
      : typeof params.task.createdAt === "number" && params.task.createdAt > 0
        ? params.task.createdAt
        : 0;
  const candidates: number[] = [];
  for (const outputPath of [
    params.meta?.outputPath,
    resolveExecOutputPath(params.meta?.sessionId ?? params.task.sourceId ?? ""),
  ]) {
    if (!outputPath?.trim()) {
      continue;
    }
    try {
      const mtimeMs = fs.statSync(outputPath).mtimeMs;
      if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
        candidates.push(mtimeMs);
      }
    } catch {
      // Missing output is fine; fall back to discovery time.
    }
  }
  const latest = candidates.length > 0 ? Math.max(...candidates) : now;
  return Math.min(now, Math.max(started, latest));
}

function resolveSessionTranscriptPathForTask(task: TaskRecord): string | undefined {
  const sessionKey = task.requesterSessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  try {
    const storePath = resolveDefaultSessionStorePath(task.agentId);
    const store = loadSessionStore(storePath, { skipCache: true });
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const entry = resolved.existing;
    if (!entry?.sessionId) {
      return undefined;
    }
    return resolveSessionFilePath(entry.sessionId, entry, {
      sessionsDir: path.dirname(storePath),
      ...(task.agentId ? { agentId: task.agentId } : {}),
    });
  } catch {
    return undefined;
  }
}

async function appendReattachedExecToolResult(params: {
  task: TaskRecord;
  meta: ExecTaskMeta | null;
  summary: string;
  status: LongTaskTerminalStatus | "lost";
}): Promise<void> {
  const toolCallId = params.meta?.toolCallId?.trim();
  const transcriptPath = resolveSessionTranscriptPathForTask(params.task);
  if (!toolCallId || !transcriptPath) {
    return;
  }
  const outputPath =
    params.meta?.outputPath?.trim() ||
    resolveExecOutputPath(params.meta?.sessionId ?? params.task.sourceId ?? "");
  const recovered =
    readExecOutputLog(params.meta?.outputPath) || readExecOutputLog(outputPath) || params.summary;
  const body = recovered || params.summary;
  const text =
    outputPath && !body.includes(outputPath) ? `outputPath: ${outputPath}\n\n${body}` : body;
  const isError = params.status !== "succeeded";
  try {
    await appendSessionTranscriptMessage({
      transcriptPath,
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "exec",
        content: [{ type: "text", text: text || params.summary }],
        details: {
          status: isError ? "failed" : "completed",
          folded: true,
          taskStatus: params.status,
          sessionId: params.meta?.sessionId ?? params.task.sourceId,
          taskId: params.task.taskId,
          ...(outputPath ? { outputPath } : {}),
        },
        isError,
      },
    });
  } catch (error) {
    log.warn("Failed to append reattached exec tool result", {
      taskId: params.task.taskId,
      error: formatErrorMessage(error),
    });
  }
}

async function announceReattachedLongTaskTerminal(params: {
  task: TaskRecord;
  status: LongTaskTerminalStatus | "lost";
  elapsedMs: number;
  kind: "exit" | "timeout" | "abort" | "lost";
  summary: string;
  retention: ResolvedLongTaskConfig["retention"];
  wake: boolean;
  endedAt?: number;
}): Promise<void> {
  persistTerminal({
    taskId: params.task.taskId,
    status: params.status,
    summary: params.summary,
    error:
      params.status === "succeeded"
        ? undefined
        : params.status === "lost"
          ? "backing process missing after gateway restart"
          : params.status,
    retentionMs: resolveLongTaskRetentionMsForStatus(params.status, params.retention),
    endedAt: params.endedAt,
  });
  const meta = parseExecTaskMeta(params.task);
  await appendReattachedExecToolResult({
    task: params.task,
    meta,
    summary: params.summary,
    status: params.status,
  });
  const sessionKey = params.task.requesterSessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  try {
    enqueueSystemEvent(params.summary, { sessionKey });
  } catch (error) {
    log.warn("Failed to enqueue long-task reattach system event", {
      taskId: params.task.taskId,
      error: formatErrorMessage(error),
    });
  }
  if (params.wake) {
    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "long-task-reattach",
      coalesceMs: 0,
      agentId: params.task.agentId,
      sessionKey,
    });
  }
  try {
    await appendAssistantMessageToSessionTranscript({
      agentId: params.task.agentId,
      sessionKey,
      text: params.summary,
      idempotencyKey: `longtask-reattach:${params.task.taskId}:${params.status}`,
    });
  } catch (error) {
    log.warn("Failed to append long-task reattach transcript notice", {
      taskId: params.task.taskId,
      error: formatErrorMessage(error),
    });
  }
}

export function forceStopAllExecLongTasks(reason = "gateway-stop-force"): {
  cancelled: number;
  killed: number;
} {
  const cancelled = cancelAllLongTasks(reason);
  let killed = 0;
  const cfg = resolveLongTaskConfig();
  for (const task of listTaskRecords()) {
    if (task.runtime !== "exec") {
      continue;
    }
    if (task.status !== "queued" && task.status !== "running") {
      continue;
    }
    const meta = parseExecTaskMeta(task);
    if (meta?.pid && isPidAlive(meta.pid)) {
      try {
        process.kill(meta.pid, "SIGKILL");
        killed += 1;
      } catch {
        // Process may have already exited.
      }
    }
    persistTerminal({
      taskId: task.taskId,
      status: "cancelled",
      summary: `force-stopped by user (${reason})`,
      error: reason,
      retentionMs: resolveLongTaskRetentionMsForStatus("cancelled", cfg.retention),
    });
  }
  return { cancelled, killed };
}

function indexSessionKey(sessionKey: string | undefined, processSessionId: string): void {
  const key = sessionKey?.trim();
  if (!key) {
    return;
  }
  const set = waitersBySessionKey.get(key) ?? new Set<string>();
  set.add(processSessionId);
  waitersBySessionKey.set(key, set);
}

function unindexSessionKey(sessionKey: string | undefined, processSessionId: string): void {
  const key = sessionKey?.trim();
  if (!key) {
    return;
  }
  const set = waitersBySessionKey.get(key);
  if (!set) {
    return;
  }
  set.delete(processSessionId);
  if (set.size === 0) {
    waitersBySessionKey.delete(key);
  }
}

function registerWaiter(waiter: LongTaskWaiter): void {
  waitersByProcessSession.set(waiter.processSessionId, waiter);
  if (waiter.taskId) {
    waitersByTaskId.set(waiter.taskId, waiter);
  }
  indexSessionKey(waiter.sessionKey, waiter.processSessionId);
}

function forgetWaiter(processSessionId: string): LongTaskWaiter | undefined {
  const waiter = waitersByProcessSession.get(processSessionId);
  if (!waiter) {
    return undefined;
  }
  waitersByProcessSession.delete(processSessionId);
  if (waiter.taskId) {
    waitersByTaskId.delete(waiter.taskId);
  }
  unindexSessionKey(waiter.sessionKey, processSessionId);
  return waiter;
}

export function isProcessSessionLongTaskManaged(processSessionId: string): boolean {
  return waitersByProcessSession.has(processSessionId);
}

/** Completion notify during park. Aborts the remaining wait. */
export function notifyLongTaskProcessFinished(processSessionId: string): boolean {
  const waiter = waitersByProcessSession.get(processSessionId);
  if (!waiter) {
    return false;
  }
  waiter.finished.resolve();
  return true;
}

export function hasActiveLongTaskForSession(sessionKey: string | undefined): boolean {
  const key = sessionKey?.trim();
  if (!key) {
    return false;
  }
  return (waitersBySessionKey.get(key)?.size ?? 0) > 0;
}

export function listActiveLongTasksForSession(sessionKey: string | undefined): LongTaskWaiter[] {
  const key = sessionKey?.trim();
  if (!key) {
    return [];
  }
  const ids = waitersBySessionKey.get(key);
  if (!ids) {
    return [];
  }
  return [...ids]
    .map((id) => waitersByProcessSession.get(id))
    .filter((waiter): waiter is LongTaskWaiter => Boolean(waiter));
}

export function listActiveLongTaskWaiters(): LongTaskWaiter[] {
  return [...waitersByProcessSession.values()];
}

export function shouldBlockEndTurnForSession(
  sessionKey: string | undefined,
  cfg?: ResolvedLongTaskConfig,
): boolean {
  const resolved = cfg ?? resolveLongTaskConfig();
  return resolved.blockEndTurn && hasActiveLongTaskForSession(sessionKey);
}

export function isPidAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isExecTaskBackingAlive(task: TaskRecord): boolean {
  if (task.runtime !== "exec") {
    return false;
  }
  if (task.status !== "queued" && task.status !== "running") {
    return false;
  }
  if (task.taskId && waitersByTaskId.has(task.taskId)) {
    return true;
  }
  const meta = parseExecTaskMeta(task);
  if (meta?.sessionId && waitersByProcessSession.has(meta.sessionId)) {
    return true;
  }
  if (meta?.sessionId) {
    const session = getSession(meta.sessionId);
    if (session && !session.exited) {
      return true;
    }
  }
  return isPidAlive(meta?.pid);
}

function persistCreatedTask(params: {
  sessionKey?: string;
  agentId?: string;
  command: string;
  processSessionId: string;
  startedAt?: number;
  meta: ExecTaskMeta;
}): string | undefined {
  try {
    const record = createTaskRecord({
      runtime: "exec",
      taskKind: "long-task",
      sourceId: params.processSessionId,
      runId: params.processSessionId,
      requesterSessionKey: params.sessionKey,
      agentId: params.agentId,
      requesterAgentId: params.agentId,
      label: params.command.slice(0, 120),
      task: params.command,
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      startedAt: params.startedAt ?? Date.now(),
      progressSummary: encodeExecTaskMeta(params.meta),
    });
    return record?.taskId;
  } catch (error) {
    log.warn("Failed to persist long-task start", { error: formatErrorMessage(error) });
    return undefined;
  }
}

function persistRunningProgress(waiter: LongTaskWaiter): void {
  if (!waiter.taskId) {
    return;
  }
  try {
    updateTaskProgressById({
      taskId: waiter.taskId,
      progressSummary: encodeExecTaskMeta({
        phase: waiter.phase,
        pid: waiter.pid,
        sessionId: waiter.processSessionId,
        maxWaitMs: waiter.maxWaitMs,
        deadlineAt: waiter.deadlineAt,
        toolCallId: waiter.toolCallId,
        outputPath: waiter.outputPath,
      }),
    });
  } catch {
    // Progress writes are best-effort; the in-memory waiter is authoritative.
  }
}

function persistTerminal(params: {
  taskId?: string;
  status: LongTaskTerminalStatus | "lost";
  summary: string;
  error?: string;
  retentionMs: number;
  endedAt?: number;
}): void {
  if (!params.taskId) {
    return;
  }
  const endedAt = params.endedAt ?? Date.now();
  try {
    if (params.status === "lost") {
      markTaskLostById({
        taskId: params.taskId,
        endedAt,
        error: params.error,
        terminalSummary: params.summary,
        cleanupAfter: endedAt + params.retentionMs,
      });
      return;
    }
    markTaskTerminalById({
      taskId: params.taskId,
      status: params.status,
      endedAt,
      terminalSummary: params.summary,
      error: params.error,
      cleanupAfter: endedAt + params.retentionMs,
    });
  } catch (error) {
    log.warn("Failed to persist long-task terminal state", {
      taskId: params.taskId,
      error: formatErrorMessage(error),
    });
  }
}

function mapOutcomeStatus(params: {
  outcome?: ExecProcessOutcome;
  cancelled: boolean;
  timedOut: boolean;
}): LongTaskTerminalStatus {
  if (params.cancelled) {
    return "cancelled";
  }
  if (
    params.timedOut ||
    params.outcome?.timedOut ||
    params.outcome?.exitReason === "overall-timeout"
  ) {
    return "timed_out";
  }
  if (
    !params.outcome ||
    params.outcome.status === "failed" ||
    (params.outcome.exitCode ?? 0) !== 0
  ) {
    return "failed";
  }
  return "succeeded";
}

export function formatFoldedLongTaskText(result: LongTaskFoldedResult): string {
  const lines = [
    `phase: ${result.phase} → ${result.status}`,
    `elapsedMs: ${result.elapsedMs}`,
    `status: ${result.status}`,
    `exitCode: ${result.exitCode ?? "n/a"}`,
  ];
  if (result.exitSignal) {
    lines.push(`exitSignal: ${result.exitSignal}`);
  }
  if (result.sessionId) {
    lines.push(`sessionId: ${result.sessionId}`);
  }
  if (result.taskId) {
    lines.push(`taskId: ${result.taskId}`);
  }
  if (result.outputPath) {
    lines.push(`outputPath: ${result.outputPath}`);
  }
  const summary = result.summary.trim();
  lines.push(`summary: ${summary || "(empty)"}`);
  return lines.join("\n");
}

async function resolveOutcomeAfterNotify(params: {
  exitPromise: Promise<ExecProcessOutcome>;
  processSessionId: string;
}): Promise<ExecProcessOutcome | undefined> {
  const outcome = await Promise.race([
    params.exitPromise,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 200);
      timer.unref?.();
    }),
  ]);
  if (outcome) {
    return outcome;
  }
  const finished = getFinishedSession(params.processSessionId);
  if (!finished) {
    return undefined;
  }
  if (finished.status === "completed") {
    return {
      status: "completed",
      exitCode: finished.exitCode ?? 0,
      exitSignal: finished.exitSignal ?? null,
      exitReason: finished.exitReason,
      durationMs: Math.max(0, finished.endedAt - finished.startedAt),
      aggregated: finished.aggregated,
      timedOut: false,
      noOutputTimedOut: finished.noOutputTimedOut,
    };
  }
  return {
    status: "failed",
    exitCode: finished.exitCode ?? null,
    exitSignal: finished.exitSignal ?? null,
    exitReason: finished.exitReason,
    durationMs: Math.max(0, finished.endedAt - finished.startedAt),
    aggregated: finished.aggregated,
    timedOut:
      finished.exitReason === "overall-timeout" || finished.exitReason === "no-output-timeout",
    noOutputTimedOut: finished.noOutputTimedOut,
    failureKind: "runtime-error",
    reason: finished.exitReason ?? finished.status,
  };
}

async function waitRace(params: {
  exitPromise: Promise<ExecProcessOutcome>;
  processSessionId: string;
  finishedPromise: Promise<void>;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<
  { kind: "exit"; outcome: ExecProcessOutcome } | { kind: "timeout" } | { kind: "abort" }
> {
  if (params.signal.aborted) {
    return { kind: "abort" };
  }
  if (params.timeoutMs <= 0) {
    return { kind: "timeout" };
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const raced = await new Promise<"exit" | "notified" | "timeout" | "abort" | { error: unknown }>(
      (resolve) => {
        let settled = false;
        const finish = (value: "exit" | "notified" | "timeout" | "abort" | { error: unknown }) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(value);
        };
        onAbort = () => finish("abort");
        params.signal.addEventListener("abort", onAbort, { once: true });
        timeoutId = setTimeout(() => finish("timeout"), params.timeoutMs);
        timeoutId.unref?.();
        params.exitPromise.then(
          () => finish("exit"),
          (error) => finish({ error }),
        );
        void params.finishedPromise.then(() => finish("notified"));
        const liveSession = getSession(params.processSessionId);
        const alreadyFinished = getFinishedSession(params.processSessionId);
        if (alreadyFinished) {
          finish("notified");
        } else if (liveSession) {
          void waitForSessionExit(params.processSessionId, params.timeoutMs, params.signal).then(
            (kind) => {
              if (kind === "exit") {
                finish("notified");
              } else if (kind === "abort") {
                finish("abort");
              }
            },
          );
        }
      },
    );
    if (typeof raced === "object" && "error" in raced) {
      throw raced.error;
    }
    if (raced === "abort") {
      return { kind: "abort" };
    }
    if (raced === "timeout") {
      return { kind: "timeout" };
    }
    const outcome = await resolveOutcomeAfterNotify({
      exitPromise: params.exitPromise,
      processSessionId: params.processSessionId,
    });
    if (!outcome) {
      return { kind: "timeout" };
    }
    return { kind: "exit", outcome };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (onAbort) {
      params.signal.removeEventListener("abort", onAbort);
    }
  }
}

export type RunLongTaskSupervisorParams = {
  processSessionId: string;
  command: string;
  exitPromise: Promise<ExecProcessOutcome>;
  kill: () => void;
  signal?: AbortSignal;
  config?: ResolvedLongTaskConfig;
  sessionKey?: string;
  agentId?: string;
  pid?: number;
  startedAt?: number;
  toolCallId?: string;
  outputPath?: string;
};

export async function runLongTaskSupervisor(
  params: RunLongTaskSupervisorParams,
): Promise<LongTaskFoldedResult> {
  const cfg = params.config ?? resolveLongTaskConfig();
  const startedAt = params.startedAt ?? Date.now();
  const deadlineAt = startedAt + cfg.maxWaitMs;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(params.signal?.reason ?? "aborted");
  if (params.signal?.aborted) {
    controller.abort(params.signal.reason);
  } else {
    params.signal?.addEventListener("abort", forwardAbort, { once: true });
  }

  const waiter: LongTaskWaiter = {
    processSessionId: params.processSessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    command: params.command,
    pid: params.pid,
    phase: "long_running",
    startedAt,
    deadlineAt,
    maxWaitMs: cfg.maxWaitMs,
    controller,
    finished: createFinishedSignal(),
    toolCallId: params.toolCallId,
    outputPath: params.outputPath,
  };
  waiter.taskId = persistCreatedTask({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    command: params.command,
    processSessionId: params.processSessionId,
    startedAt,
    meta: {
      phase: "long_running",
      pid: params.pid,
      sessionId: params.processSessionId,
      maxWaitMs: cfg.maxWaitMs,
      deadlineAt,
      toolCallId: params.toolCallId,
      outputPath: params.outputPath,
    },
  });
  registerWaiter(waiter);

  let outcome: ExecProcessOutcome | undefined;
  let cancelled = controller.signal.aborted;
  let timedOut = false;
  const phase: LongTaskPhase = "long_running";

  try {
    persistRunningProgress(waiter);
    if (!cancelled) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        timedOut = true;
      } else {
        const raced = await waitRace({
          exitPromise: params.exitPromise,
          processSessionId: params.processSessionId,
          finishedPromise: waiter.finished.promise,
          timeoutMs: remaining,
          signal: controller.signal,
        });
        if (raced.kind === "exit") {
          outcome = raced.outcome;
        } else if (raced.kind === "abort") {
          cancelled = true;
        } else {
          timedOut = true;
        }
      }
    }

    if ((cancelled || timedOut) && !outcome) {
      try {
        params.kill();
      } catch {
        // Best-effort kill; the waiter still settles.
      }
    }

    const status = mapOutcomeStatus({ outcome, cancelled, timedOut });
    const aggregated = outcome?.aggregated ?? "";
    const summary = truncateSummary(aggregated || outcome?.reason || status);
    const result: LongTaskFoldedResult = {
      status,
      phase,
      elapsedMs: Date.now() - startedAt,
      exitCode: outcome?.exitCode ?? null,
      exitSignal: outcome?.exitSignal != null ? String(outcome.exitSignal) : undefined,
      timedOut: status === "timed_out",
      cancelled: status === "cancelled",
      summary,
      aggregated,
      sessionId: params.processSessionId,
      outputPath: params.outputPath ?? resolveExecOutputPath(params.processSessionId),
      pid: params.pid,
      taskId: waiter.taskId,
    };
    persistTerminal({
      taskId: waiter.taskId,
      status,
      summary,
      error:
        status === "succeeded"
          ? undefined
          : ((outcome && "reason" in outcome ? outcome.reason : undefined) ?? status),
      retentionMs: resolveLongTaskRetentionMsForStatus(status, cfg.retention),
    });
    if (status === "cancelled") {
      throw createAbortError("Long task cancelled");
    }
    return result;
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      persistTerminal({
        taskId: waiter.taskId,
        status: "cancelled",
        summary: "cancelled",
        error: "cancelled",
        retentionMs: resolveLongTaskRetentionMsForStatus("cancelled", cfg.retention),
      });
      throw isAbortError(error) ? error : createAbortError("Long task cancelled");
    }
    throw error;
  } finally {
    params.signal?.removeEventListener("abort", forwardAbort);
    forgetWaiter(params.processSessionId);
  }
}

export function cancelLongTasksForSession(
  sessionKey: string | undefined,
  reason = "cancelled",
): number {
  const waiters = listActiveLongTasksForSession(sessionKey);
  for (const waiter of waiters) {
    if (!waiter.controller.signal.aborted) {
      waiter.controller.abort(reason);
    }
  }
  return waiters.length;
}

export function cancelLongTaskByProcessSession(
  processSessionId: string,
  reason = "cancelled",
): boolean {
  const waiter = waitersByProcessSession.get(processSessionId);
  if (!waiter) {
    return false;
  }
  if (!waiter.controller.signal.aborted) {
    waiter.controller.abort(reason);
  }
  return true;
}

export function cancelAllLongTasks(reason = "cancelled"): number {
  let count = 0;
  for (const waiter of waitersByProcessSession.values()) {
    if (!waiter.controller.signal.aborted) {
      waiter.controller.abort(reason);
      count += 1;
    }
  }
  return count;
}

export async function watchPidUntilExit(params: {
  pid: number;
  timeoutMs: number;
  signal?: AbortSignal;
  intervalMs?: number;
}): Promise<"exit" | "timeout" | "abort"> {
  const intervalMs = Math.max(250, params.intervalMs ?? 1_000);
  const deadline = Date.now() + Math.max(0, params.timeoutMs);
  while (isPidAlive(params.pid)) {
    if (params.signal?.aborted) {
      return "abort";
    }
    if (Date.now() >= deadline) {
      return "timeout";
    }
    const remaining = Math.max(0, deadline - Date.now());
    const slice = Math.min(intervalMs, remaining);
    const aborted = await new Promise<"tick" | "abort">((resolve) => {
      if (params.signal?.aborted) {
        resolve("abort");
        return;
      }
      const timer = setTimeout(() => resolve("tick"), slice);
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        resolve("abort");
      };
      params.signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (aborted === "abort") {
      return "abort";
    }
  }
  return "exit";
}

export async function reattachPersistedExecLongTasks(cfg?: ResolvedLongTaskConfig): Promise<{
  reattached: number;
  lost: number;
  forceStopped: boolean;
}> {
  const resolved = cfg ?? resolveLongTaskConfig();
  let reattached = 0;
  let lost = 0;
  let records: TaskRecord[] = [];
  try {
    records = listTaskRecords();
  } catch (error) {
    log.warn("Failed to list tasks for long-task reattach", { error: formatErrorMessage(error) });
    return { reattached, lost, forceStopped: false };
  }
  for (const task of records) {
    if (task.runtime !== "exec") {
      continue;
    }
    if (task.status !== "queued" && task.status !== "running") {
      continue;
    }
    if (task.taskId && waitersByTaskId.has(task.taskId)) {
      continue;
    }
    const meta = parseExecTaskMeta(task);
    const timing = resolveLongTaskReattachTiming({
      startedAt: task.startedAt,
      createdAt: task.createdAt,
      maxWaitMs: meta?.maxWaitMs,
      deadlineAt: meta?.deadlineAt,
      defaultMaxWaitMs: resolved.maxWaitMs,
    });
    if (meta?.pid && isPidAlive(meta.pid)) {
      const controller = new AbortController();
      const waiter: LongTaskWaiter = {
        taskId: task.taskId,
        processSessionId: meta.sessionId,
        sessionKey: task.requesterSessionKey,
        agentId: task.agentId,
        command: task.task,
        pid: meta.pid,
        phase: "long_running",
        startedAt: timing.startedAt,
        deadlineAt: timing.deadlineAt,
        maxWaitMs: timing.maxWaitMs,
        controller,
        finished: createFinishedSignal(),
        toolCallId: meta.toolCallId,
        outputPath: meta.outputPath,
      };
      registerWaiter(waiter);
      reattached += 1;
      if (task.requesterSessionKey) {
        void import("../config/sessions/store.js")
          .then(({ patchSessionEntry }) =>
            patchSessionEntry({
              sessionKey: task.requesterSessionKey,
              agentId: task.agentId,
              update: (entry) => ({
                ...entry,
                status: "running",
                endedAt: undefined,
              }),
            }),
          )
          .catch((error) => {
            log.warn("Failed to restore session run after long-task reattach", {
              taskId: task.taskId,
              error: formatErrorMessage(error),
            });
          });
      }
      void watchPidUntilExit({
        pid: meta.pid,
        timeoutMs: timing.remainingMs,
        signal: controller.signal,
      })
        .then(async (kind) => {
          const status: LongTaskTerminalStatus | "lost" =
            kind === "abort" ? "cancelled" : kind === "timeout" ? "timed_out" : "succeeded";
          const elapsedMs = Date.now() - timing.startedAt;
          const summary = formatReattachedLongTaskNotice({
            status,
            elapsedMs,
            command: task.task,
            kind,
            outputPath:
              meta.outputPath?.trim() ||
              resolveExecOutputPath(meta.sessionId || task.sourceId || ""),
          });
          await announceReattachedLongTaskTerminal({
            task,
            status,
            elapsedMs,
            kind,
            summary,
            retention: resolved.retention,
            wake: true,
          });
        })
        .catch((error) => {
          log.warn("Long-task reattach watcher failed", {
            taskId: task.taskId,
            error: formatErrorMessage(error),
          });
        })
        .finally(() => {
          forgetWaiter(meta.sessionId);
        });
      continue;
    }
    // Pid is already gone. Do not leave the ledger running for the sweeper
    // grace window — elapsed would keep growing against a dead shell.
    lost += 1;
    const endedAt = resolveMissingExecTaskEndedAt({ task, meta });
    const elapsedMs = Math.max(0, endedAt - timing.startedAt);
    const summary = formatReattachedLongTaskNotice({
      status: "lost",
      elapsedMs,
      command: task.task,
      kind: "lost",
      outputPath:
        meta?.outputPath?.trim() || resolveExecOutputPath(meta?.sessionId ?? task.sourceId ?? ""),
    });
    await announceReattachedLongTaskTerminal({
      task,
      status: "lost",
      elapsedMs,
      kind: "lost",
      summary,
      retention: resolved.retention,
      wake: true,
      endedAt,
    });
  }
  return { reattached, lost, forceStopped: false };
}

export function markStaleExecTaskLost(
  task: TaskRecord,
  cfg?: ResolvedLongTaskConfig,
): TaskRecord | null {
  const resolved = cfg ?? resolveLongTaskConfig();
  try {
    return markTaskLostById({
      taskId: task.taskId,
      endedAt: Date.now(),
      error: "backing process missing",
      cleanupAfter: Date.now() + resolved.retention.lostMs,
    });
  } catch (error) {
    log.warn("Failed to mark exec long-task lost", {
      taskId: task.taskId,
      error: formatErrorMessage(error),
    });
    return null;
  }
}

export function registerLongTaskWaiterForTests(params: {
  processSessionId: string;
  sessionKey: string;
  pid?: number;
}): AbortController {
  const now = Date.now();
  const controller = new AbortController();
  registerWaiter({
    processSessionId: params.processSessionId,
    sessionKey: params.sessionKey,
    command: "test-long-task",
    phase: "long_running",
    startedAt: now,
    deadlineAt: now + 1_800_000,
    maxWaitMs: 1_800_000,
    controller,
    finished: createFinishedSignal(),
    pid: params.pid,
  });
  return controller;
}

export function resetLongTaskRuntimeForTests(): void {
  for (const waiter of waitersByProcessSession.values()) {
    if (!waiter.controller.signal.aborted) {
      waiter.controller.abort("test-reset");
    }
  }
  waitersByProcessSession.clear();
  waitersByTaskId.clear();
  waitersBySessionKey.clear();
}

export function listLongTaskWaitersForTests(): LongTaskWaiter[] {
  return listActiveLongTaskWaiters();
}

export function formatLongTaskQueryRecord(task: TaskRecord): {
  taskId: string;
  runtime: TaskRecord["runtime"];
  status: TaskStatus;
  phase?: LongTaskPhase;
  command: string;
  elapsedMs: number;
  sessionId?: string;
  pid?: number;
  summary?: string;
} {
  const meta = task.runtime === "exec" ? parseExecTaskMeta(task) : null;
  const now = Date.now();
  const started = task.startedAt ?? task.createdAt;
  return {
    taskId: task.taskId,
    runtime: task.runtime,
    status: task.status,
    ...(meta?.phase && !isTerminalTaskStatus(task.status) ? { phase: meta.phase } : {}),
    command: task.task,
    elapsedMs: Math.max(0, (task.endedAt ?? now) - started),
    sessionId: meta?.sessionId ?? task.sourceId,
    pid: meta?.pid,
    summary: task.terminalSummary ?? task.progressSummary,
  };
}
