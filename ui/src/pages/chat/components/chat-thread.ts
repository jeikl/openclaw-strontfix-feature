// Chat-owned message thread presentation and thread-local interaction state.
import { html, nothing, type TemplateResult } from "lit";
import { guard } from "lit/directives/guard.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import type { SessionsListResult } from "../../../api/types.ts";
import { resolveLocalUserName } from "../../../app/user-identity.ts";
import { icons } from "../../../components/icons.ts";
import {
  handleMarkdownCodeBlockCopy,
  markdownFileLinkFromEvent,
} from "../../../components/markdown.ts";
import "../../../components/tooltip.ts";
import { CHAT_HISTORY_RENDER_LIMIT } from "../../../lib/chat/chat-types.ts";
import type { ChatQueueItem, ChatStreamSegment } from "../../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../../lib/chat/message-extract.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import {
  buildCachedChatItems,
  coalesceStreamRuns,
  deletedChatItemsSignature,
  getExpandedToolCards,
  resetChatThreadState,
  stableBooleanMapSignature,
  syncToolCardExpansionState,
} from "../chat-thread.ts";
import { DeletedMessages } from "../deleted-messages.ts";
import { PinnedMessages } from "../pinned-messages.ts";
import type { RealtimeTalkConversationEntry } from "../realtime-talk-conversation.ts";
import { renderRunStageCard } from "../run-stage-ui.ts";
import { getOrCreateSessionCacheValue } from "../session-cache.ts";
import {
  getAssistantAttachmentAvailabilityRenderVersion,
  renderMessageGroup,
  renderStreamGroup,
  renderThinkingPanel,
} from "./chat-message.ts";
import { renderRealtimeTalkConversation } from "./chat-realtime-controls.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import { renderWelcomeState, resolveAssistantDisplayAvatar } from "./chat-welcome.ts";

function renderThinkingPanelInline(
  text: string,
  opts?: { streaming?: boolean; durationMs?: number | null },
) {
  return renderThinkingPanel({
    text,
    source: "reasoning_content",
    streaming: opts?.streaming !== false,
    open: opts?.streaming !== false,
    durationMs: opts?.durationMs ?? null,
  });
}

function resolveThinkingDurationMs(
  stages:
    | Array<{
        stage: string;
        startedAt: number;
        durationMs?: number | null;
        active?: boolean;
      }>
    | null
    | undefined,
): number | null {
  if (!stages?.length) {
    return null;
  }
  const thinking = stages.find((s) => s.stage === "thinking");
  if (!thinking) {
    return null;
  }
  if (thinking.durationMs != null && Number.isFinite(thinking.durationMs)) {
    return thinking.durationMs;
  }
  if (thinking.active) {
    return Math.max(0, Date.now() - thinking.startedAt);
  }
  return null;
}

const pinnedMessagesMap = new Map<string, PinnedMessages>();
const deletedMessagesMap = new Map<string, DeletedMessages>();
const INITIAL_CHAT_HISTORY_RENDER_WINDOW = 30;
const CHAT_HISTORY_RENDER_WINDOW_BATCH = 30;
const CHAT_HISTORY_RENDER_EXPAND_SCROLL_TOP_PX = 48;

type ReplyTarget = {
  messageId: string;
  text: string;
  senderLabel?: string | null;
};

type ChatThreadState = {
  searchOpen: boolean;
  searchQuery: string;
  pinnedExpanded: boolean;
  historyRenderSessionKey: string | null;
  historyRenderMessagesRef: unknown[] | null;
  historyRenderMessageCount: number;
  historyRenderLimit: number;
  historyRenderLastScrollTop: number | null;
  historyRenderExpansionFrame: number | null;
  historyRenderAnchorAdjustment: {
    scrollHeight: number;
    scrollTop: number;
  } | null;
  historyRenderAnchorFrame: number | null;
};

