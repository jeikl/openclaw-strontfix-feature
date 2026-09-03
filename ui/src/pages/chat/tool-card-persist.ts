/**
 * Hydrate Control UI tool cards from the gateway disk store
 * (~/.openclaw/tool-cards/), same idea as run-stage cards.
 * localStorage is a soft cache for refresh/offline. Never model context.
 */
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolUseId,
} from "../../../../src/chat/tool-content.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { extractToolCards } from "../../lib/chat/tool-cards.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const STORAGE_KEY = "openclaw.controlUi.toolCards.v1";
const MAX_CARDS_PER_SESSION = 80;

export type HydratedToolCard = {
  id: string;
  sessionKey: string;
  runId: string | null;
  callId: string;
  name: string;
  args?: unknown;
  inputText?: string;
  outputText?: string;
  isError?: boolean;
  startedAt: number;
  endedAt?: number | null;
  status?: "running" | "completed" | "error";
};

const HISTORY_OMISSION_MARKERS = [
  "[chat.history omitted: message too large]",
  "[openclaw] missing tool result",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function collectCallIds(message: unknown): string[] {
  const rec = asRecord(message);
  if (!rec) {
    return [];
  }
  const ids = new Set<string>();
  const top =
    (typeof rec.toolCallId === "string" && rec.toolCallId.trim()) ||
    (typeof rec.tool_call_id === "string" && rec.tool_call_id.trim()) ||
    "";
  if (top) {
    ids.add(top);
  }
  for (const card of extractToolCards(message, "hydrate")) {
    if (card.callId) {
      ids.add(card.callId);
    }
  }
  return [...ids];
}

function isWeakOutput(text: string | undefined): boolean {
  if (!text?.trim()) {
    return true;
  }
  return HISTORY_OMISSION_MARKERS.some((marker) => text.includes(marker));
}

function mergeCardIntoMessage(message: unknown, card: HydratedToolCard): unknown {
  const rec = asRecord(message);
  if (!rec) {
    return message;
  }
  const rawContent = Array.isArray(rec.content)
    ? [...rec.content]
    : typeof rec.content === "string"
      ? [{ type: "text", text: rec.content }]
      : [];
  let changed = false;
  const nextContent = rawContent.map((block) => {
    const typed = asRecord(block);
    if (!typed) {
      return block;
    }
    if (isToolCallContentType(typed.type)) {
      const id = resolveToolUseId(typed) || card.callId;
      if (id !== card.callId) {
        return block;
      }
      const hasArgs = typed.arguments != null || typed.args != null || typed.input != null;
      if (hasArgs || card.args === undefined) {
        return block;
      }
      changed = true;
      return { ...typed, id: typed.id ?? card.callId, arguments: card.args };
    }
    if (isToolResultContentType(typed.type)) {
      const id = resolveToolUseId(typed) || card.callId;
      if (id !== card.callId) {
        return block;
      }
      const text =
        typeof typed.text === "string"
          ? typed.text
          : typeof typed.content === "string"
            ? typed.content
            : "";
      if (!isWeakOutput(text) || !card.outputText?.trim()) {
        return block;
      }
      changed = true;
      return {
        ...typed,
        id: typed.id ?? card.callId,
        name: typed.name ?? card.name,
        text: card.outputText,
        ...(card.isError ? { isError: true } : {}),
      };
    }
    return block;
  });
  const hasCall = nextContent.some((block) => {
    const typed = asRecord(block);
    return Boolean(
      typed && isToolCallContentType(typed.type) && resolveToolUseId(typed) === card.callId,
    );
  });
  if (!hasCall && card.args !== undefined) {
    nextContent.unshift({
      type: "toolcall",
      id: card.callId,
      name: card.name,
      arguments: card.args,
    });
    changed = true;
  }
  const hasResult = nextContent.some((block) => {
    const typed = asRecord(block);
    return Boolean(
      typed && isToolResultContentType(typed.type) && resolveToolUseId(typed) === card.callId,
    );
  });
  if (!hasResult && card.outputText?.trim()) {
    nextContent.push({
      type: "tool_result",
      id: card.callId,
      name: card.name,
      text: card.outputText,
      ...(card.isError ? { isError: true } : {}),
    });
    changed = true;
  }
  if (!changed) {
    return message;
  }
  return {
    ...rec,
    content: nextContent,
    ...(typeof rec.toolCallId === "string" ? {} : { toolCallId: card.callId }),
    ...(typeof rec.toolName === "string" ? {} : { toolName: card.name }),
  };
}

export function applyPersistedToolCardsToMessages(
  messages: unknown[],
  cards: HydratedToolCard[],
): unknown[] {
  if (!Array.isArray(messages) || cards.length === 0) {
    return messages;
  }
  const byCallId = new Map<string, HydratedToolCard>();
  for (const card of cards) {
    if (card.callId) {
      byCallId.set(card.callId, card);
    }
  }
  const used = new Set<string>();
  const next = messages.map((message) => {
    let current = message;
    for (const callId of collectCallIds(message)) {
      const card = byCallId.get(callId);
      if (!card) {
        continue;
      }
      used.add(callId);
      current = mergeCardIntoMessage(current, card);
    }
    return current;
  });
  for (const card of cards) {
    if (used.has(card.callId) || (!card.args && !card.outputText?.trim())) {
      continue;
    }
    next.push(
      mergeCardIntoMessage(
        {
          role: "toolResult",
          toolCallId: card.callId,
          toolName: card.name,
          timestamp: card.endedAt ?? card.startedAt,
          content: [],
        },
        card,
      ),
    );
  }
  return next;
}

type StoreShape = {
  bySession: Record<string, HydratedToolCard[]>;
};

function readStore(): StoreShape {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return { bySession: {} };
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return { bySession: {} };
    }
    const parsed = JSON.parse(raw) as StoreShape;
    if (!parsed || typeof parsed !== "object" || !parsed.bySession) {
      return { bySession: {} };
    }
    return { bySession: parsed.bySession };
  } catch {
    return { bySession: {} };
  }
}

function writeStore(store: StoreShape): void {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // quota / private mode
  }
}

export function loadToolCardsForSession(sessionKey: string): HydratedToolCard[] {
  const key = sessionKey.trim();
  if (!key) {
    return [];
  }
  const cards = readStore().bySession[key];
  return Array.isArray(cards) ? cards.slice() : [];
}

function cacheToolCardsForSession(sessionKey: string, cards: HydratedToolCard[]): void {
  const store = readStore();
  store.bySession[sessionKey] = cards.slice(-MAX_CARDS_PER_SESSION);
  writeStore(store);
}

/** Remove local tool-card cache for a session (/clear and remote reset). */
export function clearToolCardsForSession(sessionKey: string): void {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  const store = readStore();
  if (store.bySession[key]) {
    delete store.bySession[key];
    writeStore(store);
  }
}

export async function loadToolCardsFromGateway(
  client: GatewayBrowserClient | null | undefined,
  sessionKey: string,
): Promise<HydratedToolCard[]> {
  const key = sessionKey.trim();
  if (!key) {
    return [];
  }
  if (!client) {
    return loadToolCardsForSession(key);
  }
  try {
    const result = await client.request<{ sessionKey?: string; cards?: HydratedToolCard[] }>(
      "sessions.toolCards.get",
      { sessionKey: key, key },
    );
    const cards = Array.isArray(result?.cards) ? result.cards : [];
    if (cards.length > 0) {
      cacheToolCardsForSession(key, cards);
    }
    return cards;
  } catch {
    return loadToolCardsForSession(key);
  }
}
