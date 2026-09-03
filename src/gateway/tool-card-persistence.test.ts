// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import { listToolCardsForSession } from "../infra/tool-card-store.js";
import { startToolCardPersistence } from "./tool-card-persistence.js";

describe("gateway tool-card persistence", () => {
  let stateDir: string;
  let stop: (() => void) | null = null;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-tool-cards-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    stop = startToolCardPersistence();
  });

  afterEach(() => {
    stop?.();
    stop = null;
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists exec input and output so refresh can restore both", () => {
    emitAgentEvent({
      runId: "run-1",
      stream: "tool",
      sessionKey: "main",
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "call-df",
        args: { command: "df -h" },
      },
    });
    emitAgentEvent({
      runId: "run-1",
      stream: "tool",
      sessionKey: "main",
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "call-df",
        meta: "df -h",
        result: "/dev/mapper 146G",
      },
    });

    const cards = listToolCardsForSession("main");
    const df = cards.find((card) => card.callId === "call-df");
    expect(df?.args).toEqual({ command: "df -h" });
    expect(df?.outputText).toContain("/dev/mapper");
    expect(df?.status).toBe("completed");
  });
});
