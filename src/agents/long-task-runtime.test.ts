import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAbortError } from "../infra/abort-signal.js";
import {
  hasPendingHeartbeatWake,
  resetHeartbeatWakeStateForTests,
} from "../infra/heartbeat-wake.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  createTaskRecord,
  getTaskById,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-runtime.js";
import {
  cancelLongTasksForSession,
  formatFoldedLongTaskText,
  formatLongTaskQueryRecord,
  hasActiveLongTaskForSession,
  isProcessSessionLongTaskManaged,
  listLongTaskWaitersForTests,
  notifyLongTaskProcessFinished,
  reattachPersistedExecLongTasks,
  resetLongTaskRuntimeForTests,
  resolveLongTaskReattachTiming,
  runLongTaskSupervisor,
  shouldBlockEndTurnForSession,
} from "./long-task-runtime.js";

function completedOutcome(
  overrides?: Partial<Extract<ExecProcessOutcome, { status: "completed" }>>,
): ExecProcessOutcome {
  return {
    status: "completed",
    exitCode: 0,
    exitSignal: null,
    durationMs: 10,
    aggregated: "hello",
    timedOut: false,
    ...overrides,
  };
}

afterEach(() => {
  resetLongTaskRuntimeForTests();
  resetHeartbeatWakeStateForTests();
  resetSystemEventsForTest();
  resetTaskRegistryForTests({ persist: false });
});

