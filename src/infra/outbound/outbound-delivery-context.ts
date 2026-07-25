/**
 * OC-4: after a successful message(action=send), optionally append a
 * model-visible + gateway-visible outbound_message record with the full
 * original tool args and from/to channel identity.
 *
 * Unlike delivery-mirror rows (provider=openclaw, model=delivery-mirror), these
 * records are NOT filtered from agent history replay and appear in chat.history.
 */
import type { ChannelThreadingToolContext } from "../../channels/plugins/types.public.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { resolveSessionStoreEntry } from "../../config/sessions/store-entry.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import { streamSessionTranscriptLinesReverse } from "../../config/sessions/transcript-stream.js";
import { appendExactAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MessageDeliveryContextMode } from "../../config/types.tools.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  parseSessionDeliveryRoute,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import {
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../shared/transcript-only-openclaw-assistant.js";
import { formatErrorMessage } from "../errors.js";
import { resolveEffectiveMessageToolsConfig } from "./outbound-policy.js";
import type { OutboundSessionRoute } from "./outbound-session.js";

const log = createSubsystemLogger("outbound/delivery-context");

/** Stable marker used in transcript rows and tests. */
export const OUTBOUND_MESSAGE_TYPE = "outbound_message" as const;

/**
 * Model identity for outbound context rows. Must NOT be delivery-mirror or
 * gateway-injected so sanitizeSessionHistory / replay keep the row.
 */
export const OUTBOUND_MESSAGE_MODEL = "outbound-message" as const;

export type OutboundMessageParty = {
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  accountId?: string;
  peerId?: string;
  chatType?: string;
};

/** Who invoked the message tool (the human talking to the bot in the source session). */
export type OutboundMessageInvoker = {
  id?: string;
  name?: string;
};

export type OutboundMessagePayload = {
  type: typeof OUTBOUND_MESSAGE_TYPE;
  from: OutboundMessageParty;
  to: OutboundMessageParty & { raw?: string };
  /** Human who asked the bot to send (group member or DM peer). */
  invoker?: OutboundMessageInvoker;
  args: Record<string, unknown>;
};

const INTERNAL_PARAM_KEY = /^__/;

/** Keys that are safe public message-tool args (plus any extra non-internal keys). */
const PREFERRED_ARG_KEYS = [
  "action",
  "to",
  "channel",
  "accountId",
  "message",
  "media",
  "mediaUrl",
  "mediaUrls",
  "path",
  "filePath",
  "replyTo",
  "threadId",
  "gifPlayback",
  "forceDocument",
  "asDocument",
  "asVoice",
  "audioAsVoice",
  "bestEffort",
  "silent",
  "filename",
  "contentType",
  "buffer",
  "presentation",
  "interactive",
  "delivery",
  "channelData",
] as const;

/**
 * Resolves tools.message.deliveryContext (agent override wins). Default: target.
 */
export function resolveMessageDeliveryContextMode(params: {
  cfg?: OpenClawConfig;
  agentId?: string | null;
}): MessageDeliveryContextMode {
  const mode = resolveEffectiveMessageToolsConfig({
    cfg: params.cfg ?? {},
    agentId: params.agentId,
  })?.deliveryContext;
  if (mode === "target" || mode === "source" || mode === "both" || mode === "off") {
    return mode;
  }
  return "target";
}

export function shouldWriteTargetDeliveryContext(mode: MessageDeliveryContextMode): boolean {
  return mode === "target" || mode === "both";
}

export function shouldWriteSourceDeliveryContext(mode: MessageDeliveryContextMode): boolean {
  return mode === "source" || mode === "both";
}

/**
 * When target delivery context is enabled, skip compressed delivery-mirror for
 * the same send so chat.history does not show dual bubbles.
 */
export function shouldSkipDeliveryMirrorForSend(mode: MessageDeliveryContextMode): boolean {
  return shouldWriteTargetDeliveryContext(mode);
}

