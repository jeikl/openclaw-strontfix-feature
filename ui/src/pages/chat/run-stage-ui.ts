/**
 * Control UI-only run stage timings.
 *
 * Persistence is browser localStorage keyed by sessionKey.
 * Never written into chat history, transcripts, or model context.
 */
import { html, nothing } from "lit";
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { ChatRunStageEntry } from "./tool-stream.ts";

const STORAGE_KEY = "openclaw.controlUi.runStageCards.v1";
const MAX_CARDS_PER_SESSION = 40;

/** One completed (or live) stage card for a single agent turn — UI display only. */
export type ChatRunStageCard = {
  id: string;
  sessionKey: string;
  runId: string | null;
  startedAt: number;
  endedAt: number | null;
  stages: ChatRunStageEntry[];
  /** Full thinking/reasoning text for this turn (WebUI only; not model context). */
  thinkingText?: string | null;
  /** Wall time for model thinking stage, if known. */
  thinkingDurationMs?: number | null;
};

type StoreShape = {
  bySession: Record<string, ChatRunStageCard[]>;
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
    // quota / private mode — ignore; live UI still works
  }
}

export function loadRunStageCardsForSession(sessionKey: string): ChatRunStageCard[] {
  const key = sessionKey.trim();
  if (!key) {
    return [];
  }
  const cards = readStore().bySession[key];
  return Array.isArray(cards) ? cards.slice() : [];
}

export function saveRunStageCard(card: ChatRunStageCard): void {
  const key = card.sessionKey.trim();
  if (!key || card.stages.length === 0) {
    return;
  }
  const store = readStore();
  const existing = Array.isArray(store.bySession[key]) ? store.bySession[key] : [];
  const idx = existing.findIndex((c) => c.id === card.id);
  const next = idx >= 0 ? existing.map((c, i) => (i === idx ? card : c)) : [...existing, card];
  store.bySession[key] = next.slice(-MAX_CARDS_PER_SESSION);
  writeStore(store);
}

export function createRunStageCardId(runId: string | null): string {
  return `stage-card:${runId?.trim() || "local"}:${Date.now()}`;
}

function formatStageSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0.0s";
  }
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${(ms / 1000).toFixed(0)}s`;
}

/** Pipeline stage list with wall-clock seconds (Control UI diagnosis only). */
export function renderRunStagePanel(
  stages: ChatRunStageEntry[] | null | undefined,
  options?: { nowMs?: number; title?: string; compact?: boolean },
) {
  if (!stages || stages.length === 0) {
    return nothing;
  }
  const nowMs = options?.nowMs ?? Date.now();
  const title = options?.title ?? "关键路径耗时";
  return html`
    <div
      class="agent-chat__run-stages ${options?.compact ? "agent-chat__run-stages--compact" : ""}"
      role="status"
      aria-live="polite"
      aria-label="Run stage timings"
      data-run-stages-panel="true"
    >
      <div class="agent-chat__run-stages-title">${title}</div>
      <ul class="agent-chat__run-stages-list">
        ${stages.map((stage) => {
          const elapsedMs = stage.active
            ? Math.max(0, nowMs - stage.startedAt)
            : (stage.durationMs ??
              (stage.endedAt != null ? Math.max(0, stage.endedAt - stage.startedAt) : 0));
          return html`
            <li
              class="agent-chat__run-stage ${stage.active
                ? "agent-chat__run-stage--active"
                : "agent-chat__run-stage--done"}"
            >
              <span class="agent-chat__run-stage-label">
                ${stage.active ? html`<span class="agent-chat__run-stage-dot"></span>` : nothing}
                ${stage.label}
              </span>
              <span class="agent-chat__run-stage-time">${formatStageSeconds(elapsedMs)}</span>
            </li>
          `;
        })}
      </ul>
    </div>
  `;
}

function resolveCardThinkingDurationMs(card: ChatRunStageCard, nowMs: number): number | null {
  if (card.thinkingDurationMs != null && Number.isFinite(card.thinkingDurationMs)) {
    return card.thinkingDurationMs;
  }
  const thinking = card.stages.find((s) => s.stage === "thinking");
  if (!thinking) {
    return null;
  }
  if (thinking.durationMs != null && Number.isFinite(thinking.durationMs)) {
    return thinking.durationMs;
  }
  if (thinking.active) {
    return Math.max(0, nowMs - thinking.startedAt);
  }
  return null;
}

/** Render a persisted or live stage card above an assistant turn (incl. thinking). */
export function renderRunStageCard(
  card: ChatRunStageCard,
  options?: {
    nowMs?: number;
    live?: boolean;
    thinkingText?: string | null;
    thinkingStreaming?: boolean;
  },
) {
  const thinkingText = (options?.thinkingText ?? card.thinkingText ?? "").trim();
  if (!card.stages.length && !thinkingText) {
    return nothing;
  }
  const live = options?.live === true || card.stages.some((s) => s.active);
  const nowMs = options?.nowMs ?? Date.now();
  const thinkingStreaming = options?.thinkingStreaming === true;
  const thinkingMs = resolveCardThinkingDurationMs(
    {
      ...card,
      thinkingText,
    },
    nowMs,
  );
  const durationLabel =
    thinkingMs == null
      ? null
      : thinkingMs < 10_000
        ? `${(thinkingMs / 1000).toFixed(1)}s`
        : `${Math.round(thinkingMs / 1000)}s`;
  return html`
    <div
      class="chat-run-stage-card ${live ? "chat-run-stage-card--live" : ""}"
      data-stage-card-id=${card.id}
    >
      ${card.stages.length
        ? renderRunStagePanel(card.stages, {
            nowMs,
            title: live ? "关键路径耗时" : "关键路径耗时（本轮）",
          })
        : nothing}
      ${thinkingText
        ? html`<div class="chat-run-stage-card__thinking">
            <details class="chat-thinking-panel" ?open=${thinkingStreaming}>
              <summary class="chat-thinking-panel__summary">
                <span class="chat-thinking-panel__title">
                  <span class="chat-thinking-panel__icon" aria-hidden="true">◎</span>
                  思考过程
                  ${thinkingStreaming
                    ? html`<span class="chat-thinking-panel__live" aria-label="streaming">…</span>`
                    : nothing}
                  ${durationLabel
                    ? html`<span class="chat-thinking-panel__duration">${durationLabel}</span>`
                    : nothing}
                </span>
                <span class="chat-thinking-panel__source">WebUI 仅展示</span>
              </summary>
              <div class="chat-thinking-panel__body">
                <pre class="chat-thinking-panel__text">${thinkingText}</pre>
              </div>
            </details>
          </div>`
        : nothing}
    </div>
  `;
}