type ChatThreadProps = {
  paneId: string;
  sessionKey: string;
  loading: boolean;
  messages: unknown[];
  toolMessages: unknown[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  thinkingStream?: string | null;
  runStages?: import("../tool-stream.ts").ChatRunStageEntry[] | null;
  runStageCards?: import("../run-stage-ui.ts").ChatRunStageCard[] | null;
  chatRunId?: string | null;
  chatRunStageCardId?: string | null;
  streamStartedAt: number | null;
  queue: ChatQueueItem[];
  showThinking: boolean;
  showToolCalls: boolean;
  sessions: SessionsListResult | null;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarUrl?: string | null;
  userName?: string | null;
  userAvatar?: string | null;
  basePath?: string;
  fullMessageAgentId?: string;
  localMediaPreviewRoots?: string[];
  assistantAttachmentAuthToken?: string | null;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  autoExpandToolCalls?: boolean;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
  onOpenSidebar?: (content: SidebarContent) => void;
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
  onOpenSessionCheckpoints?: () => void | Promise<void>;
  onAssistantAttachmentLoaded?: () => void;
  onRequestUpdate?: () => void;
  onScrollToBottom?: () => void;
  onChatScroll?: (event: Event) => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onSetReply?: (target: ReplyTarget) => void;
  onFocusComposer?: () => void;
};

type ChatPinnedMessagesProps = Pick<
  ChatThreadProps,
  "paneId" | "sessionKey" | "messages" | "userName" | "userAvatar"
>;

function createChatThreadState(): ChatThreadState {
  return {
    searchOpen: false,
    searchQuery: "",
    pinnedExpanded: false,
    historyRenderSessionKey: null,
    historyRenderMessagesRef: null,
    historyRenderMessageCount: 0,
    historyRenderLimit: 0,
    historyRenderLastScrollTop: null,
    historyRenderExpansionFrame: null,
    historyRenderAnchorAdjustment: null,
    historyRenderAnchorFrame: null,
  };
}

const threadStates = new Map<string, ChatThreadState>();

function getChatThreadState(paneId: string): ChatThreadState {
  const existing = threadStates.get(paneId);
  if (existing) {
    return existing;
  }
  const state = createChatThreadState();
  threadStates.set(paneId, state);
  return state;
}

function getPinnedMessages(sessionKey: string): PinnedMessages {
  return getOrCreateSessionCacheValue(
    pinnedMessagesMap,
    sessionKey,
    () => new PinnedMessages(sessionKey),
  );
}

function getDeletedMessages(sessionKey: string): DeletedMessages {
  return getOrCreateSessionCacheValue(
    deletedMessagesMap,
    sessionKey,
    () => new DeletedMessages(sessionKey),
  );
}

function getPinnedMessageSummary(message: unknown): string {
  return extractTextCached(message) ?? "";
}

export function resetChatThreadPresentationState(paneId?: string) {
  removeReplyContextMenu(paneId);
  const states = paneId
    ? ([threadStates.get(paneId)].filter(Boolean) as ChatThreadState[])
    : [...threadStates.values()];
  for (const state of states) {
    if (state.historyRenderExpansionFrame != null) {
      cancelAnimationFrame(state.historyRenderExpansionFrame);
    }
    if (state.historyRenderAnchorFrame != null) {
      cancelAnimationFrame(state.historyRenderAnchorFrame);
    }
  }
  if (paneId) {
    threadStates.delete(paneId);
  } else {
    threadStates.clear();
    resetChatThreadState();
  }
}

function resolveChatHistoryRenderCap(messageCount: number): number {
  return Math.min(Math.max(0, messageCount), CHAT_HISTORY_RENDER_LIMIT);
}

function shouldRenderFullChatHistoryWindow(state: ChatThreadState, messageCount: number): boolean {
  return (
    messageCount <= INITIAL_CHAT_HISTORY_RENDER_WINDOW ||
    (state.searchOpen && state.searchQuery.trim().length > 0)
  );
}

function resolveChatHistoryRenderWindow(
  props: Pick<ChatThreadProps, "paneId" | "sessionKey" | "messages">,
) {
  const state = getChatThreadState(props.paneId);
  const messages = Array.isArray(props.messages) ? props.messages : [];
  const cap = resolveChatHistoryRenderCap(messages.length);
  const sessionChanged = state.historyRenderSessionKey !== props.sessionKey;
  const refChanged = state.historyRenderMessagesRef !== messages;
  const previousCount = state.historyRenderMessageCount;
  if (sessionChanged || (refChanged && previousCount === 0)) {
    state.historyRenderLastScrollTop = null;
  }

  if (cap === 0) {
    state.historyRenderSessionKey = props.sessionKey;
    state.historyRenderMessagesRef = messages;
    state.historyRenderMessageCount = messages.length;
    state.historyRenderLimit = 0;
    state.historyRenderLastScrollTop = null;
    return 0;
  }

  if (shouldRenderFullChatHistoryWindow(state, messages.length)) {
    state.historyRenderSessionKey = props.sessionKey;
    state.historyRenderMessagesRef = messages;
    state.historyRenderMessageCount = messages.length;
    state.historyRenderLimit = cap;
    return cap;
  }

  if (sessionChanged || (refChanged && previousCount === 0)) {
    state.historyRenderLimit = Math.min(INITIAL_CHAT_HISTORY_RENDER_WINDOW, cap);
  } else if (refChanged) {
    const grewBy = messages.length - previousCount;
    if (state.historyRenderLimit >= previousCount) {
      state.historyRenderLimit = cap;
    } else if (grewBy > 0 && grewBy <= CHAT_HISTORY_RENDER_WINDOW_BATCH) {
      state.historyRenderLimit = Math.min(cap, state.historyRenderLimit + grewBy);
    } else {
      state.historyRenderLimit = Math.min(
        Math.max(state.historyRenderLimit, INITIAL_CHAT_HISTORY_RENDER_WINDOW),
        cap,
      );
    }
  }

  state.historyRenderSessionKey = props.sessionKey;
  state.historyRenderMessagesRef = messages;
  state.historyRenderMessageCount = messages.length;
  state.historyRenderLimit = Math.min(Math.max(1, state.historyRenderLimit), cap);
  return state.historyRenderLimit;
}

function maybeExpandChatHistoryRenderWindow(
  state: ChatThreadState,
  event: Event,
  requestUpdate: () => void,
) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const scrollTop = Math.max(0, target.scrollTop);
  const previousScrollTop = state.historyRenderLastScrollTop;
  state.historyRenderLastScrollTop = scrollTop;
  const distanceFromBottom = Math.max(0, target.scrollHeight - scrollTop - target.clientHeight);
  const isTop = scrollTop <= CHAT_HISTORY_RENDER_EXPAND_SCROLL_TOP_PX;
  const isBottomAutoScroll =
    scrollTop > 0 && distanceFromBottom <= CHAT_HISTORY_RENDER_EXPAND_SCROLL_TOP_PX;
  const isTopScrollUp =
    isTop &&
    (scrollTop === 0 ||
      (!isBottomAutoScroll && (previousScrollTop == null || scrollTop < previousScrollTop)));
  if (!isTopScrollUp) {
    return;
  }
  const cap = resolveChatHistoryRenderCap(state.historyRenderMessageCount);
  if (state.historyRenderLimit >= cap) {
    return;
  }
  state.historyRenderAnchorAdjustment = {
    scrollHeight: target.scrollHeight,
    scrollTop,
  };
  scheduleChatHistoryRenderAnchorPreservation(state, target);
  state.historyRenderLimit = Math.min(
    cap,
    state.historyRenderLimit + CHAT_HISTORY_RENDER_WINDOW_BATCH,
  );
  requestUpdate();
}