/**
 * Snapshot public message-tool args. Drops internal `__*` keys and never
 * injects channel mediaIds — only what the tool/agent passed (plus stable
 * action/to/channel when missing from the map).
 */
export function snapshotMessageToolArgs(params: {
  actionParams: Record<string, unknown>;
  action?: string;
  to?: string;
  channel?: string;
}): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const source = params.actionParams;

  for (const key of PREFERRED_ARG_KEYS) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) {
      args[key] = source[key];
    }
  }

  // Include any other non-internal public keys the tool may have passed.
  for (const [key, value] of Object.entries(source)) {
    if (INTERNAL_PARAM_KEY.test(key) || value === undefined || Object.hasOwn(args, key)) {
      continue;
    }
    // Skip functions / symbols
    if (typeof value === "function" || typeof value === "symbol") {
      continue;
    }
    args[key] = value;
  }

  if (params.action !== undefined && args.action === undefined) {
    args.action = params.action;
  }
  if (params.to !== undefined && args.to === undefined) {
    args.to = params.to;
  }
  if (params.channel !== undefined && args.channel === undefined) {
    args.channel = params.channel;
  }

  return args;
}

function partyFromSessionKey(
  sessionKey: string | undefined,
  extras?: Partial<OutboundMessageParty>,
): OutboundMessageParty {
  const route = parseSessionDeliveryRoute(sessionKey);
  return {
    ...(extras?.agentId ? { agentId: extras.agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...((extras?.channel ?? route?.channel) ? { channel: extras?.channel ?? route?.channel } : {}),
    ...((extras?.accountId ?? route?.accountId)
      ? { accountId: extras?.accountId ?? route?.accountId }
      : {}),
    ...((extras?.peerId ?? route?.peerId) ? { peerId: extras?.peerId ?? route?.peerId } : {}),
    ...((extras?.chatType ?? route?.peerKind)
      ? { chatType: extras?.chatType ?? route?.peerKind }
      : {}),
  };
}

/**
 * Builds the structured outbound_message payload (model + gateway content).
 */
export function buildOutboundMessagePayload(params: {
  agentId?: string;
  sourceSessionKey?: string;
  sourceToolContext?: ChannelThreadingToolContext;
  sourceAccountId?: string | null;
  /** Human who invoked the message tool in the source session. */
  invokerId?: string | null;
  invokerName?: string | null;
  targetTo: string;
  targetChannel: string;
  targetAccountId?: string | null;
  targetRoute?: OutboundSessionRoute | null;
  actionParams: Record<string, unknown>;
  action?: string;
}): OutboundMessagePayload {
  const fromChannel =
    params.sourceToolContext?.currentChannelProvider ??
    parseSessionDeliveryRoute(params.sourceSessionKey)?.channel;
  const fromPeerId =
    params.sourceToolContext?.currentMessagingTarget ??
    params.sourceToolContext?.currentChannelId ??
    parseSessionDeliveryRoute(params.sourceSessionKey)?.peerId;

  const from = partyFromSessionKey(params.sourceSessionKey, {
    agentId: params.agentId,
    channel: typeof fromChannel === "string" ? fromChannel : undefined,
    accountId: params.sourceAccountId?.trim() || undefined,
    peerId: typeof fromPeerId === "string" ? fromPeerId : undefined,
  });

  const toRoute = params.targetRoute;
  const to = {
    raw: params.targetTo,
    ...partyFromSessionKey(toRoute?.sessionKey, {
      agentId: params.agentId,
      channel: params.targetChannel,
      accountId: params.targetAccountId?.trim() || undefined,
      peerId: toRoute?.peer?.id,
      chatType: toRoute?.chatType,
    }),
  };

  const invokerId = params.invokerId?.trim() || undefined;
  const invokerName = params.invokerName?.trim() || undefined;
  // DM source: if invoker id missing, the peer of the source session is the invoker.
  const resolvedInvokerId =
    invokerId || (from.chatType === "direct" || from.chatType === "dm" ? from.peerId : undefined);
  const invoker: OutboundMessageInvoker | undefined =
    resolvedInvokerId || invokerName
      ? {
          ...(resolvedInvokerId ? { id: resolvedInvokerId } : {}),
          ...(invokerName ? { name: invokerName } : {}),
        }
      : undefined;

  return {
    type: OUTBOUND_MESSAGE_TYPE,
    from,
    to,
    ...(invoker ? { invoker } : {}),
    args: snapshotMessageToolArgs({
      actionParams: params.actionParams,
      action: params.action ?? "send",
      to: params.targetTo,
      channel: params.targetChannel,
    }),
  };
}

/** Soften raw displayName / origin labels into a short human title. */
export function cleanSessionDisplayTitle(raw: string | undefined | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  let text = raw.trim();
  if (!text) {
    return undefined;
  }
  // dingtalk-connector:g-机器人测试群 → 机器人测试群
  text = text.replace(/^[a-z0-9._-]+:g-/i, "");
  // dingtalk-connector:group:xxx leftovers
  text = text.replace(/^[a-z0-9._-]+:(?:group|direct|channel|dm):/i, "");
  text = text.replace(/^[a-z0-9._-]+:/i, "");
  // "机器人测试群 id:1775…" → 机器人测试群
  text = text.replace(/\s+id:[^\s]+$/i, "");
  text = text.trim();
  if (!text || text === "group" || text === "direct" || text === "channel") {
    return undefined;
  }
  // Skip pure opaque ids / bare numeric userIds (keep Chinese / mixed names)
  if (/^\d{8,}$/.test(text)) {
    return undefined;
  }
  if (/^[a-z0-9_./+=-]+$/i.test(text) && text.length > 16) {
    return undefined;
  }
  return text;
}

function loadSessionStoreEntry(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}) {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  try {
    const storeAgentId =
      params.agentId?.trim() || resolveAgentIdFromSessionKey(sessionKey) || "main";
    const storePath = resolveStorePath(params.cfg?.session?.store, { agentId: storeAgentId });
    const store = loadSessionStore(storePath, { skipCache: true });
    return resolveSessionStoreEntry({ store, sessionKey }).existing;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a friendly title for a session from the durable session store
 * (subject / origin.label / displayName — same titles shown in Control UI).
 */
export function resolveSessionHumanTitle(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): string | undefined {
  const entry = loadSessionStoreEntry(params);
  if (!entry) {
    return undefined;
  }
  return (
    cleanSessionDisplayTitle(entry.subject) ||
    cleanSessionDisplayTitle(entry.origin?.label) ||
    cleanSessionDisplayTitle(entry.displayName) ||
    cleanSessionDisplayTitle(entry.label) ||
    cleanSessionDisplayTitle(entry.groupChannel)
  );
}

/**
 * Best-effort: recover invoker id/name when the message-tool path did not get
 * requesterSender* (e.g. owner-stripped metadata, or incomplete tool wiring).
 *
 * Prefer the latest user turn's `__openclaw.senderId/Name`, then session origin.from.
 */
export async function resolveInvokerFromSourceSession(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): Promise<OutboundMessageInvoker | undefined> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const entry = loadSessionStoreEntry(params);
  const sessionFile =
    typeof entry?.sessionFile === "string" && entry.sessionFile.trim()
      ? entry.sessionFile.trim()
      : undefined;

  if (sessionFile) {
    try {
      let scanned = 0;
      for await (const line of streamSessionTranscriptLinesReverse(sessionFile)) {
        scanned += 1;
        if (scanned > 80) {
          break;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object") {
          continue;
        }
        const record = parsed as { message?: unknown; type?: unknown };
        const message =
          record.message && typeof record.message === "object"
            ? (record.message as Record<string, unknown>)
            : record.type === "message"
              ? (parsed as Record<string, unknown>)
              : null;
        if (!message || message.role !== "user") {
          continue;
        }
        const meta =
          message.__openclaw && typeof message.__openclaw === "object"
            ? (message.__openclaw as Record<string, unknown>)
            : null;
        if (!meta) {
          continue;
        }
        const id =
          typeof meta.senderId === "string" && meta.senderId.trim()
            ? meta.senderId.trim()
            : undefined;
        const name =
          typeof meta.senderName === "string" && meta.senderName.trim()
            ? meta.senderName.trim()
            : undefined;
        if (id || name) {
          return {
            ...(id ? { id } : {}),
            ...(name ? { name } : {}),
          };
        }
      }
    } catch {
      // fall through to origin
    }
  }

  // Group sessions often keep the last interactor on origin.from
  const originFrom =
    typeof entry?.origin?.from === "string" && entry.origin.from.trim()
      ? entry.origin.from.trim()
      : undefined;
  if (originFrom && !/^(group|channel|cid)/i.test(originFrom)) {
    // Prefer bare user-ish ids, not conversation ids
    const id = originFrom.includes(":")
      ? originFrom.split(":").pop()?.trim() || originFrom
      : originFrom;
    const nameFromLabel = cleanSessionDisplayTitle(entry?.origin?.label);
    // origin.label like "机器人测试群 id:1775" is a group title, not invoker nick — skip if it looks like group
    const name =
      nameFromLabel && !nameFromLabel.includes("群") && nameFromLabel !== id
        ? nameFromLabel
        : undefined;
    return {
      id,
      ...(name ? { name } : {}),
    };
  }
  return undefined;
}

function formatMediaHint(args: Record<string, unknown>): string | undefined {
  const media =
    args.media ??
    args.mediaUrl ??
    (Array.isArray(args.mediaUrls) ? args.mediaUrls : undefined) ??
    args.path ??
    args.filePath;
  if (media === undefined || media === null) {
    return undefined;
  }
  if (typeof media === "string") {
    const trimmed = media.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(media)) {
    const parts = media
      .map((entry) => (typeof entry === "string" ? entry.trim() : String(entry)))
      .filter(Boolean);
    return parts.length > 0 ? parts.join("、") : undefined;
  }
  return String(media);
}

function isGroupLikeChatType(chatType: string | undefined): boolean {
  return chatType === "group" || chatType === "channel";
}

function isDirectLikeChatType(chatType: string | undefined): boolean {
  return chatType === "direct" || chatType === "dm";
}

export type OutboundMessageTitleHints = {
  /** Human title of the source conversation (where message tool was used). */
  fromTitle?: string;
  /** Human title of the destination conversation (this session when writing target). */
  toTitle?: string;
  /**
   * Which session this row is written into.
   * - target: the conversation receiving the send (usual case)
   * - source: the session that invoked the message tool
   */
  audience?: "target" | "source";
};

const RELAY_FACT_PREAMBLE =
  "此条信息为他人调用我向当前对话的用户发送的信息。如果用户问你是谁向他发了消息、能否看到来源等，不需要调用 session 相关工具搜索确认——本条就是别人要求我转告当前对话用户的消息。以下是他发送的消息：";

const RELAY_FACT_PREAMBLE_SOURCE =
  "此条信息记录我按他人要求发出的内容，请不要调用 session 相关工具搜索确认，直接当成出站事实：";

/**
 * Hard constraint for message-tool target IDs (esp. DingTalk openConversationId
 * with trailing "==" / Base64 padding). Models often drop "==" or rewrite case.
 * Prefix handling (group:/user:) is left to the model.
 */
function buildRelayTargetIdRule(params: { groupId?: string; userId?: string }): string {
  const groupId = params.groupId?.trim();
  const userId = params.userId?.trim();
  // Strip accidental prefixes so examples focus on the raw id body.
  const rawGroup = groupId?.replace(/^(group:|channel:)/i, "") || "cid示例/完整Id必须含尾部==";
  const rawUser = userId?.replace(/^(user:|dm:)/i, "") || "完整调用人id";

  // Concrete wrong/right JSON — models copy examples more reliably than prose.
  const wrongGroup = rawGroup.endsWith("==")
    ? rawGroup.slice(0, -2)
    : `${rawGroup}（若你删掉了末尾==）`;
  const exampleRight = `{"action":"send","message":"……","target":"group:${rawGroup}"}`;
  const exampleWrong = `{"action":"send","message":"……","target":"group:${wrongGroup}"}`;

  return [
    "【强制：message 工具 target 里的 ID 必须字节级原样复制，禁止「美化」】",
    "把下面「来源群id / 调用人id」**整段原样**写进 target（可加前缀，但 ID 本体一个字符都不能改）：",
    "1. **禁止省略、截断、改写** 末尾的 `==`、`=`、中间的 `/`、`+` 等任意符号；Base64 填充 `==` 不是装饰，少一个就会投递失败。",
    "2. **禁止改大小写**（W/w、O/o 等必须与原文一致）。",
    "3. 不要凭记忆重打 ID，只允许从本条消息里逐字复制。",
    "",
    "【错误示例 — 绝对不要这样写（ID 末尾少了 ==）】",
    exampleWrong,
    "【正确示例 — ID 必须含末尾 ==（与来源群id 完全一致）】",
    exampleRight,
    "",
    "【可直接复制的 ID（原样进 target，尤其别漏 ==）】",
    groupId ? `- 群回复用的群 id = ${rawGroup}` : "",
    userId ? `- 私聊回复用的调用人 id = ${rawUser}` : "",
    "若 target 中的 ID 与上述字符串逐字比对不一致（尤其是末尾少了 ==），视为严重错误，发送前必须改对。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Reply guidance for the target session (the DM user who received a relayed
 * message). Embeds concrete ids so the agent does not need session tools.
 */
function buildRelayReplyGuidance(params: {
  fromIsGroup: boolean;
  sourceGroupId?: string;
  invokerId?: string;
  invokerName?: string;
  toTitle?: string;
}): string[] {
  const invokerLabel = params.invokerName?.trim() || "调用人";
  const recipientLabel = params.toTitle?.trim() || "当前对话的用户";
  const replyTemplate = `「${invokerLabel}，你发送的消息${recipientLabel}收到了，这是他给你的回复：\\n\\nxxxx」`;

  const groupId = (params.sourceGroupId?.trim() || "").replace(/^(group:|channel:)/i, "");
  const invokerId = (params.invokerId?.trim() || "").replace(/^(user:|dm:)/i, "");

  const lines: string[] = ["", "【回复指引】"];
  if (params.fromIsGroup) {
    lines.push(
      "若用户需要回复调用人，先询问他：要在群里回复，还是直接私聊通知他？",
      `- 群回复：用 message 工具，目标为【来源群id】原样复制：\`${groupId}\`（若以 == 结尾必须保留 ==，禁止省略）`,
      `- 私聊回复：用 message 工具，目标为【调用人id】原样复制：\`${invokerId}\``,
      "（再次强调：群 id 若以 == 结尾，target 里的 id 也必须带 ==；写成去掉 == 的短串是错误的。）",
    );
  } else {
    lines.push(
      "若用户需要回复调用人，可用 message 工具私聊通知他。",
      `- 私聊回复：用 message 工具，目标为【调用人id】原样复制：\`${invokerId}\``,
    );
  }
  lines.push(
    "发送给调用人时，文案可参考：",
    replyTemplate,
    "",
    buildRelayTargetIdRule({
      groupId: groupId || undefined,
      userId: invokerId || undefined,
    }),
  );
  return lines;
}

/**
 * Human + model readable transcript text (fixed field template).
 *
 * Group source → 来源群id / 来源群名 / 调用人… + 群/私聊回复指引
 * DM source    → 来源类型：私聊 / 来源用户… / 调用人…（妥当处理，不写「群」）
 */
export function formatOutboundMessageTranscriptText(
  payload: OutboundMessagePayload,
  titles?: OutboundMessageTitleHints,
): string {
  const args = payload.args;
  const body =
    typeof args.message === "string" && args.message.trim() ? args.message.trim() : undefined;
  const media = formatMediaHint(args);
  const audience = titles?.audience ?? "target";

  const fromIsGroup = isGroupLikeChatType(payload.from.chatType);
  const fromIsDirect = isDirectLikeChatType(payload.from.chatType);
  const sourceGroupId = fromIsGroup ? payload.from.peerId : undefined;
  const sourceGroupName = fromIsGroup
    ? titles?.fromTitle || cleanSessionDisplayTitle(payload.from.peerId)
    : undefined;
  const sourceUserId = fromIsDirect ? payload.from.peerId || payload.invoker?.id : undefined;
  const sourceUserName = fromIsDirect ? titles?.fromTitle || payload.invoker?.name : undefined;

  const invokerId = payload.invoker?.id || (fromIsDirect ? sourceUserId : undefined);
  const invokerName = payload.invoker?.name || (fromIsDirect ? sourceUserName : undefined);

  const preamble = audience === "source" ? RELAY_FACT_PREAMBLE_SOURCE : RELAY_FACT_PREAMBLE;

  const lines: string[] = [preamble, "", `内容：${body ?? ""}`, `附件：${media ?? ""}`];

  if (fromIsGroup) {
    lines.push(
      `来源群id：${sourceGroupId ?? ""}` +
        "（整段原样复制；若末尾有 == 必须保留，禁止省略任何符号或改大小写）",
    );
    lines.push(`来源群名：${sourceGroupName ?? ""}`);
  } else if (fromIsDirect) {
    lines.push("来源类型：私聊");
    lines.push(
      `来源用户id：${sourceUserId ?? ""}` + "（整段原样复制到 message.target，禁止改动任何字符）",
    );
    lines.push(`来源用户昵称：${sourceUserName ?? ""}`);
  } else {
    // Unknown source shape — still fill invoker; mark source generically.
    lines.push(`来源会话：${payload.from.sessionKey ?? ""}`);
    if (titles?.fromTitle) {
      lines.push(`来源名称：${titles.fromTitle}`);
    }
  }

  lines.push(`调用人id：${invokerId ?? ""}` + "（整段原样复制；禁止省略、改大小写）");
  lines.push(`调用人昵称：${invokerName ?? ""}`);

  // Strong reply guidance only for the receiving conversation (target).
  if (audience === "target") {
    lines.push(
      ...buildRelayReplyGuidance({
        fromIsGroup,
        sourceGroupId,
        invokerId,
        invokerName,
        toTitle: titles?.toTitle,
      }),
    );
  }

  lines.push("");
  lines.push("[原始信息]");
  lines.push(JSON.stringify(payload, null, 2));

  return lines.join("\n");
}

/** Look up from/to session titles for a payload (best-effort). */
export function resolveOutboundMessageTitles(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  payload: OutboundMessagePayload;
}): OutboundMessageTitleHints {
  return {
    fromTitle: resolveSessionHumanTitle({
      cfg: params.cfg,
      agentId: params.agentId ?? params.payload.from.agentId,
      sessionKey: params.payload.from.sessionKey,
    }),
    toTitle: resolveSessionHumanTitle({
      cfg: params.cfg,
      agentId: params.agentId ?? params.payload.to.agentId,
      sessionKey: params.payload.to.sessionKey,
    }),
  };
}

export type AppendOutboundMessageDeliveryContextParams = {
  cfg: OpenClawConfig;
  mode: MessageDeliveryContextMode;
  agentId?: string;
  sourceSessionKey?: string;
  sourceToolContext?: ChannelThreadingToolContext;
  sourceAccountId?: string | null;
  /** Human who invoked message tool (group member / DM peer). */
  invokerId?: string | null;
  invokerName?: string | null;
  targetTo: string;
  targetChannel: string;
  targetAccountId?: string | null;
  targetRoute?: OutboundSessionRoute | null;
  actionParams: Record<string, unknown>;
  action?: string;
  /** Shared idempotency key base; per-session suffix is applied. */
  idempotencyKey?: string;
};

function buildTranscriptAssistantMessage(params: {
  text: string;
  payload: OutboundMessagePayload;
  idempotencyKey?: string;
}) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: params.text }],
    api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
    provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
    model: OUTBOUND_MESSAGE_MODEL,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
    openclawOutboundMessage: params.payload,
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
  };
}

