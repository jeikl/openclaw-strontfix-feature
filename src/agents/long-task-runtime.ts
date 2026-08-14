/**
 * Runtime-owned long-task state machine.
 * Short-polls and parks without model calls; only a folded terminal result
 * returns to the current turn.
 */
import { createAbortError, isAbortError } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createTaskRecord,
  listTaskRecords,
  markTaskLostById,
  markTaskTerminalById,
  updateTaskProgressById,
} from "../tasks/task-registry.js";
import type { TaskRecord, TaskStatus } from "../tasks/task-registry.types.js";
import { getSession } from "./bash-process-registry.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-runtime.js";
import {
  DEFAULT_LONG_TASK_SUMMARY_MAX_CHARS,
  resolveLongTaskConfig,
  resolveLongTaskRetentionMsForStatus,
  type ResolvedLongTaskConfig,
} from "./long-task-config.js";

const log = createSubsystemLogger("agents/long-task");

export type LongTaskPhase = "short_polling" | "long_running";
export type LongTaskTerminalStatus = "succeeded" | "failed" | "timed_out" | "cancelled";

export type LongTaskFoldedResult = {
  status: LongTaskTerminalStatus;
  phase: LongTaskPhase;
  shortPolls: number;
  shortPollElapsedMs: number;
  elapsedMs: number;
  exitCode: number | null;
  exitSignal?: string;
  timedOut: boolean;
  cancelled: boolean;
  summary: string;
  aggregated: string;
  sessionId: string;
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
  shortPollsDone: number;
  shortPollElapsedMs: number;
  startedAt: number;
  deadlineAt: number;
  maxWaitMs: number;
  controller: AbortController;
};

const waitersByProcessSession = new Map<string, LongTaskWaiter>();
const waitersByTaskId = new Map<string, LongTaskWaiter>();
const waitersBySessionKey = new Map<string, Set<string>>();