function scheduleChatHistoryRenderAnchorPreservation(state: ChatThreadState, thread: HTMLElement) {
  const adjustment = state.historyRenderAnchorAdjustment;
  if (!adjustment || state.historyRenderAnchorFrame != null) {
    return;
  }
  state.historyRenderAnchorFrame = requestAnimationFrame(() => {
    state.historyRenderAnchorFrame = null;
    state.historyRenderAnchorAdjustment = null;
    const heightDelta = thread.scrollHeight - adjustment.scrollHeight;
    if (heightDelta <= 0) {
      return;
    }
    thread.scrollTop = adjustment.scrollTop + heightDelta;
  });
}

function scheduleChatHistoryRenderWindowFill(
  state: ChatThreadState,
  thread: HTMLElement | null,
  requestUpdate: () => void,
  scrollToBottom: () => void,
) {
  if (!thread || state.historyRenderExpansionFrame != null) {
    return;
  }
  const cap = resolveChatHistoryRenderCap(state.historyRenderMessageCount);
  if (state.historyRenderLimit >= cap) {
    return;
  }
  state.historyRenderExpansionFrame = requestAnimationFrame(() => {
    state.historyRenderExpansionFrame = null;
    const nextCap = resolveChatHistoryRenderCap(state.historyRenderMessageCount);
    if (state.historyRenderLimit >= nextCap) {
      return;
    }
    const canScroll = thread.scrollHeight - thread.clientHeight > 1;
    if (canScroll) {
      return;
    }
    state.historyRenderLimit = Math.min(
      nextCap,
      state.historyRenderLimit + CHAT_HISTORY_RENDER_WINDOW_BATCH,
    );
    requestUpdate();
    scrollToBottom();
  });
}

export function renderChatSearchBar(
  paneId: string,
  requestUpdate: () => void,
): TemplateResult | typeof nothing {
  const state = getChatThreadState(paneId);
  if (!state.searchOpen) {
    return nothing;
  }
  return html`
    <div class="agent-chat__search-bar">
      ${icons.search}
      <input
        type="text"
        placeholder="Search messages..."
        aria-label="Search messages"
        .value=${state.searchQuery}
        @input=${(event: Event) => {
          state.searchQuery = (event.target as HTMLInputElement).value;
          requestUpdate();
        }}
      />
      <openclaw-tooltip content="Close search">
        <button
          class="btn btn--ghost"
          aria-label="Close search"
          @click=${() => {
            state.searchOpen = false;
            state.searchQuery = "";
            requestUpdate();
          }}
        >
          ${icons.x}
        </button>
      </openclaw-tooltip>
    </div>
  `;
}

export function isChatThreadSearchOpen(paneId: string): boolean {
  return getChatThreadState(paneId).searchOpen;
}

