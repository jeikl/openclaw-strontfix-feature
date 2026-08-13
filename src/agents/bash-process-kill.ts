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

function normalizeScopeKey(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function sessionMatchesScopeKeys(session: ProcessSession, scopeKeys: ReadonlySet<string>): boolean {
  const scopeKey = normalizeScopeKey(session.scopeKey);
  if (scopeKey && scopeKeys.has(scopeKey)) {
    return true;
  }
  const sessionKey = normalizeScopeKey(session.sessionKey);
  return Boolean(sessionKey && scopeKeys.has(sessionKey));
}

function terminateSessionFallback(session: ProcessSession): boolean {
  const pid = session.pid ?? session.child?.pid;
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  killProcessTree(pid);
  return true;
}

/**
 * Cancel every still-running exec/bash session that belongs to the given
 * process-tool scope keys (typically agent sessionKey / sessionId).
 *
 * Mirrors process-tool kill semantics: prefer supervisor cancel (SIGINT-like
 * cancel path), then fall back to process-tree kill when unmanaged.
 */
export function killRunningExecSessionsForScopes(params: {
  scopeKeys?: Array<string | undefined | null>;
}): { attempted: number; sessionIds: string[] } {
  const scopeKeys = new Set(
    (params.scopeKeys ?? [])
      .map((key) => normalizeScopeKey(key))
      .filter((key): key is string => Boolean(key)),
  );
  if (scopeKeys.size === 0) {
    return { attempted: 0, sessionIds: [] };
  }

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
    if (session.exited || !sessionMatchesScopeKeys(session, scopeKeys)) {
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
      continue;
    }

    if (terminateSessionFallback(session) && !session.exited) {
      markExited(session, null, "SIGKILL", "failed");
    }
  }

  return { attempted: sessionIds.length, sessionIds };
}
