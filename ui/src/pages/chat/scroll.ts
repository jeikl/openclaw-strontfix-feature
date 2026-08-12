// Control UI module implements app scroll behavior.
import { normalizeChatAutoScrollMode, type ChatAutoScrollMode } from "../../app/settings.ts";

/** Distance (px) from the bottom within which we consider the user "near bottom". */
const NEAR_BOTTOM_THRESHOLD = 120;
const FOLLOW_REACQUIRE_THRESHOLD = 35;
const HEADER_HIDE_SCROLL_DELTA = 12;
const HEADER_SHOW_TOP_THRESHOLD = 24;

type ChatScrollHost = {
  updateComplete: Promise<unknown>;
  querySelector: (selectors: string) => Element | null;
  chatScrollFrame: number | null;
  chatScrollTimeout: number | null;
  chatLastScrollTop: number;
  chatLastScrollHeight?: number;
  chatHasAutoScrolled: boolean;
  chatUserNearBottom: boolean;
  chatFollowLocked: boolean;
  chatHeaderControlsHidden: boolean;
  chatNewMessagesBelow: boolean;
  chatIsProgrammaticScroll: boolean;
  chatProgrammaticScrollTarget: number;
  settings?: {
    chatAutoScroll?: ChatAutoScrollMode;
  };
};

function queryHost(host: Partial<ChatScrollHost>, selectors: string): Element | null {
  return typeof host.querySelector === "function" ? host.querySelector(selectors) : null;
}

type ChatScrollOptions = {
  contentChanged?: boolean;
  source?: "auto" | "manual" | "resize";
};

export function scheduleChatScroll(
  host: ChatScrollHost,
  force = false,
  smooth = false,
  options: ChatScrollOptions = {},
) {
  if (host.chatScrollFrame) {
    cancelAnimationFrame(host.chatScrollFrame);
  }
  if (host.chatScrollTimeout != null) {
    clearTimeout(host.chatScrollTimeout);
    host.chatScrollTimeout = null;
  }
  const pickScrollTarget = () => {
    const container = queryHost(host, ".chat-thread") as HTMLElement | null;
    if (container) {
      const overflowY = getComputedStyle(container).overflowY;
      const canScroll =
        overflowY === "auto" ||
        overflowY === "scroll" ||
        container.scrollHeight - container.clientHeight > 1;
      if (canScroll) {
        return container;
      }
    }
    return (document.scrollingElement ?? document.documentElement) as HTMLElement | null;
  };
  // Wait for Lit render to complete, then scroll
  void host.updateComplete.then(() => {
    host.chatScrollFrame = requestAnimationFrame(() => {
      host.chatScrollFrame = null;
      const target = pickScrollTarget();
      if (!target) {
        return;
      }
      const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
      const contentGrew = target.scrollHeight > (host.chatLastScrollHeight ?? 0) + 1;
      host.chatLastScrollHeight = target.scrollHeight;
      const contentChanged = options.contentChanged ?? options.source !== "resize";
      const autoScrollMode = normalizeChatAutoScrollMode(host.settings?.chatAutoScroll);
      const manualScroll = options.source === "manual";

      // force=true only overrides when we haven't auto-scrolled yet (initial load).
      // After initial load, respect the user's scroll position.
      const effectiveForce = force && !host.chatHasAutoScrolled;
      const shouldStick =
        manualScroll ||
        autoScrollMode === "always" ||
        (autoScrollMode === "near-bottom" &&
          (effectiveForce ||
            !host.chatFollowLocked ||
            host.chatUserNearBottom ||
            distanceFromBottom < NEAR_BOTTOM_THRESHOLD));

      if (!shouldStick) {
        if (contentChanged || (options.source === "resize" && contentGrew)) {
          host.chatNewMessagesBelow = true;
        }
        return;
      }
      if (effectiveForce || manualScroll) {
        host.chatHasAutoScrolled = true;
        host.chatFollowLocked = false;
        host.chatUserNearBottom = true;
        host.chatNewMessagesBelow = false;
      }
      const smoothEnabled =
        smooth &&
        (typeof window === "undefined" ||
          typeof window.matchMedia !== "function" ||
          !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      const scrollTop = target.scrollHeight;
      host.chatProgrammaticScrollTarget = scrollTop;
      host.chatIsProgrammaticScroll = true;
      if (typeof target.scrollTo === "function") {
        target.scrollTo({ top: scrollTop, behavior: smoothEnabled ? "smooth" : "auto" });
      } else {
        target.scrollTop = scrollTop;
      }
      host.chatUserNearBottom = true;
      host.chatNewMessagesBelow = false;

      const guardDelay = smoothEnabled ? 450 : 100;
      host.chatScrollTimeout = window.setTimeout(() => {
        host.chatScrollTimeout = null;
        host.chatIsProgrammaticScroll = false;
        const latest = pickScrollTarget();
        if (latest) {
          const dist = latest.scrollHeight - latest.scrollTop - latest.clientHeight;
          if (dist <= NEAR_BOTTOM_THRESHOLD) {
            host.chatUserNearBottom = true;
            host.chatFollowLocked = false;
            host.chatNewMessagesBelow = false;
          }
        }
      }, guardDelay);
    });
  });
}

export function handleChatScroll(host: ChatScrollHost, event: Event) {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) {
    return;
  }
  const scrollTop = Math.max(0, container.scrollTop);
  const delta = scrollTop - host.chatLastScrollTop;
  host.chatLastScrollTop = scrollTop;
  host.chatLastScrollHeight = container.scrollHeight;

  const isUserScrollUp = delta < 0;
  const isDeliberateScrollUp = delta < -HEADER_HIDE_SCROLL_DELTA;

  if (host.chatIsProgrammaticScroll) {
    if (isDeliberateScrollUp) {
      host.chatIsProgrammaticScroll = false;
      host.chatFollowLocked = true;
      host.chatUserNearBottom = false;
    } else {
      host.chatUserNearBottom = true;
      host.chatNewMessagesBelow = false;
      return;
    }
  }

  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  if (isUserScrollUp && distanceFromBottom > FOLLOW_REACQUIRE_THRESHOLD) {
    host.chatFollowLocked = true;
    host.chatUserNearBottom = false;
  } else if (distanceFromBottom <= NEAR_BOTTOM_THRESHOLD) {
    host.chatFollowLocked = false;
    host.chatUserNearBottom = true;
  }
  const hasUsefulScroll = container.scrollHeight - container.clientHeight > NEAR_BOTTOM_THRESHOLD;

  if (!hasUsefulScroll || scrollTop <= HEADER_SHOW_TOP_THRESHOLD || host.chatUserNearBottom) {
    host.chatHeaderControlsHidden = false;
  } else if (delta > HEADER_HIDE_SCROLL_DELTA) {
    host.chatHeaderControlsHidden = true;
  } else if (isDeliberateScrollUp) {
    host.chatHeaderControlsHidden = false;
  }

  // Clear the "new messages below" indicator when user scrolls back to bottom.
  if (host.chatUserNearBottom) {
    host.chatNewMessagesBelow = false;
  }
}

export function resetChatScroll(host: ChatScrollHost) {
  host.chatHasAutoScrolled = false;
  host.chatUserNearBottom = true;
  host.chatFollowLocked = false;
  host.chatLastScrollTop = 0;
  host.chatLastScrollHeight = 0;
  host.chatHeaderControlsHidden = false;
  host.chatNewMessagesBelow = false;
  host.chatIsProgrammaticScroll = false;
  host.chatProgrammaticScrollTarget = 0;
}