export function toggleChatThreadSearch(paneId: string, requestUpdate: () => void): void {
  const state = getChatThreadState(paneId);
  state.searchOpen = !state.searchOpen;
  if (!state.searchOpen) {
    state.searchQuery = "";
  }
  requestUpdate();
}

export function renderChatPinnedMessages(
  props: ChatPinnedMessagesProps,
  requestUpdate: () => void,
): TemplateResult | typeof nothing {
  const state = getChatThreadState(props.paneId);
  const pinned = getPinnedMessages(props.sessionKey);
  const userRoleLabel = resolveLocalUserName({
    name: props.userName ?? null,
    avatar: props.userAvatar ?? null,
  });
  const messages = Array.isArray(props.messages) ? props.messages : [];
  const entries: Array<{ index: number; text: string; role: string }> = [];
  for (const idx of pinned.indices) {
    const msg = messages[idx] as Record<string, unknown> | undefined;
    if (!msg) {
      continue;
    }
    const text = getPinnedMessageSummary(msg);
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    entries.push({ index: idx, text, role });
  }
  if (entries.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-chat__pinned">
      <button
        class="agent-chat__pinned-toggle"
        aria-expanded=${state.pinnedExpanded}
        @click=${() => {
          state.pinnedExpanded = !state.pinnedExpanded;
          requestUpdate();
        }}
      >
        ${icons.bookmark} ${entries.length} pinned
        <span class="collapse-chevron ${state.pinnedExpanded ? "" : "collapse-chevron--collapsed"}"
          >${icons.chevronDown}</span
        >
      </button>
      ${state.pinnedExpanded
        ? html`
            <div class="agent-chat__pinned-list">
              ${entries.map(
                ({ index, text, role }) => html`
                  <div class="agent-chat__pinned-item">
                    <span class="agent-chat__pinned-role"
                      >${role === "user" ? userRoleLabel : "Assistant"}</span
                    >
                    <span class="agent-chat__pinned-text"
                      >${text.slice(0, 100)}${text.length > 100 ? "..." : ""}</span
                    >
                    <openclaw-tooltip content="Unpin">
                      <button
                        class="btn btn--ghost"
                        aria-label="Unpin"
                        @click=${() => {
                          pinned.unpin(index);
                          requestUpdate();
                        }}
                      >
                        ${icons.x}
                      </button>
                    </openclaw-tooltip>
                  </div>
                `,
              )}
            </div>
          `
        : nothing}
    </div>
  `;
}

let activeReplyContextMenu: HTMLElement | null = null;
let activeReplyContextMenuPaneId: string | null = null;
let contextMenuDocumentClickHandler: ((event: MouseEvent) => void) | null = null;
let contextMenuKeydownHandler: ((event: KeyboardEvent) => void) | null = null;

function removeReplyContextMenu(paneId?: string) {
  if (paneId && paneId !== activeReplyContextMenuPaneId) {
    return;
  }
  activeReplyContextMenu?.remove();
  activeReplyContextMenu = null;
  activeReplyContextMenuPaneId = null;
  document.querySelector(".chat-reply-context-menu")?.remove();
  if (contextMenuDocumentClickHandler) {
    document.removeEventListener("click", contextMenuDocumentClickHandler);
    contextMenuDocumentClickHandler = null;
  }
  if (contextMenuKeydownHandler) {
    document.removeEventListener("keydown", contextMenuKeydownHandler);
    contextMenuKeydownHandler = null;
  }
}

function stableReplyMessageId(senderLabel: string | undefined, text: string): string {
  const source = `${senderLabel ?? ""}\n${text}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `reply:${(hash >>> 0).toString(16)}`;
}

function createReplyContextMenuButton(onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.setAttribute("aria-label", "Reply to message");

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("fill", "currentColor");
  icon.setAttribute("stroke", "none");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
  icon.appendChild(path);

  const label = document.createElement("span");
  label.textContent = "Reply";

  button.append(icon, label);
  button.addEventListener("click", onClick);
  return button;
}

function handleChatContextMenu(event: MouseEvent, props: ChatThreadProps) {
  const bubble = (event.target as HTMLElement).closest(".chat-bubble");
  if (!bubble || typeof props.onSetReply !== "function") {
    return;
  }
  const group = bubble.closest(".chat-group");
  if (!group) {
    return;
  }
  if (
    group.querySelector(".chat-reading-indicator") ||
    group.querySelector(".chat-bubble.streaming")
  ) {
    return;
  }
  const senderEl = group.querySelector(".chat-sender-name");
  const senderLabel = senderEl?.textContent?.trim() ?? undefined;
  const text = (bubble as HTMLElement).dataset.messageText?.trim().slice(0, 500) ?? "";
  if (!text) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const messageId =
    (bubble as HTMLElement).dataset.messageId?.trim() || stableReplyMessageId(senderLabel, text);
  removeReplyContextMenu();
  const menu = document.createElement("div");
  menu.className = "chat-reply-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Message actions");
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  const button = createReplyContextMenuButton(() => {
    props.onSetReply?.({ messageId, text, senderLabel });
    removeReplyContextMenu();
    props.onFocusComposer?.();
  });
  menu.append(button);
  document.body.appendChild(menu);
  activeReplyContextMenu = menu;
  activeReplyContextMenuPaneId = props.paneId;

  const menuRect = menu.getBoundingClientRect();
  let left = event.clientX;
  let top = event.clientY;
  if (left + menuRect.width > window.innerWidth) {
    left = window.innerWidth - menuRect.width - 8;
  }
  if (top + menuRect.height > window.innerHeight) {
    top = window.innerHeight - menuRect.height - 8;
  }
  menu.style.left = `${Math.max(0, left)}px`;
  menu.style.top = `${Math.max(0, top)}px`;
  button.focus();
  requestAnimationFrame(() => {
    if (!menu.isConnected || activeReplyContextMenu !== menu) {
      return;
    }
    contextMenuDocumentClickHandler = (nextEvent: MouseEvent) => {
      if (!menu.contains(nextEvent.target as Node | null)) {
        removeReplyContextMenu();
      }
    };
    const handleKeydown = (nextEvent: KeyboardEvent) => {
      if (nextEvent.key === "Escape") {
        nextEvent.preventDefault();
        nextEvent.stopPropagation();
        removeReplyContextMenu();
        props.onFocusComposer?.();
      }
    };
    contextMenuKeydownHandler = handleKeydown;
    document.addEventListener("click", contextMenuDocumentClickHandler);
    document.addEventListener("keydown", handleKeydown);
  });
}

