/**
 * Bulk kill of scoped in-progress exec sessions on agent Stop.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { supervisorMock } = vi.hoisted(() => ({
  supervisorMock: {
    spawn: vi.fn(),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  },
}));

const { killProcessTreeMock } = vi.hoisted(() => ({
  killProcessTreeMock: vi.fn(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisorMock,
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: (...args: unknown[]) => killProcessTreeMock(...args),
}));

let addSession: typeof import("./bash-process-registry.js").addSession;
let getFinishedSession: typeof import("./bash-process-registry.js").getFinishedSession;
let getSession: typeof import("./bash-process-registry.js").getSession;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.js").resetProcessRegistryForTests;
let createProcessSessionFixture: typeof import("./bash-process-registry.test-helpers.js").createProcessSessionFixture;
let killRunningExecSessionsForScopes: typeof import("./bash-process-kill.js").killRunningExecSessionsForScopes;
let forceStopSessionExecWork: typeof import("./bash-process-kill.js").forceStopSessionExecWork;
let registerLongTaskWaiterForTests: typeof import("./long-task-runtime.js").registerLongTaskWaiterForTests;
let resetLongTaskRuntimeForTests: typeof import("./long-task-runtime.js").resetLongTaskRuntimeForTests;

describe("killRunningExecSessionsForScopes", () => {
  beforeAll(async () => {
    ({ addSession, getFinishedSession, getSession, resetProcessRegistryForTests } =
      await import("./bash-process-registry.js"));
    ({ createProcessSessionFixture } = await import("./bash-process-registry.test-helpers.js"));
    ({ killRunningExecSessionsForScopes, forceStopSessionExecWork } =
      await import("./bash-process-kill.js"));
    ({ registerLongTaskWaiterForTests, resetLongTaskRuntimeForTests } =
      await import("./long-task-runtime.js"));
  });

  beforeEach(() => {
    supervisorMock.spawn.mockClear();
    supervisorMock.cancel.mockClear();
    supervisorMock.cancelScope.mockClear();
    supervisorMock.getRecord.mockClear();
    killProcessTreeMock.mockClear();
  });

  afterEach(() => {
    resetProcessRegistryForTests();
    resetLongTaskRuntimeForTests();
  });

  it("cancels managed foreground and backgrounded sessions for a scope", () => {
    supervisorMock.getRecord.mockReturnValue({ runId: "sess", state: "running" });

    const foreground = createProcessSessionFixture({
      id: "fg-1",
      command: "sleep 30",
      backgrounded: false,
      pid: 1001,
    });
    foreground.scopeKey = "agent:main:main";
    const backgrounded = createProcessSessionFixture({
      id: "bg-1",
      command: "sleep 600",
      backgrounded: true,
      pid: 1002,
    });
    backgrounded.scopeKey = "agent:main:main";
    const other = createProcessSessionFixture({
      id: "other-1",
      command: "sleep 600",
      backgrounded: true,
      pid: 1003,
    });
    other.scopeKey = "agent:other";
    addSession(foreground);
    addSession(backgrounded);
    addSession(other);

    const result = killRunningExecSessionsForScopes({
      scopeKeys: ["agent:main:main"],
    });

    expect(supervisorMock.cancelScope).toHaveBeenCalledWith("agent:main:main", "manual-cancel");
    expect(result.sessionIds).toEqual(expect.arrayContaining(["fg-1", "bg-1"]));
    expect(result.sessionIds).not.toContain("other-1");
    expect(supervisorMock.cancel).toHaveBeenCalledWith("fg-1", "manual-cancel");
    expect(supervisorMock.cancel).toHaveBeenCalledWith("bg-1", "manual-cancel");
    expect(supervisorMock.cancel).not.toHaveBeenCalledWith("other-1", "manual-cancel");
    expect(getSession("other-1")).toBeDefined();
  });

  it("falls back to process-tree kill when supervisor has no record", () => {
    supervisorMock.getRecord.mockReturnValue(undefined);
    const session = createProcessSessionFixture({
      id: "orphan",
      command: "sleep 999",
      backgrounded: true,
      pid: 4242,
    });
    session.scopeKey = "agent:main:chat";
    addSession(session);

    const result = killRunningExecSessionsForScopes({
      scopeKeys: ["agent:main:chat"],
    });

    expect(result).toEqual({ attempted: 1, sessionIds: ["orphan"] });
    expect(killProcessTreeMock).toHaveBeenCalledWith(4242);
    expect(getSession("orphan")).toBeUndefined();
    expect(getFinishedSession("orphan")?.status).toBe("failed");
  });

  it("matches sessions by sessionKey when scopeKey differs", () => {
    supervisorMock.getRecord.mockReturnValue({ runId: "sess", state: "running" });
    const session = createProcessSessionFixture({
      id: "notify-key",
      command: "sleep 10",
      backgrounded: true,
      pid: 55,
    });
    session.scopeKey = "sandbox-scope";
    session.sessionKey = "agent:main:telegram:1";
    addSession(session);

    const result = killRunningExecSessionsForScopes({
      scopeKeys: ["agent:main:telegram:1"],
    });

    expect(result.sessionIds).toEqual(["notify-key"]);
    expect(supervisorMock.cancel).toHaveBeenCalledWith("notify-key", "manual-cancel");
  });

  it("no-ops when scope keys are empty", () => {
    const session = createProcessSessionFixture({
      id: "keep",
      command: "sleep 10",
      backgrounded: true,
      pid: 9,
    });
    session.scopeKey = "agent:main:main";
    addSession(session);

    expect(killRunningExecSessionsForScopes({ scopeKeys: ["", "  ", undefined, null] })).toEqual({
      attempted: 0,
      sessionIds: [],
    });
    expect(supervisorMock.cancelScope).not.toHaveBeenCalled();
    expect(getSession("keep")).toBeDefined();
  });

  it("force-kills managed sessions that ignore supervisor cancel", () => {
    supervisorMock.getRecord.mockReturnValue({ runId: "sess", state: "running" });
    const session = createProcessSessionFixture({
      id: "trap-int",
      command: "sleep 999",
      backgrounded: true,
      pid: 7777,
    });
    session.scopeKey = "agent:main:main";
    addSession(session);

    const result = killRunningExecSessionsForScopes({
      scopeKeys: ["agent:main:main"],
      force: true,
    });

    expect(result.sessionIds).toEqual(["trap-int"]);
    expect(supervisorMock.cancel).toHaveBeenCalledWith("trap-int", "manual-cancel");
    expect(killProcessTreeMock).toHaveBeenCalledWith(7777, { force: true });
    expect(getSession("trap-int")).toBeUndefined();
    expect(getFinishedSession("trap-int")?.status).toBe("failed");
  });

  it("matches alias session keys when looseMatch is set", () => {
    supervisorMock.getRecord.mockReturnValue({ runId: "sess", state: "running" });
    const session = createProcessSessionFixture({
      id: "alias-sess",
      command: "sleep 10",
      backgrounded: true,
      pid: 88,
    });
    session.scopeKey = "agent:main:main";
    addSession(session);

    const result = killRunningExecSessionsForScopes({
      scopeKeys: ["main"],
      looseMatch: true,
    });

    expect(result.sessionIds).toEqual(["alias-sess"]);
    expect(supervisorMock.cancel).toHaveBeenCalledWith("alias-sess", "manual-cancel");
  });

  describe("forceStopSessionExecWork", () => {
    it("cancels long-task waiters and force-kills leftover exec", () => {
      supervisorMock.getRecord.mockReturnValue({ runId: "sess", state: "running" });
      const session = createProcessSessionFixture({
        id: "lt-exec",
        command: "sleep 600",
        backgrounded: true,
        pid: 4243,
      });
      session.scopeKey = "agent:main:main";
      addSession(session);
      const controller = registerLongTaskWaiterForTests({
        processSessionId: "lt-exec",
        sessionKey: "agent:main:main",
        pid: 4243,
      });

      const result = forceStopSessionExecWork({
        scopeKeys: ["main"],
        reason: "stop",
      });

      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe("stop");
      expect(result.cancelledLongTasks).toBe(1);
      expect(result.sessionIds).toEqual(["lt-exec"]);
      expect(result.attempted).toBeGreaterThan(0);
      expect(killProcessTreeMock).toHaveBeenCalledWith(4243, { force: true });
    });

    it("reports attempted when only a long-task waiter exists", () => {
      const controller = registerLongTaskWaiterForTests({
        processSessionId: "waiter-only",
        sessionKey: "agent:main:dingtalk:1",
      });

      const result = forceStopSessionExecWork({
        scopeKeys: ["agent:main:dingtalk:1"],
        reason: "stop",
      });

      expect(controller.signal.aborted).toBe(true);
      expect(result.cancelledLongTasks).toBe(1);
      expect(result.attempted).toBeGreaterThan(0);
    });
  });
});
