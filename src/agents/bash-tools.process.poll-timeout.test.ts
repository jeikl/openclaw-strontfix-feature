/**
 * process poll is removed: exec waits internally; inspect via tasks_status.
 */
import { afterEach, expect, test } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { addSession, resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";
import { processSchema } from "./bash-tools.schemas.js";
import { resetLongTaskRuntimeForTests } from "./long-task-runtime.js";

afterEach(() => {
  resetProcessRegistryForTests();
  resetLongTaskRuntimeForTests();
  resetDiagnosticSessionStateForTest();
});

test("process poll is rejected in favor of tasks_status", async () => {
  const processTool = createProcessTool();
  addSession(
    createProcessSessionFixture({
      id: "sess-poll",
      command: "test",
      backgrounded: true,
    }),
  );
  const result = await processTool.execute("toolcall-poll", {
    action: "poll",
    sessionId: "sess-poll",
  } as never);
  expect(result.details).toMatchObject({ status: "failed" });
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("process poll is removed"),
  });
});

test("process schema no longer advertises poll as a wait action", () => {
  const action = (processSchema.properties as { action?: { description?: string } }).action
    ?.description;
  expect(action).toContain("list");
  expect(action).not.toMatch(/\bpoll\b/);
});