describe("long-task supervisor", () => {
  it("returns a folded success without extra model calls", async () => {
    const result = await runLongTaskSupervisor({
      processSessionId: "sess-fast",
      command: "echo hello",
      exitPromise: Promise.resolve(completedOutcome()),
      kill: () => {},
      config: {
        maxWaitMs: 1_000,
        blockEndTurn: true,
        retention: {
          succeededMs: 1_000,
          failedMs: 1_000,
          lostMs: 1_000,
          outputMs: 1_000,
        },
      },
      sessionKey: "agent:main:test",
    });
    expect(result.status).toBe("succeeded");
    expect(result.phase).toBe("long_running");
    expect(result.outputPath).toBeTruthy();
    expect(formatFoldedLongTaskText(result)).toContain("status: succeeded");
    expect(formatFoldedLongTaskText(result)).toContain(`outputPath: ${result.outputPath}`);
    expect(hasActiveLongTaskForSession("agent:main:test")).toBe(false);
  });

  it("parks until the process exits then folds the terminal result", async () => {
    let resolveExit!: (outcome: ExecProcessOutcome) => void;
    const exitPromise = new Promise<ExecProcessOutcome>((resolve) => {
      resolveExit = resolve;
    });
    const run = runLongTaskSupervisor({
      processSessionId: "sess-park",
      command: "sleep 30",
      exitPromise,
      kill: () => {},
      config: {
        maxWaitMs: 2_000,
        blockEndTurn: true,
        retention: {
          succeededMs: 1_000,
          failedMs: 1_000,
          lostMs: 1_000,
          outputMs: 1_000,
        },
      },
      sessionKey: "agent:main:park",
    });
    await expect
      .poll(() => isProcessSessionLongTaskManaged("sess-park"), { interval: 5, timeout: 500 })
      .toBe(true);
    expect(shouldBlockEndTurnForSession("agent:main:park")).toBe(true);
    await expect
      .poll(
        () =>
          listLongTaskWaitersForTests().find((waiter) => waiter.processSessionId === "sess-park")
            ?.phase,
        { interval: 5, timeout: 500 },
      )
      .toBe("long_running");
    resolveExit(completedOutcome({ aggregated: "done later" }));
    const result = await run;
    expect(result.status).toBe("succeeded");
    expect(result.phase).toBe("long_running");
    expect(result.summary).toContain("done later");
    expect(hasActiveLongTaskForSession("agent:main:park")).toBe(false);
  });

  it("cancels the waiter and throws so /stop can tear down the turn", async () => {
    const exitPromise = new Promise<ExecProcessOutcome>(() => {});
    const killed: string[] = [];
    const run = runLongTaskSupervisor({
      processSessionId: "sess-cancel",
      command: "sleep 30",
      exitPromise,
      kill: () => killed.push("killed"),
      config: {
        maxWaitMs: 5_000,
        blockEndTurn: true,
        retention: {
          succeededMs: 1_000,
          failedMs: 1_000,
          lostMs: 1_000,
          outputMs: 1_000,
        },
      },
      sessionKey: "agent:main:cancel",
    });
    await expect
      .poll(() => hasActiveLongTaskForSession("agent:main:cancel"), { interval: 5, timeout: 500 })
      .toBe(true);
    expect(cancelLongTasksForSession("agent:main:cancel")).toBe(1);
    await expect(run).rejects.toSatisfy((error) => isAbortError(error));
    expect(killed).toEqual(["killed"]);
    expect(hasActiveLongTaskForSession("agent:main:cancel")).toBe(false);
  });

  it("settles as soon as a completion notify arrives", async () => {
    let resolveExit!: (outcome: ExecProcessOutcome) => void;
    const exitPromise = new Promise<ExecProcessOutcome>((resolve) => {
      resolveExit = resolve;
    });
    const started = Date.now();
    const run = runLongTaskSupervisor({
      processSessionId: "sess-notify",
      command: "sleep 30",
      exitPromise,
      kill: () => {},
      config: {
        maxWaitMs: 5_000,
        blockEndTurn: true,
        retention: {
          succeededMs: 1_000,
          failedMs: 1_000,
          lostMs: 1_000,
          outputMs: 1_000,
        },
      },
      sessionKey: "agent:main:notify",
    });
    await expect
      .poll(() => isProcessSessionLongTaskManaged("sess-notify"), { interval: 5, timeout: 500 })
      .toBe(true);
    expect(
      listLongTaskWaitersForTests().find((waiter) => waiter.processSessionId === "sess-notify")
        ?.phase,
    ).toBe("long_running");
    resolveExit(completedOutcome({ aggregated: "early" }));
    expect(notifyLongTaskProcessFinished("sess-notify")).toBe(true);
    const result = await run;
    expect(result.status).toBe("succeeded");
    expect(result.phase).toBe("long_running");
    expect(result.summary).toContain("early");
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("times out after maxWaitMs and kills the process", async () => {
    const exitPromise = new Promise<ExecProcessOutcome>(() => {});
    const killed: string[] = [];
    const result = await runLongTaskSupervisor({
      processSessionId: "sess-timeout",
      command: "sleep 30",
      exitPromise,
      kill: () => killed.push("killed"),
      config: {
        maxWaitMs: 40,
        blockEndTurn: true,
        retention: {
          succeededMs: 1_000,
          failedMs: 1_000,
          lostMs: 1_000,
          outputMs: 1_000,
        },
      },
      sessionKey: "agent:main:timeout",
    });
    expect(result.status).toBe("timed_out");
    expect(result.timedOut).toBe(true);
    expect(killed).toEqual(["killed"]);
  });
});

describe("long-task reattach clock", () => {
  it("keeps remaining wait from the original start instead of restarting at zero", () => {
    const now = 1_000_000;
    const startedAt = now - 50_000;
    const timing = resolveLongTaskReattachTiming({
      startedAt,
      maxWaitMs: 180_000,
      deadlineAt: startedAt + 180_000,
      now,
      defaultMaxWaitMs: 1_800_000,
    });
    expect(timing.elapsedMs).toBe(50_000);
    expect(timing.remainingMs).toBe(130_000);
    expect(timing.deadlineAt).toBe(startedAt + 180_000);
  });

  it("rebuilds the deadline from original start when persisted deadlineAt is missing", () => {
    const now = 2_000_000;
    const startedAt = now - 50_000;
    const timing = resolveLongTaskReattachTiming({
      startedAt,
      now,
      defaultMaxWaitMs: 180_000,
    });
    expect(timing.remainingMs).toBe(130_000);
    expect(timing.deadlineAt).toBe(startedAt + 180_000);
  });

  it("times out on the leftover window after restart and notifies the original session", async () => {
    const startedAt = Date.now() - 80;
    const maxWaitMs = 120;
    const sessionKey = "agent:main:reattach-clock";
    const task = createTaskRecord({
      runtime: "exec",
      taskKind: "long-task",
      sourceId: "sess-reattach-clock",
      runId: "sess-reattach-clock",
      requesterSessionKey: sessionKey,
      agentId: "main",
      requesterAgentId: "main",
      task: "sleep 180",
      status: "running",
      notifyPolicy: "silent",
      startedAt,
      progressSummary: `longtask ${JSON.stringify({
        phase: "long_running",
        elapsedPlaceholder: 40,
        pid: process.pid,
        sessionId: "sess-reattach-clock",
        maxWaitMs,
        deadlineAt: startedAt + maxWaitMs,
      })}`,
    });
    expect(task).toBeTruthy();
    const begun = Date.now();
    const result = await reattachPersistedExecLongTasks({
      maxWaitMs: 5_000,
      blockEndTurn: true,
      retention: {
        succeededMs: 1_000,
        failedMs: 1_000,
        lostMs: 1_000,
        outputMs: 1_000,
      },
    });
    expect(result.reattached).toBe(1);
    await expect
      .poll(() => peekSystemEvents(sessionKey).length, {
        interval: 5,
        timeout: 800,
      })
      .toBeGreaterThan(0);
    expect(Date.now() - begun).toBeLessThan(1_000);
    expect(hasPendingHeartbeatWake()).toBe(true);
    const notice = peekSystemEvents(sessionKey)[0] ?? "";
    expect(notice).toContain("from original start");
    expect(notice).toContain("sleep 180");
  });

  it("marks a dead-pid exec task lost immediately and freezes elapsed", async () => {
    const startedAt = Date.now() - 80_000;
    const sessionKey = "agent:main:dead-pid";
    const task = createTaskRecord({
      runtime: "exec",
      taskKind: "long-task",
      sourceId: "sess-dead-pid",
      runId: "sess-dead-pid",
      requesterSessionKey: sessionKey,
      agentId: "main",
      requesterAgentId: "main",
      task: "sleep 60",
      status: "running",
      notifyPolicy: "silent",
      startedAt,
      progressSummary: `longtask ${JSON.stringify({
        phase: "long_running",
        pid: 2 ** 30,
        sessionId: "sess-dead-pid",
        maxWaitMs: 1_800_000,
        deadlineAt: startedAt + 1_800_000,
      })}`,
    });
    expect(task).toBeTruthy();
    const result = await reattachPersistedExecLongTasks({
      maxWaitMs: 5_000,
      blockEndTurn: true,
      retention: {
        succeededMs: 1_000,
        failedMs: 1_000,
        lostMs: 1_000,
        outputMs: 1_000,
      },
    });
    expect(result.reattached).toBe(0);
    expect(result.lost).toBe(1);
    const stored = getTaskById(task!.taskId);
    expect(stored?.status).toBe("lost");
    expect(stored?.endedAt).toBeTypeOf("number");
    expect(stored?.error).toContain("backing process missing");
    const record = formatLongTaskQueryRecord(stored!);
    expect(record.status).toBe("lost");
    expect(record.phase).toBeUndefined();
    expect(record.elapsedMs).toBeGreaterThanOrEqual(70_000);
    expect(record.elapsedMs).toBeLessThan(95_000);
    expect(record.summary).toContain("Backing process is gone");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const later = formatLongTaskQueryRecord(getTaskById(task!.taskId)!);
    expect(later.elapsedMs).toBe(record.elapsedMs);
    await expect
      .poll(() => peekSystemEvents(sessionKey).length, { interval: 5, timeout: 800 })
      .toBeGreaterThan(0);
    expect(peekSystemEvents(sessionKey)[0]).toContain("status: lost");
    expect(hasPendingHeartbeatWake()).toBe(true);
  });

  it("uses exec output mtime as endedAt when the backing pid is already gone", async () => {
    const startedAt = Date.now() - 80_000;
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-output-"));
    const outputPath = path.join(outputDir, "sess-mtime-lost.log");
    fs.writeFileSync(outputPath, "first line only\n");
    const outputEndedAt = startedAt + 17_000;
    fs.utimesSync(outputPath, outputEndedAt / 1000, outputEndedAt / 1000);
    const task = createTaskRecord({
      runtime: "exec",
      taskKind: "long-task",
      sourceId: "sess-mtime-lost",
      runId: "sess-mtime-lost",
      requesterSessionKey: "agent:main:mtime-lost",
      agentId: "main",
      requesterAgentId: "main",
      task: "sleep 60",
      status: "running",
      notifyPolicy: "silent",
      startedAt,
      progressSummary: `longtask ${JSON.stringify({
        phase: "long_running",
        pid: 2 ** 30,
        sessionId: "sess-mtime-lost",
        maxWaitMs: 1_800_000,
        deadlineAt: startedAt + 1_800_000,
        outputPath,
      })}`,
    });
    expect(task).toBeTruthy();
    const result = await reattachPersistedExecLongTasks({
      maxWaitMs: 5_000,
      blockEndTurn: true,
      retention: {
        succeededMs: 1_000,
        failedMs: 1_000,
        lostMs: 1_000,
        outputMs: 1_000,
      },
    });
    expect(result.lost).toBe(1);
    const stored = getTaskById(task!.taskId);
    expect(stored?.status).toBe("lost");
    const record = formatLongTaskQueryRecord(stored!);
    expect(record.elapsedMs).toBeGreaterThanOrEqual(16_000);
    expect(record.elapsedMs).toBeLessThan(25_000);
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("does not expose a stale in-progress phase on terminal tasks", () => {
    const record = formatLongTaskQueryRecord({
      taskId: "done-1",
      runtime: "exec",
      task: "sleep 180",
      status: "succeeded",
      createdAt: 1,
      startedAt: 1,
      endedAt: 181_000,
      sourceId: "mellow-ember",
      progressSummary:
        'longtask {"phase":"short_polling","shortPolls":4,"shortPollElapsedMs":40000,"sessionId":"mellow-ember","maxWaitMs":1800000,"deadlineAt":2}',
      terminalSummary: "exited after gateway reattach",
    } as never);
    expect(record.status).toBe("succeeded");
    expect(record.runtime).toBe("exec");
    expect(record.phase).toBeUndefined();
    expect(record.summary).toContain("exited after gateway reattach");
  });
});
