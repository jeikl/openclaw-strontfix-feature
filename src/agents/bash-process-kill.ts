/**
 * Bulk-kill helpers for in-progress exec/bash sessions.
 * Used when an agent run is stopped so leftover processes free resources.
 */
import { killProcessTree } from "../process/kill-tree.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  listAllRunningSessions,
  markExited,
  type ProcessSession,
} from "./bash-process-registry.js";
import { cancelLongTaskByProcessSession, listActiveLongTaskWaiters } from "./long-task-runtime.js";

function normalizeScopeKey(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function collectScopeKeys(values: Array<string | undefined | null> | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map((key) => normalizeScopeKey(key))
      .filter((key): key is string => Boolean(key)),
  );
}

/** Same alias matching as channel /stop: `agent:main:main` vs `main`. */
function keysLooselyMatch(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  return a.endsWith(`:${b}`) || b.endsWith(`:${a}`);
}

function keyMatchesScopeKeys(
  value: string | undefined,
  scopeKeys: ReadonlySet<string>,
  looseMatch: boolean,
): boolean {
  const key = normalizeScopeKey(value);
  if (!key) {
    return false;
  }
  if (scopeKeys.has(key)) {
    return true;
  }
  if (!looseMatch) {
    return false;
  }
  for (const scopeKey of scopeKeys) {
    if (keysLooselyMatch(key, scopeKey)) {
      return true;
    }
  }
  return false;
}

function sessionMatchesScopeKeys(
  session: ProcessSession,
  scopeKeys: ReadonlySet<string>,
  looseMatch = false,
): boolean {
  return (
    keyMatchesScopeKeys(session.scopeKey, scopeKeys, looseMatch) ||
    keyMatchesScopeKeys(session.sessionKey, scopeKeys, looseMatch) ||
    keyMatchesScopeKeys(session.id, scopeKeys, false)
  );
}

function terminateSessionFallback(session: ProcessSession, force = false): boolean {
  const pid = session.pid ?? session.child?.pid;
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  if (force) {
    killProcessTree(pid, { force: true });
  } else {
    killProcessTree(pid);
  }
  return true;
}

/**
 * Cancel every still-running exec/bash session that belongs to the given
 * process-tool scope keys (typically agent sessionKey / sessionId).
 *
 * Mirrors process-tool kill semantics: prefer supervisor cancel (SIGINT-like
 * cancel path), then fall back to process-tree kill when unmanaged.
 * User `/stop` passes `force` so SIGINT-ignoring children still die.
 */
export function killRunningExecSessionsForScopes(params: {
  scopeKeys?: Array<string | undefined | null>;
  force?: boolean;
  looseMatch?: boolean;
}): { attempted: number; sessionIds: string[] } {
  const scopeKeys = collectScopeKeys(params.scopeKeys);
  if (scopeKeys.size === 0) {
    return { attempted: 0, sessionIds: [] };
  }
  const looseMatch = params.looseMatch === true;
  const force = params.force === true;

  const supervisor = getProcessSupervisor();
  for (const scopeKey of scopeKeys) {
    try {
      supervisor.cancelScope(scopeKey, "manual-cancel");
    } catch {
      // Best-effort: continue terminating other sessions.
    }
  }

  const sessionIds: string[] = [];
  for (const session of listAllRunningSessions()) {
    if (session.exited || !sessionMatchesScopeKeys(session, scopeKeys, looseMatch)) {
      continue;
    }
    sessionIds.push(session.id);

    const record = supervisor.getRecord(session.id);
    if (record && record.state !== "exited") {
      try {
        supervisor.cancel(session.id, "manual-cancel");
      } catch {
        // Best-effort per session.
      }
      if (!force) {
        continue;
      }
    }

    if (terminateSessionFallback(session, force) && !session.exited) {
      markExited(session, null, "SIGKILL", "failed");
    }
  }

  return { attempted: sessionIds.length, sessionIds };
}

export type ForceStopSessionExecWorkResult = {
  attempted: number;
  sessionIds: string[];
  cancelledLongTasks: number;
};

/**
 * User `/stop` / Control UI Stop: cancel long-task waiters and force-kill
 * leftover exec/bash for the session, including alias keys and SIGINT-trapping
 * children. System abort must not use this helper.
 */
export function forceStopSessionExecWork(params: {
  scopeKeys?: Array<string | undefined | null>;
  reason?: string;
}): ForceStopSessionExecWorkResult {
  const scopeKeys = collectScopeKeys(params.scopeKeys);
  const reason = params.reason?.trim() || "stop";
  if (scopeKeys.size === 0) {
    return { attempted: 0, sessionIds: [], cancelledLongTasks: 0 };
  }

  let cancelledLongTasks = 0;
  for (const waiter of listActiveLongTaskWaiters()) {
    const matches =
      keyMatchesScopeKeys(waiter.processSessionId, scopeKeys, false) ||
      keyMatchesScopeKeys(waiter.sessionKey, scopeKeys, true);
    if (!matches) {
      continue;
    }
    if (!waiter.controller.signal.aborted) {
      waiter.controller.abort(reason);
      cancelledLongTasks += 1;
    }
    const pid = waiter.pid;
    if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
      try {
        killProcessTree(pid, { force: true });
      } catch {
        // Process may have already exited.
      }
    }
  }

  const killedExecs = killRunningExecSessionsForScopes({
    scopeKeys: [...scopeKeys],
    force: true,
    looseMatch: true,
  });
  for (const sessionId of killedExecs.sessionIds) {
    cancelLongTaskByProcessSession(sessionId, reason);
  }

  return {
    attempted: killedExecs.attempted + cancelledLongTasks,
    sessionIds: killedExecs.sessionIds,
    cancelledLongTasks,
  };
}