export type ExecTaskMeta = {
  phase: LongTaskPhase;
  shortPolls: number;
  shortPollElapsedMs: number;
  pid?: number;
  sessionId: string;
  maxWaitMs: number;
  deadlineAt: number;
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
        return parsed;
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
    shortPolls: 0,
    shortPollElapsedMs: 0,
    sessionId,
    maxWaitMs: 0,
    deadlineAt: 0,
  };
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
      startedAt: Date.now(),
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
        shortPolls: waiter.shortPollsDone,
        shortPollElapsedMs: waiter.shortPollElapsedMs,
        pid: waiter.pid,
        sessionId: waiter.processSessionId,
        maxWaitMs: waiter.maxWaitMs,
        deadlineAt: waiter.deadlineAt,
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
}): void {
  if (!params.taskId) {
    return;
  }
  const endedAt = Date.now();
  try {
    if (params.status === "lost") {
      markTaskLostById({
        taskId: params.taskId,
        endedAt,
        error: params.error,
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
    `shortPolls: ${result.shortPolls}`,
    `shortPollElapsedMs: ${result.shortPollElapsedMs}`,
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
  const summary = result.summary.trim();
  lines.push(`summary: ${summary || "(empty)"}`);
  return lines.join("\n");
}

async function waitRace(params: {
  exitPromise: Promise<ExecProcessOutcome>;
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
    return await new Promise((resolve, reject) => {
      const finish = (
        value:
          | { kind: "exit"; outcome: ExecProcessOutcome }
          | { kind: "timeout" }
          | { kind: "abort" },
      ) => {
        resolve(value);
      };
      onAbort = () => finish({ kind: "abort" });
      params.signal.addEventListener("abort", onAbort, { once: true });
      timeoutId = setTimeout(() => finish({ kind: "timeout" }), params.timeoutMs);
      timeoutId.unref?.();
      params.exitPromise.then(
        (outcome) => finish({ kind: "exit", outcome }),
        (error) => reject(error),
      );
    });
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
    phase: "short_polling",
    shortPollsDone: 0,
    shortPollElapsedMs: 0,
    startedAt,
    deadlineAt,
    maxWaitMs: cfg.maxWaitMs,
    controller,
  };
  waiter.taskId = persistCreatedTask({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    command: params.command,
    processSessionId: params.processSessionId,
    meta: {
      phase: "short_polling",
      shortPolls: 0,
      shortPollElapsedMs: 0,
      pid: params.pid,
      sessionId: params.processSessionId,
      maxWaitMs: cfg.maxWaitMs,
      deadlineAt,
    },
  });
  registerWaiter(waiter);

  let outcome: ExecProcessOutcome | undefined;
  let cancelled = controller.signal.aborted;
  let timedOut = false;
  let phase: LongTaskPhase = "short_polling";

  try {
    for (let i = 0; i < cfg.shortPolls; i += 1) {
      if (controller.signal.aborted) {
        cancelled = true;
        break;
      }
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      const sliceMs = Math.min(cfg.shortPollTimeoutMs, remaining);
      const sliceStarted = Date.now();
      const raced = await waitRace({
        exitPromise: params.exitPromise,
        timeoutMs: sliceMs,
        signal: controller.signal,
      });
      waiter.shortPollsDone = i + 1;
      waiter.shortPollElapsedMs += Date.now() - sliceStarted;
      persistRunningProgress(waiter);
      if (raced.kind === "exit") {
        outcome = raced.outcome;
        break;
      }
      if (raced.kind === "abort") {
        cancelled = true;
        break;
      }
    }

    if (!outcome && !cancelled && !timedOut) {
      phase = "long_running";
      waiter.phase = "long_running";
      persistRunningProgress(waiter);
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        timedOut = true;
      } else {
        const raced = await waitRace({
          exitPromise: params.exitPromise,
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
      shortPolls: waiter.shortPollsDone,
      shortPollElapsedMs: waiter.shortPollElapsedMs,
      elapsedMs: Date.now() - startedAt,
      exitCode: outcome?.exitCode ?? null,
      exitSignal: outcome?.exitSignal != null ? String(outcome.exitSignal) : undefined,
      timedOut: status === "timed_out",
      cancelled: status === "cancelled",
      summary,
      aggregated,
      sessionId: params.processSessionId,
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
}> {
  const resolved = cfg ?? resolveLongTaskConfig();
  let reattached = 0;
  let lost = 0;
  let records: TaskRecord[] = [];
  try {
    records = listTaskRecords();
  } catch (error) {
    log.warn("Failed to list tasks for long-task reattach", { error: formatErrorMessage(error) });
    return { reattached, lost };
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
        shortPollsDone: meta.shortPolls,
        shortPollElapsedMs: meta.shortPollElapsedMs,
        startedAt: task.startedAt ?? task.createdAt,
        deadlineAt: meta.deadlineAt || Date.now() + resolved.maxWaitMs,
        maxWaitMs: meta.maxWaitMs || resolved.maxWaitMs,
        controller,
      };
      registerWaiter(waiter);
      reattached += 1;
      void watchPidUntilExit({
        pid: meta.pid,
        timeoutMs: Math.max(0, waiter.deadlineAt - Date.now()),
        signal: controller.signal,
      })
        .then((kind) => {
          const status: LongTaskTerminalStatus | "lost" =
            kind === "abort" ? "cancelled" : kind === "timeout" ? "timed_out" : "succeeded";
          persistTerminal({
            taskId: task.taskId,
            status,
            summary: kind === "exit" ? "exited after gateway reattach" : kind,
            error: status === "succeeded" ? undefined : status,
            retentionMs: resolveLongTaskRetentionMsForStatus(status, resolved.retention),
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
    // Leave missing-pid tasks for the sweeper grace window, then lost.
  }
  return { reattached, lost };
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
  return [...waitersByProcessSession.values()];
}

export function formatLongTaskQueryRecord(task: TaskRecord): {
  taskId: string;
  status: TaskStatus;
  phase?: LongTaskPhase;
  command: string;
  elapsedMs: number;
  sessionId?: string;
  pid?: number;
  summary?: string;
} {
  const meta = parseExecTaskMeta(task);
  const now = Date.now();
  const started = task.startedAt ?? task.createdAt;
  return {
    taskId: task.taskId,
    status: task.status,
    phase: meta?.phase,
    command: task.task,
    elapsedMs: Math.max(0, (task.endedAt ?? now) - started),
    sessionId: meta?.sessionId ?? task.sourceId,
    pid: meta?.pid,
    summary: task.terminalSummary ?? task.progressSummary,
  };
}
