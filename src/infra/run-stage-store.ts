import { createHash } from "node:crypto";
/**
 * Server-side persistence for Control UI run-stage diagnosis cards.
 *
 * Stored under OPENCLAW_STATE_DIR (default ~/.openclaw/run-stage-cards/).
 * Not part of agent transcripts or model context.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type RunStageStoreEntry = {
  stage: string;
  label: string;
  startedAt: number;
  endedAt?: number | null;
  durationMs?: number | null;
  active: boolean;
};

export type RunStageThinkingSegment = {
  id: string;
  text: string;
  startedAt: number;
  endedAt?: number | null;
  durationMs?: number | null;
};

export type RunStageCardRecord = {
  id: string;
  sessionKey: string;
  runId: string | null;
  startedAt: number;
  endedAt: number | null;
  stages: RunStageStoreEntry[];
  thinkingText?: string | null;
  thinkingDurationMs?: number | null;
  thinkingSegments?: RunStageThinkingSegment[];
};

const MAX_CARDS_PER_SESSION = 40;

function resolveRunStageDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "run-stage-cards");
}

function sessionFileName(sessionKey: string): string {
  const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 24);
  return `${hash}.json`;
}

function sessionFilePath(sessionKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveRunStageDir(env), sessionFileName(sessionKey));
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
  cards: RunStageCardRecord[];
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
  const dir = resolveRunStageDir(env);
  ensureDir(dir);
  const filePath = sessionFilePath(file.sessionKey, env);
  const tmp = `${filePath}.${process.pid}.tmp`;
  const payload: SessionFile = {
    sessionKey: file.sessionKey,
    updatedAt: Date.now(),
    cards: file.cards.slice(-MAX_CARDS_PER_SESSION),
  };
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmp, filePath);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

/** List diagnosis cards for a session (newest last). */
export function listRunStageCardsForSession(
  sessionKey: string,
  env: NodeJS.ProcessEnv = process.env,
): RunStageCardRecord[] {
  const key = sessionKey.trim();
  if (!key) {
    return [];
  }
  return readSessionFile(key, env).cards.slice();
}

/** Upsert one card for a session. */
export function saveRunStageCardToStore(
  card: RunStageCardRecord,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const key = card.sessionKey.trim();
  if (!key) {
    return;
  }
  if (!card.stages?.length && !card.thinkingText?.trim() && !card.thinkingSegments?.length) {
    return;
  }
  const file = readSessionFile(key, env);
  const idx = file.cards.findIndex((c) => c.id === card.id);
  if (idx >= 0) {
    file.cards[idx] = card;
  } else {
    file.cards.push(card);
  }
  writeSessionFile(file, env);
}

/** Replace all cards for a session (used by UI bulk sync). */
export function replaceRunStageCardsForSession(
  sessionKey: string,
  cards: RunStageCardRecord[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  writeSessionFile(
    {
      sessionKey: key,
      updatedAt: Date.now(),
      cards: cards.slice(-MAX_CARDS_PER_SESSION),
    },
    env,
  );
}
