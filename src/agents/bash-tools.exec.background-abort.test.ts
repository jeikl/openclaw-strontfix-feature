/**
 * Exec background abort tests.
 * Wait and process lifetime are owned by tools.longTask.maxWaitMs.
 * Model timeout/yieldMs and tool-call abort must not kill a parked exec.
 */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { resetLongTaskRuntimeForTests } from "./long-task-runtime.js";

const supervisorMockState = vi.hoisted(() => ({
  cancelReasons: [] as Array<"manual-cancel" | "overall-timeout">,
  spawnInputs: [] as Array<{ timeoutMs?: number }>,
}));

vi.mock("../process/supervisor/index.js", () => {
  let counter = 0;
  return {
    getProcessSupervisor: () => ({
      spawn: async (input: { timeoutMs?: number }) => {
        supervisorMockState.spawnInputs.push(input);
        const runId = `mock-run-${++counter}`;
        let settled = false;
        let settle = (_reason: "manual-cancel" | "overall-timeout", _timedOut: boolean) => {};
        const waitPromise = new Promise<{
          reason: "manual-cancel" | "overall-timeout";
          exitCode: number | null;
          exitSignal: NodeJS.Signals | number | null;
          durationMs: number;
          stdout: string;
          stderr: string;
          timedOut: boolean;
          noOutputTimedOut: boolean;
        }>((resolve) => {
          settle = (reason, timedOut) => {
            if (settled) {
              return;
            }
            settled = true;
            resolve({
              reason,
              exitCode: null,
              exitSignal: null,
              durationMs: input.timeoutMs ?? 0,
              stdout: "",
              stderr: "",
              timedOut,
              noOutputTimedOut: false,
            });
          };
          if (input.timeoutMs !== undefined) {
            setTimeout(() => settle("overall-timeout", true), Math.max(50, input.timeoutMs));
          }
        });
        return {
          runId,
          startedAtMs: Date.now(),
          stdin: undefined,
          wait: () => waitPromise,
          cancel: () => {
            supervisorMockState.cancelReasons.push("manual-cancel");
            settle("manual-cancel", false);
          },
        };
      },
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      getRecord: vi.fn(),
    }),
  };
});

vi.mock("../infra/shell-env.js", () => ({
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
}));

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: vi.fn(async () => ({})),
}));

vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: vi.fn(async () => {
    throw new Error("node host not expected in background abort tests");
  }),
}));

const BACKGROUND_HOLD_CMD =
  process.platform === "win32" ? 'node -e "setTimeout(() => {}, 1000)"' : "exec sleep 1";
const ABORT_SETTLE_MS = process.platform === "win32" ? 200 : 0;
const POLL_INTERVAL_MS = process.platform === "win32" ? 15 : 5;
const FINISHED_WAIT_TIMEOUT_MS = process.platform === "win32" ? 8_000 : 1_000;
const BACKGROUND_TIMEOUT_SEC = process.platform === "win32" ? 0.2 : 0.02;
const YIELDED_BACKGROUND_TIMEOUT_SEC = process.platform === "win32" ? 0.4 : 0.2;
const TEST_EXEC_DEFAULTS = {
  host: "gateway" as const,
  security: "full" as const,
  ask: "off" as const,
};

let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.js").resetProcessRegistryForTests;
type ExecToolExecuteParams = Parameters<ReturnType<typeof createExecTool>["execute"]>[1];

const createTestExecTool = (
  defaults?: Parameters<typeof createExecTool>[0],
): ReturnType<typeof createExecTool> => createExecTool({ ...TEST_EXEC_DEFAULTS, ...defaults });

beforeAll(async () => {
  ({ createExecTool } = await import("./bash-tools.exec.js"));
  ({ resetProcessRegistryForTests } = await import("./bash-process-registry.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  supervisorMockState.cancelReasons.length = 0;
  supervisorMockState.spawnInputs.length = 0;
});

afterEach(() => {
  resetProcessRegistryForTests();
  resetLongTaskRuntimeForTests();
});

async function expectBackgroundSessionIgnoresToolAbort(params: {
  tool: ReturnType<typeof createExecTool>;
  executeParams: ExecToolExecuteParams;
}) {
  const abortController = new AbortController();
  const pending = params.tool.execute("toolcall", params.executeParams, abortController.signal);
  await expect
    .poll(() => supervisorMockState.spawnInputs.length > 0, {
      timeout: FINISHED_WAIT_TIMEOUT_MS,
      interval: POLL_INTERVAL_MS,
    })
    .toBe(true);
  abortController.abort();
  if (ABORT_SETTLE_MS > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, ABORT_SETTLE_MS);
    });
  }
  expect(supervisorMockState.cancelReasons).toEqual([]);
  pending.catch(() => {});
}