function renderLoadingSkeleton() {
  return html`
    <div class="chat-loading-skeleton" aria-label="Loading chat">
      <div class="chat-line assistant">
        <div class="chat-msg">
          <div class="chat-bubble">
            <div
              class="skeleton skeleton-line skeleton-line--long"
              style="margin-bottom: 8px"
            ></div>
            <div
              class="skeleton skeleton-line skeleton-line--medium"
              style="margin-bottom: 8px"
            ></div>
            <div class="skeleton skeleton-line skeleton-line--short"></div>
          </div>
        </div>
      </div>
      <div class="chat-line user" style="margin-top: 12px">
        <div class="chat-msg">
          <div class="chat-bubble">
            <div class="skeleton skeleton-line skeleton-line--medium"></div>
          </div>
        </div>
      </div>
      <div class="chat-line assistant" style="margin-top: 12px">
        <div class="chat-msg">
          <div class="chat-bubble">
            <div
              class="skeleton skeleton-line skeleton-line--long"
              style="margin-bottom: 8px"
            ></div>
            <div class="skeleton skeleton-line skeleton-line--short"></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderChatThread(props: ChatThreadProps) {
  const state = getChatThreadState(props.paneId);
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const displayStream = props.stream ?? null;
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  // Control UI: Show-thinking toggle alone controls display. Session reasoningLevel
  // is a model-effort setting and must not hide live/diagnostic reasoning panels.
  const showReasoning = props.showThinking;
  const assistantIdentity = {
    name: props.assistantName,
    avatar: resolveAssistantDisplayAvatar(props),
  };
  const historyRenderLimit = resolveChatHistoryRenderWindow(props);
  const deleted = getDeletedMessages(props.sessionKey);
  // Live wire thinking is always shown when present (diagnosis). Historical
  // message thinking still respects the showThinking toggle.
  const hasLiveThinking =
    typeof props.thinkingStream === "string" && props.thinkingStream.trim().length > 0;
  const chatItems = buildCachedChatItems({
    sessionKey: props.sessionKey,
    messages: props.messages,
    toolMessages: props.toolMessages,
    streamSegments: props.streamSegments,
    stream: displayStream,
    streamStartedAt: props.streamStartedAt,
    queue: props.queue,
    showToolCalls: props.showToolCalls,
    searchOpen: state.searchOpen,
    searchQuery: state.searchQuery,
    historyRenderLimit,
    // Keep a stream-run mount while only thinking tokens are arriving.
    showLivePlaceholder: hasLiveThinking,
  });
  syncToolCardExpansionState(props.sessionKey, chatItems, Boolean(props.autoExpandToolCalls));
  const expandedToolCards = getExpandedToolCards(props.sessionKey);
  const toggleToolCardExpanded = (toolCardId: string) => {
    expandedToolCards.set(toolCardId, !expandedToolCards.get(toolCardId));
    requestUpdate();
  };
  const hasRealtimeTalkConversation = (props.realtimeTalkConversation?.length ?? 0) > 0;
  const isEmpty = chatItems.length === 0 && !props.loading && !hasRealtimeTalkConversation;
  const showLoadingSkeleton = props.loading && chatItems.length === 0;
  const threadContextWindow =
    activeSession?.contextTokens ?? props.sessions?.defaults?.contextTokens ?? null;
  const handleChatThreadScroll = (event: Event) => {
    maybeExpandChatHistoryRenderWindow(state, event, requestUpdate);
    props.onChatScroll?.(event);
  };

  return html`
    <div
      class="chat-thread"
      role="log"
      aria-live="polite"
      ${ref((element) => {
        const threadElement = element instanceof HTMLElement ? element : null;
        scheduleChatHistoryRenderWindowFill(
          state,
          threadElement,
          requestUpdate,
          props.onScrollToBottom ?? (() => {}),
        );
      })}
      @scroll=${handleChatThreadScroll}
      @click=${(event: Event) => {
        handleMarkdownCodeBlockCopy(event);
        const target = markdownFileLinkFromEvent(event);
        if (target) {
          props.onOpenWorkspaceFile?.(target);
        }
      }}
      @contextmenu=${(event: MouseEvent) => handleChatContextMenu(event, props)}
    >
      <div class="chat-thread-inner">
        ${showLoadingSkeleton ? renderLoadingSkeleton() : nothing}
        ${isEmpty && !state.searchOpen ? renderWelcomeState(props) : nothing}
        ${isEmpty && state.searchOpen
          ? html` <div class="agent-chat__empty">No matching messages</div> `
          : nothing}
        ${guard(
          [
            chatItems,
            deletedChatItemsSignature(deleted, chatItems),
            stableBooleanMapSignature(expandedToolCards),
            getAssistantAttachmentAvailabilityRenderVersion(),
            props.sessionKey,
            props.fullMessageAgentId,
            showReasoning,
            props.thinkingStream ?? "",
            JSON.stringify(props.runStages ?? null),
            JSON.stringify(props.runStageCards ?? null),
            props.showToolCalls,
            Boolean(props.autoExpandToolCalls),
            props.assistantName,
            assistantIdentity.avatar,
            props.userName,
            props.userAvatar,
            props.basePath,
            (props.localMediaPreviewRoots ?? []).join("\u0000"),
            props.assistantAttachmentAuthToken,
            props.canvasPluginSurfaceUrl,
            props.embedSandboxMode ?? "scripts",
            props.allowExternalEmbedUrls ?? false,
            threadContextWindow,
          ],
          () => {
            const coalesced = coalesceStreamRuns(chatItems);
            const liveStages = props.runStages ?? [];
            const liveActive = liveStages.some((s) => s.active);
            const hasStreamRun = coalesced.some((it) => it.kind === "stream-run");
            // Live card only while the turn is still in flight (active stage or stream).
            const showLiveCard =
              liveStages.length > 0 && (liveActive || props.stream != null || hasStreamRun);
            // Completed cards + persistent cards. Skip in-progress or active run cards when live card is active.
            const activeRunId = props.chatRunId;
            const activeCardId = props.chatRunStageCardId;
            const rawHistoryCards = (props.runStageCards ?? []).filter((card) => {
              if (!card.stages.length) {
                return false;
              }
              if (
                showLiveCard &&
                (card.endedAt == null ||
                  card.id === "live" ||
                  (activeCardId && card.id === activeCardId) ||
                  (activeRunId && card.runId === activeRunId))
              ) {
                return false;
              }
              return true;
            });
            // Sort history cards by time so we process them chronologically.
            const historyCards = [...rawHistoryCards].sort((a, b) => a.startedAt - b.startedAt);
            // Anchor stage cards to message blocks. Cards in the same turn will group together.
            const cardsBeforeKey = new Map<string, typeof historyCards>();
            const cardsAfterKey = new Map<string, typeof historyCards>();
            const usedCardIds = new Set<string>();

            // We do NOT claim targets exclusively anymore, so multiple rounds in one turn
            // can anchor to the same assistant message block.

            // Group history cards by turn (anchoring to the User message that started the turn,
            // or the first Assistant/Tool block of the turn).
            for (const card of historyCards) {
              if (usedCardIds.has(card.id)) {
                continue;
              }
              // Find the User prompt that started this turn (User message ts <= card.startedAt)
              let bestUserTarget: (typeof coalesced)[0] | null = null;
              let minUserDiff = Infinity;
              for (const it of coalesced) {
                if (it.kind === "group" && it.role === "user") {
                  const itTs = it.timestamp ?? 0;
                  // The card should start after or very close to the user message
                  if (itTs <= card.startedAt + 10_000) {
                    const diff = Math.abs(card.startedAt - itTs);
                    if (diff < minUserDiff) {
                      minUserDiff = diff;
                      bestUserTarget = it;
                    }
                  }
                }
              }

              if (bestUserTarget) {
                usedCardIds.add(card.id);
                const existing = cardsAfterKey.get(bestUserTarget.key) ?? [];
                cardsAfterKey.set(bestUserTarget.key, [...existing, card]);
                continue;
              }

              // Fallback: If no user message found, find the VERY FIRST Assistant / Tool message group
              let firstAsstTarget: (typeof coalesced)[0] | null = null;
              for (const it of coalesced) {
                if (
                  (it.kind === "group" && (it.role === "assistant" || it.role === "tool")) ||
                  it.kind === "stream-run"
                ) {
                  firstAsstTarget = it;
                  break;
                }
              }

              if (firstAsstTarget) {
                usedCardIds.add(card.id);
                const existing = cardsBeforeKey.get(firstAsstTarget.key) ?? [];
                cardsBeforeKey.set(firstAsstTarget.key, [...existing, card]);
                continue;
              }
            }
            const liveThinkingText = props.thinkingStream?.trim() || null;
            // Prefer the persisted card's joined thinking (one segment per round
            // with dividers); fall back to the raw live stream.
            const liveMemCard = (props.runStageCards ?? []).find((c) => c.endedAt == null);
            const liveCard = showLiveCard
              ? {
                  id: "live",
                  sessionKey: props.sessionKey,
                  runId: props.chatRunId ?? null,
                  startedAt: liveStages[0]?.startedAt ?? Date.now(),
                  endedAt: null as number | null,
                  stages: liveStages,
                  thinkingText: liveMemCard?.thinkingText || liveThinkingText || null,
                  thinkingDurationMs: resolveThinkingDurationMs(liveStages),
                  thinkingSegments: liveMemCard?.thinkingSegments,
                }
              : null;

            // When a turn is live, attach liveCard directly to the active User message turn (at the top of the turn)
            if (showLiveCard && liveCard) {
              const lastUser = [...coalesced]
                .reverse()
                .find((it) => it.kind === "group" && it.role === "user");
              if (lastUser) {
                const existing = cardsAfterKey.get(lastUser.key) ?? [];
                cardsAfterKey.set(lastUser.key, [...existing, liveCard]);
              } else {
                const firstAsst = coalesced.find(
                  (it) =>
                    (it.kind === "group" && (it.role === "assistant" || it.role === "tool")) ||
                    it.kind === "stream-run",
                );
                if (firstAsst) {
                  const existing = cardsBeforeKey.get(firstAsst.key) ?? [];
                  cardsBeforeKey.set(firstAsst.key, [...existing, liveCard]);
                }
              }
            }

            // if (historyCards.length > 0 || showLiveCard) {
            //   console.log(
            //     `[RunStage Thread] historyCards=${historyCards.length}, showLiveCard=${showLiveCard}, liveStages=${liveStages.length}, liveCard=${Boolean(liveCard)}`,
            //   );
            // }

            return html`
              ${repeat(
                coalesced,
                (item) => item.key,
                (item) => {
                  const cardsAbove = cardsBeforeKey.get(item.key) ?? [];
                  const cardsBelow = cardsAfterKey.get(item.key) ?? [];

                  // Multi-round turns produce one card per round on the backend.
                  // We merge them here so that historically (and on refresh) they
                  // collapse into a single stage list and a single thinking card.
                  const mergeCards = (
                    cards: typeof historyCards,
                  ): (typeof historyCards)[0] | null => {
                    if (cards.length === 0) return null;
                    if (cards.length === 1) return cards[0];
                    const mergedStages = cards.flatMap((c) => c.stages);
                    const mergedSegments = cards.flatMap((c) => c.thinkingSegments ?? []);

                    // Allow the UI helper to insert the dividers for the segments
                    const mergedThinkingText =
                      mergedSegments.length > 0
                        ? null // joinThinkingSegmentsForDisplay will handle this inside renderRunStageCard if segments exist
                        : cards
                            .map((c) => c.thinkingText?.trim())
                            .filter(Boolean)
                            .join("\n\n");

                    const totalThinkingMs =
                      mergedSegments.reduce((sum, s) => sum + (s.durationMs ?? 0), 0) ||
                      cards.reduce((sum, c) => sum + (c.thinkingDurationMs ?? 0), 0);

                    return {
                      ...cards[0],
                      stages: mergedStages,
                      thinkingSegments: mergedSegments,
                      thinkingText: mergedThinkingText || null,
                      thinkingDurationMs: totalThinkingMs > 0 ? totalThinkingMs : null,
                      endedAt: cards[cards.length - 1].endedAt,
                    };
                  };

                  const mergedAbove = mergeCards(cardsAbove);
                  const mergedBelow = mergeCards(cardsBelow);
                  const hasStreamText = Boolean(props.stream && props.stream.trim());

                  const isLiveAbove = Boolean(
                    mergedAbove &&
                    showLiveCard &&
                    (mergedAbove.id === "live" || mergedAbove.endedAt == null),
                  );
                  const isLiveBelow = Boolean(
                    mergedBelow &&
                    showLiveCard &&
                    (mergedBelow.id === "live" || mergedBelow.endedAt == null),
                  );

                  const stagePrefix = mergedAbove
                    ? html`${renderRunStageCard(mergedAbove, {
                        live: isLiveAbove,
                        nowMs: Date.now(),
                        thinkingText: mergedAbove.thinkingText,
                        thinkingStreaming: isLiveAbove && Boolean(liveThinkingText),
                      })}`
                    : nothing;

                  const stageSuffix = mergedBelow
                    ? html`${renderRunStageCard(mergedBelow, {
                        live: isLiveBelow,
                        nowMs: Date.now(),
                        thinkingText: mergedBelow.thinkingText,
                        thinkingStreaming: isLiveBelow && Boolean(liveThinkingText),
                      })}`
                    : nothing;

                  if (item.kind === "divider") {
                    return html`
                      ${stagePrefix}
                      <div class="chat-divider" data-ts=${String(item.timestamp)}>
                        <div class="chat-divider__rule" role="separator" aria-label=${item.label}>
                          <span class="chat-divider__line"></span>
                          <span class="chat-divider__label">${item.label}</span>
                          <span class="chat-divider__line"></span>
                        </div>
                        ${item.description || item.action
                          ? html`
                              <div class="chat-divider__details">
                                ${item.description
                                  ? html`<span class="chat-divider__description">
                                      ${item.description}
                                    </span>`
                                  : nothing}
                                ${item.action?.kind === "session-checkpoints" &&
                                props.onOpenSessionCheckpoints
                                  ? html`
                                      <button
                                        type="button"
                                        class="btn btn--subtle btn--sm chat-divider__action"
                                        @click=${() => props.onOpenSessionCheckpoints?.()}
                                      >
                                        ${item.action.label}
                                      </button>
                                    `
                                  : nothing}
                              </div>
                            `
                          : nothing}
                      </div>
                    `;
                  }
                  if (item.kind === "stream-run") {
                    return html`
                      ${stagePrefix}
                      ${renderStreamGroup(item.parts, {
                        onOpenSidebar: props.onOpenSidebar,
                        assistant: assistantIdentity,
                        basePath: props.basePath,
                        authToken: props.assistantAttachmentAuthToken ?? null,
                        thinkingStream: null,
                        showReasoning: false,
                      })}
                    `;
                  }
                  if (item.kind === "group") {
                    if (deleted.has(item.key)) {
                      return nothing;
                    }
                    return html`
                      ${stagePrefix}
                      ${renderMessageGroup(item, {
                        onOpenSidebar: props.onOpenSidebar,
                        sessionKey: props.sessionKey,
                        agentId: props.fullMessageAgentId,
                        showReasoning: false,
                        showToolCalls: props.showToolCalls,
                        autoExpandToolCalls: Boolean(props.autoExpandToolCalls),
                        isToolMessageExpanded: (messageId: string) =>
                          expandedToolCards.get(messageId),
                        onToggleToolMessageExpanded: (messageId: string, expanded?: boolean) => {
                          expandedToolCards.set(
                            messageId,
                            !(expanded ?? expandedToolCards.get(messageId) ?? false),
                          );
                          requestUpdate();
                        },
                        isToolExpanded: (toolCardId: string) =>
                          expandedToolCards.get(toolCardId) ?? false,
                        onToggleToolExpanded: toggleToolCardExpanded,
                        onRequestUpdate: requestUpdate,
                        onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded,
                        assistantName: props.assistantName,
                        assistantAvatar: assistantIdentity.avatar,
                        userName: props.userName ?? null,
                        userAvatar: props.userAvatar ?? null,
                        basePath: props.basePath,
                        localMediaPreviewRoots: props.localMediaPreviewRoots ?? [],
                        assistantAttachmentAuthToken: props.assistantAttachmentAuthToken ?? null,
                        canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
                        embedSandboxMode: props.embedSandboxMode ?? "scripts",
                        allowExternalEmbedUrls: props.allowExternalEmbedUrls ?? false,
                        contextWindow: threadContextWindow,
                        onDelete: () => {
                          deleted.delete(item.key);
                          requestUpdate();
                        },
                      })}
                      ${item.role === "user" ? stageSuffix : nothing}
                    `;
                  }
                  return nothing;
                },
              )}
              ${(function () {
                // Trailing cards (orphaned cards that failed to anchor to any message) are intentionally hidden.
                // They represent aborted turns that have no corresponding messages in the chat history.
                // Rendering them at the bottom would confuse the user and push the live stream up.
                return nothing;
              })()}
            `;
          },
        )}
        ${renderRealtimeTalkConversation(props)}
      </div>
    </div>
  `;
}
