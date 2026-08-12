/**
 * Control UI-only run stage timings + thinking segments.
 *
 * Primary persistence: gateway disk store (~/.openclaw/run-stage-cards/) so
 * remote browsers see the same diagnosis cards. localStorage is a soft cache.
 * Never written into chat history, transcripts, or model context.
 */
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { renderThinkingPanel } from "./components/chat-message.ts";
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
  return Array.isArray(cards) ? cards.map(normalizeCard).map(finalizeStaleCard).slice() : [];
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
    const cards = Array.isArray(result?.cards)
      ? result.cards.map(normalizeCard).map(finalizeStaleCard)
      : [];
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
  _client: GatewayBrowserClient | null | undefined,
  _card: ChatRunStageCard,
): Promise<void> {
  // Server auto-persist is the primary path and listens to agent events directly on the backend.
  // We disable client-side WS put requests to avoid flooding WebSocket gateway logs on every frame.
  return;
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

/**
 * Finalize cards that were persisted mid-flight (e.g. before a page refresh).
 * Marks all active stages as done and seals open thinking segments so they
 * render cleanly instead of showing stale in-progress data.
 */
function finalizeStaleCard(card: ChatRunStageCard): ChatRunStageCard {
  // Already finalized — nothing to do.
  if (card.endedAt != null && card.stages.every((s) => !s.active)) {
    return card;
  }
  const now = Date.now();
  const stages = card.stages.map((s) => ({
    ...s,
    active: false,
    endedAt: s.endedAt ?? (s.active ? now : s.startedAt),
    durationMs:
      s.durationMs ?? Math.max(0, (s.endedAt ?? (s.active ? now : s.startedAt)) - s.startedAt),
  }));
  const thinkingSegments = sealOpenThinkingSegments(card.thinkingSegments, now);
  const totalThinkingMs = thinkingSegments.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const endedAt =
    card.endedAt ??
    (stages.length > 0 ? stages.reduce((max, s) => Math.max(max, s.endedAt ?? 0), 0) || now : now);
  return {
    ...card,
    stages,
    endedAt,
    thinkingSegments,
    thinkingDurationMs: totalThinkingMs > 0 ? totalThinkingMs : (card.thinkingDurationMs ?? null),
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
  if (runId?.trim()) {
    return `stage-card:${runId.trim()}`;
  }
  return `stage-card:live:${Date.now()}`;
}

export function createThinkingSegmentId(cardId: string, index: number): string {
  return `${cardId}:think:${index}`;
}

/** Prominent visual divider between thinking rounds inside the thinking card. */
export const THINKING_ROUND_DIVIDER = "━".repeat(48);

/** Join per-round thinking segments into one card text with round dividers. */
export function joinThinkingSegmentsForDisplay(
  segments: ChatThinkingSegment[] | undefined | null,
): string | null {
  const texts = (segments ?? []).map((s) => s.text.trim()).filter(Boolean);
  if (texts.length === 0) {
    return null;
  }
  return texts
    .map((text, index) =>
      index === 0
        ? text
        : `${THINKING_ROUND_DIVIDER}\n第 ${index + 1} 轮思考\n${THINKING_ROUND_DIVIDER}\n\n${text}`,
    )
    .join("\n\n");
}

function formatStageSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0.0s";
  }
  // Sub-10s keeps a decimal so live elapsed seconds visibly tick.
  if (ms < 10_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join("") || `${hours}h`;
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

type StageRound = {
  roundIndex: number;
  stages: ChatRunStageEntry[];
};

function groupStagesByRounds(stages: ChatRunStageEntry[]): StageRound[] {
  const rounds: StageRound[] = [];
  let currentRound: ChatRunStageEntry[] = [];

  for (const s of stages) {
    const isWait =
      s.stage === "model_first" || s.label.includes("等待模型首包") || s.label.includes("等待");
    if (isWait && currentRound.length > 0) {
      rounds.push({
        roundIndex: rounds.length + 1,
        stages: currentRound,
      });
      currentRound = [];
    }
    currentRound.push(s);
  }

  if (currentRound.length > 0) {
    rounds.push({
      roundIndex: rounds.length + 1,
      stages: currentRound,
    });
  }

  return rounds;
}

export const userCardToggleMap = new Map<string, boolean>();

/** Pipeline stage list with wall-clock seconds (Control UI diagnosis only). */
export function renderRunStagePanel(
  stages: ChatRunStageEntry[] | null | undefined,
  options?: {
    cardId?: string;
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
  let totalMs = 0;
  const toneTotals: Partial<Record<StageTone, number>> = {};
  for (const stage of stages) {
    const elapsed = stage.active
      ? Math.max(0, nowMs - stage.startedAt)
      : (stage.durationMs ??
        (stage.endedAt != null ? Math.max(0, stage.endedAt - stage.startedAt) : 0));
    totalMs += elapsed;
    const tone = resolveStageTone(stage.stage);
    toneTotals[tone] = (toneTotals[tone] ?? 0) + elapsed;
  }

  const toneOrder: StageTone[] = ["prep", "think", "reply", "tool", "wait"];
  const toneLabels = toneOrder
    .map((tone) => ({ tone, label: toneTag(tone), ms: toneTotals[tone] ?? 0 }))
    .filter((t) => t.ms > 0);

  const toneBreakdown =
    toneLabels.length > 0
      ? html`<span class="agent-chat__run-stages-breakdown">
          ${toneLabels.map(
            (t) => html`<span
              class="agent-chat__run-stage-tone-summary agent-chat__run-stage-tone-summary--${t.tone}"
            >
              ${t.label} ${formatStageSeconds(t.ms)}
            </span>`,
          )}
        </span>`
      : nothing;

  const rounds = groupStagesByRounds(stages);

  const panelCardId = options?.cardId ? `panel:${options.cardId}` : null;

  return html`
    <details
      class="agent-chat__run-stages"
      ?open=${open}
      @toggle=${(e: Event) => {
        const el = e.currentTarget as HTMLDetailsElement;
        if (panelCardId) {
          userCardToggleMap.set(panelCardId, el.open);
        }
      }}
      data-run-stages-panel="true"
    >
      <summary class="agent-chat__run-stages-summary">
        <span class="agent-chat__run-stages-title">
          <span class="agent-chat__run-stages-chevron" aria-hidden="true">▸</span>
          ${title}
          <span class="agent-chat__run-stages-count">${stages.length} 步</span>
          <span class="agent-chat__run-stages-total">${formatStageSeconds(totalMs)}</span>
          ${toneBreakdown}
        </span>
        <span class="agent-chat__run-stages-hint">点击收起/展开</span>
      </summary>
      <div
        class="agent-chat__run-stages-list"
        @scroll=${(e: Event) => {
          const el = e.currentTarget as HTMLElement;
          (el as any)._userScrolledUp = el.scrollHeight - el.scrollTop - el.clientHeight >= 35;
        }}
        ${ref((el) => {
          if (el && open && !(el as any)._userScrolledUp) {
            requestAnimationFrame(() => {
              el.scrollTop = el.scrollHeight;
            });
          }
        })}
      >
        ${rounds.map(
          (round) => html`
            <div class="agent-chat__run-stage-round">
              <div class="agent-chat__run-stage-round-header">
                <span class="agent-chat__run-stage-round-badge">第 ${round.roundIndex} 轮</span>
              </div>
              ${round.stages.map((stage) => {
                const elapsedMs = stage.active
                  ? Math.max(0, nowMs - stage.startedAt)
                  : (stage.durationMs ??
                    (stage.endedAt != null ? Math.max(0, stage.endedAt - stage.startedAt) : 0));
                const tone = resolveStageTone(stage.stage);
                return html`
                  <div
                    class="agent-chat__run-stage agent-chat__run-stage--${tone} ${stage.active
                      ? "agent-chat__run-stage--active"
                      : "agent-chat__run-stage--done"}"
                  >
                    <span class="agent-chat__run-stage-label">
                      ${stage.active
                        ? html`<span class="agent-chat__run-stage-dot"></span>`
                        : nothing}
                      <span class="agent-chat__run-stage-tone-tag">${toneTag(tone)}</span>
                      ${stage.label}
                    </span>
                    <span class="agent-chat__run-stage-time">${formatStageSeconds(elapsedMs)}</span>
                  </div>
                `;
              })}
            </div>
          `,
        )}
      </div>
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
    open?: boolean;
  },
) {
  const live = options?.live === true || card.stages.some((s) => s.active);
  const nowMs = options?.nowMs ?? Date.now();

  // Open state precedence:
  // 1. User manual toggle via @toggle
  // 2. Explicit option passed
  // 3. Live in-progress = OPEN (true), completed/finalized = COLLAPSED (false)
  let open: boolean;
  if (userCardToggleMap.has(card.id)) {
    open = userCardToggleMap.get(card.id)!;
  } else if (options?.open !== undefined) {
    open = options.open;
  } else if (live) {
    open = true;
  } else {
    open = false;
  }

  // Prefer segments-derived text so round dividers survive reload even when the
  // persisted card only carried a raw concatenated thinkingText.
  const thinkingText =
    joinThinkingSegmentsForDisplay(card.thinkingSegments) ||
    options?.thinkingText?.trim() ||
    card.thinkingText?.trim() ||
    null;
  if (!card.stages.length && !thinkingText) {
    return nothing;
  }

  return html`
    <div
      class="chat-run-stage-card ${live ? "chat-run-stage-card--live" : ""}"
      data-stage-card-id=${card.id}
    >
      ${card.stages.length
        ? renderRunStagePanel(card.stages, {
            cardId: card.id,
            nowMs,
            title: live ? "关键路径耗时" : "关键路径耗时（本轮）",
            open,
          })
        : nothing}
      ${thinkingText
        ? renderThinkingPanel({
            id: card.id,
            text: thinkingText,
            source: "reasoningContent",
            streaming: options?.thinkingStreaming ?? false,
            open,
          })
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
  if (last.endedAt != null) {
    let cleanText = text;
    if (last.text && cleanText.startsWith(last.text)) {
      cleanText = cleanText.slice(last.text.length).trim();
    }
    if (!cleanText) {
      return segs;
    }
    segs.push({
      id: createThinkingSegmentId(params.cardId, segs.length),
      text: cleanText,
      startedAt: now,
      endedAt: null,
      durationMs: null,
    });
    return segs;
  }
  // Cumulative stream: replace last text if it grows as prefix extension
  if (text.startsWith(last.text) || text.length >= last.text.length) {
    segs[segs.length - 1] = { ...last, text, endedAt: null };
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
