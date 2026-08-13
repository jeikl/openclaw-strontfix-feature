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

/** Merge two cards for the same id — never let a sparse late write erase stages. */
function mergeRunStageCardRecords(
  prev: RunStageCardRecord,
  next: RunStageCardRecord,
): RunStageCardRecord {
  const prevStages = Array.isArray(prev.stages) ? prev.stages : [];
  const nextStages = Array.isArray(next.stages) ? next.stages : [];
  // Prefer the longer stage list; if equal length, prefer the newer payload.
  const stages =
    nextStages.length > prevStages.length
      ? nextStages
      : nextStages.length < prevStages.length
        ? prevStages
        : nextStages.length > 0
          ? nextStages
          : prevStages;
  const prevSegs = Array.isArray(prev.thinkingSegments) ? prev.thinkingSegments : [];
  const nextSegs = Array.isArray(next.thinkingSegments) ? next.thinkingSegments : [];
  const thinkingSegments =
    nextSegs.length > prevSegs.length
      ? nextSegs
      : nextSegs.length < prevSegs.length
        ? prevSegs
        : nextSegs.length > 0
          ? nextSegs
          : prevSegs;
  const prevThink = prev.thinkingText?.trim() ?? "";
  const nextThink = next.thinkingText?.trim() ?? "";
  const thinkingText =
    nextThink.length >= prevThink.length
      ? (next.thinkingText ?? null)
      : (prev.thinkingText ?? null);
  return {
    ...prev,
    ...next,
    stages,
    thinkingSegments,
    thinkingText,
    thinkingDurationMs:
      next.thinkingDurationMs != null &&
      (prev.thinkingDurationMs == null || next.thinkingDurationMs >= prev.thinkingDurationMs)
        ? next.thinkingDurationMs
        : (prev.thinkingDurationMs ?? next.thinkingDurationMs ?? null),
    startedAt: Math.min(prev.startedAt || next.startedAt, next.startedAt || prev.startedAt),
    // Prefer an explicit end; do not clear a previous endedAt with null.
    endedAt: next.endedAt ?? prev.endedAt ?? null,
    runId: next.runId ?? prev.runId ?? null,
  };
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
    file.cards[idx] = mergeRunStageCardRecords(file.cards[idx]!, card);
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

/** Drop all diagnosis cards for a session (session reset / /clear). */
export function clearRunStageCardsForSession(
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
      // Best-effort cleanup; reset must not fail if the stage store is missing.
      try {
        writeSessionFile({ sessionKey: key, updatedAt: Date.now(), cards: [] }, env);
      } catch {
        // ignore
      }
    }
  }
}
