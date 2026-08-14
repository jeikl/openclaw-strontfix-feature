import { afterEach, describe, expect, it } from "vitest";
import { isAbortError } from "../infra/abort-signal.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-runtime.js";
import {
  cancelLongTasksForSession,
  formatFoldedLongTaskText,
  hasActiveLongTaskForSession,
  isProcessSessionLongTaskManaged,
  listLongTaskWaitersForTests,
  resetLongTaskRuntimeForTests,
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
});

describe("long-task supervisor", () => {
  it("returns a folded success during short polling without extra model calls", async () => {
    const result = await runLongTaskSupervisor({
      processSessionId: "sess-fast",
      command: "echo hello",
      exitPromise: Promise.resolve(completedOutcome()),
      kill: () => {},
      config: {
        shortPolls: 4,
        shortPollTimeoutMs: 50,
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
    expect(result.phase).toBe("short_polling");
    expect(result.shortPolls).toBe(1);
    expect(formatFoldedLongTaskText(result)).toContain("status: succeeded");
    expect(hasActiveLongTaskForSession("agent:main:test")).toBe(false);
  });

  it("parks in long_running after short polls then folds the terminal result", async () => {
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
        shortPolls: 2,
        shortPollTimeoutMs: 20,
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
    expect(result.shortPolls).toBe(2);
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
        shortPolls: 4,
        shortPollTimeoutMs: 200,
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

  it("times out after maxWaitMs and kills the process", async () => {
    const exitPromise = new Promise<ExecProcessOutcome>(() => {});
    const killed: string[] = [];
    const result = await runLongTaskSupervisor({
      processSessionId: "sess-timeout",
      command: "sleep 30",
      exitPromise,
      kill: () => killed.push("killed"),
      config: {
        shortPolls: 1,
        shortPollTimeoutMs: 20,
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