async function expectBackgroundSessionTimesOut(params: {
  tool: ReturnType<typeof createExecTool>;
  executeParams: ExecToolExecuteParams;
  signal?: AbortSignal;
  abortAfterStart?: boolean;
  expectedTimeoutSec?: number;
}) {
  const abortController = new AbortController();
  const signal = params.signal ?? abortController.signal;
  const pending = params.tool.execute("toolcall", params.executeParams, signal);
  await expect
    .poll(() => supervisorMockState.spawnInputs.length > 0, {
      timeout: FINISHED_WAIT_TIMEOUT_MS,
      interval: POLL_INTERVAL_MS,
    })
    .toBe(true);
  if (typeof params.expectedTimeoutSec === "number") {
    expect(supervisorMockState.spawnInputs.at(-1)?.timeoutMs).toBe(
      Math.floor(params.expectedTimeoutSec * 1000),
    );
  }

  if (params.abortAfterStart) {
    abortController.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    return;
  }

  const result = await pending;
  expect(result.details.status === "failed" || result.details.timedOut === true).toBe(true);
}

test("parked exec is not cancelled when tool signal aborts", async () => {
  const tool = createTestExecTool({
    allowBackground: true,
    backgroundMs: 0,
    config: { tools: { longTask: { maxWaitMs: 1_000 } } },
  });
  await expectBackgroundSessionIgnoresToolAbort({
    tool,
    executeParams: { command: BACKGROUND_HOLD_CMD, background: true },
  });
});

test("pty parked exec is not cancelled when tool signal aborts", async () => {
  const tool = createTestExecTool({
    allowBackground: true,
    backgroundMs: 0,
    config: { tools: { longTask: { maxWaitMs: 1_000 } } },
  });
  await expectBackgroundSessionIgnoresToolAbort({
    tool,
    executeParams: { command: BACKGROUND_HOLD_CMD, background: true, pty: true },
  });
});

test("model timeout is ignored; process lifetime follows maxWaitMs", async () => {
  const tool = createTestExecTool({
    allowBackground: true,
    backgroundMs: 0,
    config: { tools: { longTask: { maxWaitMs: 2_000 } } },
  });
  await expectBackgroundSessionTimesOut({
    tool,
    executeParams: {
      command: BACKGROUND_HOLD_CMD,
      background: true,
      timeout: BACKGROUND_TIMEOUT_SEC,
    },
    expectedTimeoutSec: 2,
  });
});

test("model timeout zero does not disable the configured long-task timeout", async () => {
  const tool = createTestExecTool({
    allowBackground: true,
    backgroundMs: 0,
    config: { tools: { longTask: { maxWaitMs: 3_000 } } },
  });
  const abortController = new AbortController();
  const pending = tool.execute(
    "toolcall",
    {
      command: BACKGROUND_HOLD_CMD,
      background: true,
      timeout: 0,
    },
    abortController.signal,
  );
  await expect
    .poll(() => supervisorMockState.spawnInputs.length > 0, {
      timeout: FINISHED_WAIT_TIMEOUT_MS,
      interval: POLL_INTERVAL_MS,
    })
    .toBe(true);
  expect(supervisorMockState.spawnInputs.at(-1)?.timeoutMs).toBe(3_000);
  abortController.abort();
  pending.catch(() => {});
});

test("model yieldMs is ignored; process lifetime follows maxWaitMs", async () => {
  const tool = createTestExecTool({
    allowBackground: true,
    backgroundMs: 10,
    config: { tools: { longTask: { maxWaitMs: 4_000 } } },
  });
  await expectBackgroundSessionTimesOut({
    tool,
    executeParams: {
      command: BACKGROUND_HOLD_CMD,
      yieldMs: 5,
      timeout: YIELDED_BACKGROUND_TIMEOUT_SEC,
    },
    expectedTimeoutSec: 4,
  });
});
