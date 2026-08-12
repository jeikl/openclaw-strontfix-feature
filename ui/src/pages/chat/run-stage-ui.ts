/**
 * Control UI-only run stage timings + thinking segments.
 *
 * Primary persistence: gateway disk store (~/.openclaw/run-stage-cards/) so
 * remote browsers see the same diagnosis cards. localStorage is a soft cache.
 * Never written into chat history, transcripts, or model context.
 */
import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { ChatRunStageEntry } from "./tool-stream.ts";

const STORAGE_KEY = "openclaw.controlUi.runStageCards.v2";
const MAX_CARDS_PER_SESSION = 40;

/** One thinking burst within a multi-round turn (WebUI only). */
export type ChatThinkingSegment = {
  id: string;
  text: string;
  startedAt: number;
  endedAt?: number | null;
  durationMs?: number | null;
};

/** One completed (or live) stage card for a single agent turn — UI display only. */
export type ChatRunStageCard = {
  id: string;
  sessionKey: string;
  runId: string | null;
  startedAt: number;
  endedAt: number | null;
  stages: ChatRunStageEntry[];
  /** @deprecated prefer thinkingSegments; kept for older localStorage rows */
  thinkingText?: string | null;
  thinkingDurationMs?: number | null;
  /** Multi-round thinking bursts for this turn */
  thinkingSegments?: ChatThinkingSegment[];
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
    // Prefer v2; fall back to v1 once for migration.
    const raw =
      storage.getItem(STORAGE_KEY) ?? storage.getItem("openclaw.controlUi.runStageCards.v1");
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

export function loadRunStageCardsForSession(sessionKey: string): ChatRunStageCard[] {
  const key = sessionKey.trim();
  if (!key) {
    return [];
  }
  const cards = readStore().bySession[key];
  return Array.isArray(cards) ? cards.map(normalizeCard).slice() : [];
}

/** Load diagnosis cards from gateway (shared across remote browsers). */
export async function loadRunStageCardsFromGateway(
  client: GatewayBrowserClient | null | undefined,
  sessionKey: string,
): Promise<ChatRunStageCard[]> {
  const key = sessionKey.trim();
  if (!client || !key) {
    return loadRunStageCardsForSession(key);
  }
  try {
    const result = await client.request<{ sessionKey?: string; cards?: ChatRunStageCard[] }>(
      "sessions.runStages.get",
      { sessionKey: key, key },
    );
    const cards = Array.isArray(result?.cards) ? result.cards.map(normalizeCard) : [];
    // Soft-cache for offline refresh
    if (cards.length > 0) {
      const store = readStore();
      store.bySession[key] = cards.slice(-MAX_CARDS_PER_SESSION);
      writeStore(store);
    }
    return cards;
  } catch {
    return loadRunStageCardsForSession(key);
  }
}

/** Best-effort push of one card to the gateway store. */
export async function putRunStageCardToGateway(
  client: GatewayBrowserClient | null | undefined,
  card: ChatRunStageCard,
): Promise<void> {
  if (!client || !card.sessionKey.trim()) {
    return;
  }
  try {
    await client.request("sessions.runStages.put", {
      sessionKey: card.sessionKey,
      key: card.sessionKey,
      card,
    });
  } catch {
    // ignore — server auto-persist is the primary path
  }
}

function normalizeCard(card: ChatRunStageCard): ChatRunStageCard {
  if (card.thinkingSegments?.length) {
    return card;
  }
  const text = card.thinkingText?.trim();
  if (!text) {
    return card;
  }
  return {
    ...card,
    thinkingSegments: [
      {
        id: `${card.id}:think0`,
        text,
        startedAt: card.startedAt,
        endedAt: card.endedAt,
        durationMs: card.thinkingDurationMs ?? null,
      },
    ],
  };
}

export function saveRunStageCard(card: ChatRunStageCard): void {
  const key = card.sessionKey.trim();
  const normalized = normalizeCard(card);
  if (!key || (normalized.stages.length === 0 && !normalized.thinkingSegments?.length)) {
    return;
  }
  const store = readStore();
  const existing = Array.isArray(store.bySession[key]) ? store.bySession[key] : [];
  const idx = existing.findIndex((c) => c.id === normalized.id);
  const next =
    idx >= 0 ? existing.map((c, i) => (i === idx ? normalized : c)) : [...existing, normalized];
  store.bySession[key] = next.slice(-MAX_CARDS_PER_SESSION);
  writeStore(store);
}

/** localStorage cache + optional gateway write (remote browsers share server store). */
export function saveRunStageCardEverywhere(
  card: ChatRunStageCard,
  client?: GatewayBrowserClient | null,
): void {
  saveRunStageCard(card);
  void putRunStageCardToGateway(client, card);
}

export function createRunStageCardId(runId: string | null): string {
  return `stage-card:${runId?.trim() || "local"}:${Date.now()}`;
}

export function createThinkingSegmentId(cardId: string, index: number): string {
  return `${cardId}:think:${index}`;
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

/** Visual tone for multi-round timeline rows. */
export type StageTone = "prep" | "wait" | "think" | "tool" | "reply";

export function resolveStageTone(stage: string): StageTone {
  const id = stage.trim().toLowerCase();
  if (id === "thinking") {
    return "think";
  }
  if (id === "tool") {
    return "tool";
  }
  if (id === "reply") {
    return "reply";
  }
  if (id === "model_first") {
    return "wait";
  }
  return "prep";
}

/** Pipeline stage list with wall-clock seconds (Control UI diagnosis only). */
export function renderRunStagePanel(
  stages: ChatRunStageEntry[] | null | undefined,
  options?: {
    nowMs?: number;
    title?: string;
    /** When true, stages list starts expanded. Default: live turns expand. */
    open?: boolean;
  },
) {
  if (!stages || stages.length === 0) {
    return nothing;
  }
  const nowMs = options?.nowMs ?? Date.now();
  const title = options?.title ?? "关键路径耗时";
  const open = options?.open !== false;
  const totalMs = stages.reduce((sum, stage) => {
    const elapsed = stage.active
      ? Math.max(0, nowMs - stage.startedAt)
      : (stage.durationMs ??
        (stage.endedAt != null ? Math.max(0, stage.endedAt - stage.startedAt) : 0));
    return sum + elapsed;
  }, 0);

  return html`
    <details class="agent-chat__run-stages" ?open=${open} data-run-stages-panel="true">
      <summary class="agent-chat__run-stages-summary">
        <span class="agent-chat__run-stages-title">
          <span class="agent-chat__run-stages-chevron" aria-hidden="true">▸</span>
          ${title}
          <span class="agent-chat__run-stages-count">${stages.length} 步</span>
          <span class="agent-chat__run-stages-total">${formatStageSeconds(totalMs)}</span>
        </span>
        <span class="agent-chat__run-stages-hint">点击收起/展开</span>
      </summary>
      <ul class="agent-chat__run-stages-list">
        ${stages.map((stage) => {
          const elapsedMs = stage.active
            ? Math.max(0, nowMs - stage.startedAt)
            : (stage.durationMs ??
              (stage.endedAt != null ? Math.max(0, stage.endedAt - stage.startedAt) : 0));
          const tone = resolveStageTone(stage.stage);
          return html`
            <li
              class="agent-chat__run-stage agent-chat__run-stage--${tone} ${stage.active
                ? "agent-chat__run-stage--active"
                : "agent-chat__run-stage--done"}"
            >
              <span class="agent-chat__run-stage-label">
                ${stage.active ? html`<span class="agent-chat__run-stage-dot"></span>` : nothing}
                <span class="agent-chat__run-stage-tone-tag">${toneTag(tone)}</span>
                ${stage.label}
              </span>
              <span class="agent-chat__run-stage-time">${formatStageSeconds(elapsedMs)}</span>
            </li>
          `;
        })}
      </ul>
    </details>
  `;
}

function toneTag(tone: StageTone): string {
  switch (tone) {
    case "think":
      return "思考";
    case "tool":
      return "工具";
    case "reply":
      return "正文";
    case "wait":
      return "等待";
    default:
      return "准备";
  }
}

function resolveSegments(
  card: ChatRunStageCard,
  liveThinkingText?: string | null,
): ChatThinkingSegment[] {
  const base = card.thinkingSegments?.length
    ? card.thinkingSegments.map((s) => ({ ...s }))
    : card.thinkingText?.trim()
      ? [
          {
            id: `${card.id}:think0`,
            text: card.thinkingText.trim(),
            startedAt: card.startedAt,
            endedAt: card.endedAt,
            durationMs: card.thinkingDurationMs ?? null,
          },
        ]
      : [];
  const live = liveThinkingText?.trim();
  if (!live) {
    return base;
  }
  // Merge live text into last open segment or append.
  if (base.length === 0) {
    return [
      {
        id: `${card.id}:think-live`,
        text: live,
        startedAt: Date.now(),
        endedAt: null,
        durationMs: null,
      },
    ];
  }
  const last = base[base.length - 1];
  if (last.endedAt == null || live.startsWith(last.text) || live.length >= last.text.length) {
    base[base.length - 1] = { ...last, text: live, endedAt: null };
    return base;
  }
  return [
    ...base,
    {
      id: `${card.id}:think-live`,
      text: live,
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
    },
  ];
}

/** Render a persisted or live stage card: stages (collapsible) then thinking below. */
export function renderRunStageCard(
  card: ChatRunStageCard,
  options?: {
    nowMs?: number;
    live?: boolean;
    thinkingText?: string | null;
    thinkingStreaming?: boolean;
  },
) {
  const live = options?.live === true || card.stages.some((s) => s.active);
  const nowMs = options?.nowMs ?? Date.now();
  const thinkingStreaming = options?.thinkingStreaming === true;
  const segments = resolveSegments(card, options?.thinkingText);
  if (!card.stages.length && segments.length === 0) {
    return nothing;
  }

  return html`
    <div
      class="chat-run-stage-card ${live ? "chat-run-stage-card--live" : ""}"
      data-stage-card-id=${card.id}
    >
      ${card.stages.length
        ? renderRunStagePanel(card.stages, {
            nowMs,
            title: live ? "关键路径耗时" : "关键路径耗时（本轮）",
            open: live,
          })
        : nothing}
      ${segments.length
        ? html`<div class="chat-run-stage-card__thinking-stack">
            ${segments.map((seg, index) => {
              const isLast = index === segments.length - 1;
              const streaming = thinkingStreaming && isLast && seg.endedAt == null;
              const ms =
                seg.durationMs ??
                (seg.endedAt != null
                  ? Math.max(0, seg.endedAt - seg.startedAt)
                  : streaming
                    ? Math.max(0, nowMs - seg.startedAt)
                    : null);
              const durationLabel =
                ms == null
                  ? null
                  : ms < 10_000
                    ? `${(ms / 1000).toFixed(1)}s`
                    : `${Math.round(ms / 1000)}s`;
              const title = segments.length > 1 ? `思考过程 · 第 ${index + 1} 轮` : "思考过程";
              return html`
                <details class="chat-thinking-panel" ?open=${streaming}>
                  <summary class="chat-thinking-panel__summary">
                    <span class="chat-thinking-panel__title">
                      <span class="chat-thinking-panel__icon" aria-hidden="true">◎</span>
                      ${title}
                      ${streaming
                        ? html`<span class="chat-thinking-panel__live" aria-label="streaming"
                            >…</span
                          >`
                        : nothing}
                      ${durationLabel
                        ? html`<span class="chat-thinking-panel__duration">${durationLabel}</span>`
                        : nothing}
                    </span>
                    <span class="chat-thinking-panel__source">WebUI 仅展示</span>
                  </summary>
                  <div class="chat-thinking-panel__body">
                    <pre class="chat-thinking-panel__text">${seg.text}</pre>
                  </div>
                </details>
              `;
            })}
          </div>`
        : nothing}
    </div>
  `;
}

/**
 * Merge live thinking stream into multi-round segments.
 * Call when thinking text grows or when a new thinking stage starts.
 */
export function appendThinkingToSegments(params: {
  cardId: string;
  segments: ChatThinkingSegment[] | undefined;
  text: string;
  /** When true, start a new segment even if previous is open. */
  forceNewSegment?: boolean;
  nowMs?: number;
}): ChatThinkingSegment[] {
  const now = params.nowMs ?? Date.now();
  const text = params.text.trim();
  if (!text) {
    return params.segments?.slice() ?? [];
  }
  const segs = params.segments?.map((s) => ({ ...s })) ?? [];
  if (params.forceNewSegment || segs.length === 0) {
    // Seal previous open segment
    if (segs.length > 0 && segs[segs.length - 1].endedAt == null) {
      const prev = segs[segs.length - 1];
      segs[segs.length - 1] = {
        ...prev,
        endedAt: now,
        durationMs: Math.max(0, now - prev.startedAt),
      };
    }
    segs.push({
      id: createThinkingSegmentId(params.cardId, segs.length),
      text,
      startedAt: now,
      endedAt: null,
      durationMs: null,
    });
    return segs;
  }
  const last = segs[segs.length - 1];
  // Cumulative stream: replace last text if it grows as prefix extension
  if (text.startsWith(last.text) || text.length >= last.text.length) {
    segs[segs.length - 1] = { ...last, text, endedAt: null };
  } else if (last.endedAt != null) {
    segs.push({
      id: createThinkingSegmentId(params.cardId, segs.length),
      text,
      startedAt: now,
      endedAt: null,
      durationMs: null,
    });
  } else {
    segs[segs.length - 1] = { ...last, text };
  }
  return segs;
}

export function sealOpenThinkingSegments(
  segments: ChatThinkingSegment[] | undefined,
  nowMs = Date.now(),
): ChatThinkingSegment[] {
  if (!segments?.length) {
    return [];
  }
  return segments.map((s) =>
    s.endedAt == null
      ? {
          ...s,
          endedAt: nowMs,
          durationMs: Math.max(0, nowMs - s.startedAt),
        }
      : s,
  );
}