async function appendOne(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  text: string;
  payload: OutboundMessagePayload;
  idempotencyKey?: string;
}): Promise<void> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return;
  }
  try {
    const result = await appendExactAssistantMessageToSessionTranscript({
      agentId: params.agentId,
      sessionKey,
      config: params.cfg,
      idempotencyKey: params.idempotencyKey,
      message: buildTranscriptAssistantMessage({
        text: params.text,
        payload: params.payload,
        idempotencyKey: params.idempotencyKey,
      }),
    });
    if (!result.ok) {
      log.warn(`failed to append outbound_message delivery context: ${result.reason}`, {
        sessionKey,
      });
    }
  } catch (err) {
    log.warn(`failed to append outbound_message delivery context: ${formatErrorMessage(err)}`, {
      sessionKey,
    });
  }
}

/**
 * Best-effort append of outbound_message rows per deliveryContext mode.
 * Never throws; channel send has already succeeded.
 */
export async function appendOutboundMessageDeliveryContext(
  params: AppendOutboundMessageDeliveryContextParams,
): Promise<void> {
  if (params.mode === "off") {
    return;
  }

  let invokerId = params.invokerId?.trim() || undefined;
  let invokerName = params.invokerName?.trim() || undefined;
  if (!invokerId || !invokerName) {
    const recovered = await resolveInvokerFromSourceSession({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sourceSessionKey,
    });
    invokerId = invokerId || recovered?.id;
    invokerName = invokerName || recovered?.name;
  }

  const payload = buildOutboundMessagePayload({
    agentId: params.agentId,
    sourceSessionKey: params.sourceSessionKey,
    sourceToolContext: params.sourceToolContext,
    sourceAccountId: params.sourceAccountId,
    invokerId,
    invokerName,
    targetTo: params.targetTo,
    targetChannel: params.targetChannel,
    targetAccountId: params.targetAccountId,
    targetRoute: params.targetRoute,
    actionParams: params.actionParams,
    action: params.action,
  });
  const titles = resolveOutboundMessageTitles({
    cfg: params.cfg,
    agentId: params.agentId,
    payload,
  });
  const baseKey = params.idempotencyKey?.trim();

  const writes: Array<Promise<void>> = [];

  if (shouldWriteTargetDeliveryContext(params.mode)) {
    const targetKey = params.targetRoute?.sessionKey?.trim();
    if (targetKey) {
      const text = formatOutboundMessageTranscriptText(payload, {
        ...titles,
        audience: "target",
      });
      writes.push(
        appendOne({
          cfg: params.cfg,
          agentId: params.agentId,
          sessionKey: targetKey,
          text,
          payload,
          idempotencyKey: baseKey ? `${baseKey}:target` : undefined,
        }),
      );
    } else {
      log.warn("deliveryContext target requested but outbound route sessionKey is missing");
    }
  }

  if (shouldWriteSourceDeliveryContext(params.mode)) {
    const sourceKey = params.sourceSessionKey?.trim();
    if (sourceKey) {
      // Avoid double-write when source and target are the same session.
      const targetKey = params.targetRoute?.sessionKey?.trim();
      if (!targetKey || targetKey !== sourceKey) {
        const text = formatOutboundMessageTranscriptText(payload, {
          ...titles,
          audience: "source",
        });
        writes.push(
          appendOne({
            cfg: params.cfg,
            agentId: params.agentId,
            sessionKey: sourceKey,
            text,
            payload,
            idempotencyKey: baseKey ? `${baseKey}:source` : undefined,
          }),
        );
      }
    }
  }

  if (writes.length > 0) {
    await Promise.all(writes);
  }
}
