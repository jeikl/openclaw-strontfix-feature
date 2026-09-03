import { createHash } from "node:crypto";
/**
 * Server-side persistence for Control UI tool cards (input + output).
 *
 * Stored under OPENCLAW_STATE_DIR (default ~/.openclaw/tool-cards/).
 * Not part of agent transcripts or model context.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type PersistedToolCardStatus = "running" | "completed" | "error";

export type PersistedToolCard = {
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
  status?: PersistedToolCardStatus;
};

const MAX_CARDS_PER_SESSION = 80;
const MAX_OUTPUT_CHARS = 120_000;

function resolveToolCardDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "tool-cards");
}

function sessionFileName(sessionKey: string): string {
  const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 24);
  return `${hash}.json`;
}

function sessionFilePath(sessionKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveToolCardDir(env), sessionFileName(sessionKey));
}

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // ignore
  }
}

type SessionFile = {
  sessionKey: string;
  updatedAt: number;
  cards: PersistedToolCard[];
};

function readSessionFile(sessionKey: string, env: NodeJS.ProcessEnv = process.env): SessionFile {
  const filePath = sessionFilePath(sessionKey, env);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as SessionFile;
    if (!parsed || !Array.isArray(parsed.cards)) {
      return { sessionKey, updatedAt: 0, cards: [] };
    }
    return {
      sessionKey: parsed.sessionKey || sessionKey,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      cards: parsed.cards,
    };
  } catch {
    return { sessionKey, updatedAt: 0, cards: [] };
  }
}

function writeSessionFile(file: SessionFile, env: NodeJS.ProcessEnv = process.env): void {
  const dir = resolveToolCardDir(env);
  ensureDir(dir);
  const filePath = sessionFilePath(file.sessionKey, env);
  const tmp = `${filePath}.${process.pid}.tmp`;
  const payload: SessionFile = {
    sessionKey: file.sessionKey,
    updatedAt: Date.now(),
    cards: file.cards.slice(-MAX_CARDS_PER_SESSION),
  };
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

function clipOutput(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.length <= MAX_OUTPUT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n\n… truncated (${value.length} chars).`;
}

function hasRenderableArgs(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value as object).length > 0;
  }
  return true;
}

function mergePersistedToolCards(
  prev: PersistedToolCard,
  next: PersistedToolCard,
): PersistedToolCard {
  const nextOutput = clipOutput(next.outputText);
  const prevOutput = prev.outputText;
  const outputText =
    nextOutput && (!prevOutput || nextOutput.length >= prevOutput.length) ? nextOutput : prevOutput;
  const args = hasRenderableArgs(next.args) ? next.args : prev.args;
  return {
    ...prev,
    ...next,
    args,
    inputText: next.inputText?.trim() ? next.inputText : prev.inputText,
    outputText,
    isError: next.isError ?? prev.isError,
    startedAt: Math.min(prev.startedAt || next.startedAt, next.startedAt || prev.startedAt),
    endedAt: next.endedAt ?? prev.endedAt ?? null,
    runId: next.runId ?? prev.runId ?? null,
    status: next.status ?? prev.status,
  };
}

export function listToolCardsForSession(
  sessionKey: string,
  env: NodeJS.ProcessEnv = process.env,
): PersistedToolCard[] {
  const key = sessionKey.trim();
  if (!key) {
    return [];
  }
  return readSessionFile(key, env).cards.slice();
}

export function saveToolCardToStore(
  card: PersistedToolCard,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const key = card.sessionKey.trim();
  const callId = card.callId.trim();
  if (!key || !callId) {
    return;
  }
  const normalized: PersistedToolCard = {
    ...card,
    sessionKey: key,
    callId,
    id: card.id || `tool:${callId}`,
    outputText: clipOutput(card.outputText),
  };
  if (
    !hasRenderableArgs(normalized.args) &&
    !normalized.inputText?.trim() &&
    !normalized.outputText?.trim()
  ) {
    return;
  }
  const file = readSessionFile(key, env);
  const idx = file.cards.findIndex(
    (entry) => entry.callId === callId || entry.id === normalized.id,
  );
  if (idx >= 0) {
    file.cards[idx] = mergePersistedToolCards(file.cards[idx]!, normalized);
  } else {
    file.cards.push(normalized);
  }
  writeSessionFile(file, env);
}

export function clearToolCardsForSession(
  sessionKey: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  const filePath = sessionFilePath(key, env);
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      try {
        writeSessionFile({ sessionKey: key, updatedAt: Date.now(), cards: [] }, env);
      } catch {
        // ignore
      }
    }
  }
}
