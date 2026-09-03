import { describe, expect, it } from "vitest";
import { extractToolCards } from "../../lib/chat/tool-cards.ts";
import {
  applyPersistedToolCardsToMessages,
  clearToolCardsForSession,
  loadToolCardsForSession,
  loadToolCardsFromGateway,
} from "./tool-card-persist.ts";

describe("applyPersistedToolCardsToMessages", () => {
  it("restores omitted history output onto the matching tool call", () => {
    const messages = applyPersistedToolCardsToMessages(
      [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-df", name: "exec", input: { command: "df -h" } }],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call-df",
          toolName: "exec",
          content: "[chat.history omitted: message too large]",
          timestamp: 2,
        },
      ],
      [
        {
          id: "tool:call-df",
          sessionKey: "main",
          runId: "run-1",
          callId: "call-df",
          name: "exec",
          args: { command: "df -h" },
          outputText: "/dev/mapper 146G",
          startedAt: 1,
          endedAt: 2,
          status: "completed",
        },
      ],
    );

    const cards = messages.flatMap((message) => extractToolCards(message, "hist"));
    const df = cards.find((card) => card.callId === "call-df");
    expect(df?.inputText).toContain("df -h");
    expect(df?.outputText).toContain("/dev/mapper");
  });

  it("soft-caches gateway tool cards in localStorage and falls back on RPC failure", async () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
      clear: () => memory.clear(),
      key: (index: number) => [...memory.keys()][index] ?? null,
      get length() {
        return memory.size;
      },
    } satisfies Storage;
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

    const card = {
      id: "tool:call-uname",
      sessionKey: "main",
      runId: "run-1",
      callId: "call-uname",
      name: "exec",
      args: { command: "uname -a" },
      outputText: "Linux",
      startedAt: 1,
      endedAt: 2,
      status: "completed" as const,
    };
    const client = {
      request: async () => ({ cards: [card] }),
    };
    await loadToolCardsFromGateway(client as never, "main");
    expect(loadToolCardsForSession("main")[0]?.outputText).toBe("Linux");

    const failing = {
      request: async () => {
        throw new Error("offline");
      },
    };
    const fallback = await loadToolCardsFromGateway(failing as never, "main");
    expect(fallback[0]?.callId).toBe("call-uname");

    clearToolCardsForSession("main");
    expect(loadToolCardsForSession("main")).toEqual([]);
  });
});
