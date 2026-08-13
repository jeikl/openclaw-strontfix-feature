/** Handles /new and /reset command flows, including soft reset and ACP-bound sessions. */
import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { clearAllCliSessions } from "../../agents/cli-session.js";
import { resetConfiguredBindingTargetInPlace } from "../../channels/plugins/binding-targets.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { performGatewaySessionReset } from "../../gateway/session-reset-service.js";
import { logVerbose } from "../../globals.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveBoundAcpThreadSessionKey } from "./commands-acp/targets.js";
import { emitResetCommandHooks, type ResetCommandAction } from "./commands-reset-hooks.js";
import { parseSoftResetCommand } from "./commands-reset-mode.js";
import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";
import type { ReplySessionBinding } from "./get-reply.types.js";
import { isResetAuthorizedForContext } from "./reset-authorization.js";

const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));

function loadRouteReplyRuntime() {
  return routeReplyRuntimeLoader.load();
}

type InternalResetCommandOptions = NonNullable<HandleCommandsParams["opts"]> & {
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
};

function applyAcpResetTailContext(ctx: HandleCommandsParams["ctx"], resetTail: string): void {
  const mutableCtx = ctx as Record<string, unknown>;
  mutableCtx.Body = resetTail;
  mutableCtx.RawBody = resetTail;
  mutableCtx.CommandBody = resetTail;
  mutableCtx.BodyForCommands = resetTail;
  mutableCtx.BodyForAgent = resetTail;
  mutableCtx.BodyStripped = resetTail;
  // Mark the context so ACP dispatch continues with the post-reset tail, not the reset command.
  mutableCtx.AcpDispatchTailAfterReset = true;
}

function isResetAuthorized(params: HandleCommandsParams): boolean {
  return isResetAuthorizedForContext({
    ctx: params.ctx,
    cfg: params.cfg,
    commandAuthorized: params.command.isAuthorizedSender || params.ctx.CommandAuthorized === true,
  });
}

/** Handles reset/new commands or returns null when another command handler should continue. */
export async function maybeHandleResetCommand(
  params: HandleCommandsParams,
): Promise<CommandHandlerResult | null> {
  const softReset = parseSoftResetCommand(params.command.commandBodyNormalized);
  if (softReset.matched) {
    if (!isResetAuthorized(params)) {
      logVerbose(
        `Ignoring /reset soft from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }

    const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
    const boundAcpKey =
      boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey)
        ? boundAcpSessionKey.trim()
        : undefined;
    if (boundAcpKey) {
      return {
        shouldContinue: false,
        reply: { text: "Usage: /reset soft is not available for ACP-bound sessions yet." },
      };
    }

    const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
    const previousSessionEntry =
      params.previousSessionEntry ?? (targetSessionEntry ? { ...targetSessionEntry } : undefined);
    if (targetSessionEntry) {
      const now = Date.now();
      clearAllCliSessions(targetSessionEntry);
      if (params.sessionEntry && params.sessionEntry !== targetSessionEntry) {
        clearAllCliSessions(params.sessionEntry);
        params.sessionEntry.updatedAt = now;
        params.sessionEntry.lastInteractionAt = now;
      }
      if (params.sessionKey) {
        clearBootstrapSnapshot(params.sessionKey);
      }
      targetSessionEntry.updatedAt = now;
      targetSessionEntry.lastInteractionAt = now;
      if (params.sessionStore && params.sessionKey) {
        params.sessionStore[params.sessionKey] = targetSessionEntry;
      }
      if (params.storePath && params.sessionKey) {
        await updateSessionEntry(
          {
            storePath: params.storePath,
            sessionKey: params.sessionKey,
          },
          async (entry) => {
            const next = { ...entry };
            clearAllCliSessions(next);
            return {
              cliSessionBindings: next.cliSessionBindings,
              cliSessionIds: next.cliSessionIds,
              claudeCliSessionId: next.claudeCliSessionId,
              updatedAt: now,
              lastInteractionAt: now,
            };
          },
        );
      }
    }

    await emitResetCommandHooks({
      action: "reset",
      ctx: params.ctx,
      cfg: params.cfg,
      command: params.command,
      sessionKey: params.sessionKey,
      sessionEntry: targetSessionEntry,
      previousSessionEntry,
      workspaceDir: params.workspaceDir,
    });
    params.command.softResetTriggered = true;
    params.command.softResetTail = softReset.tail;
    return null;
  }

  const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset|clear)(?:\s|$)/i);
  if (!resetMatch) {
    return null;
  }
  if (!isResetAuthorized(params)) {
    logVerbose(
      `Ignoring /${resetMatch[1] ?? "reset"} from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const matched = resetMatch[1]?.toLowerCase() ?? "new";
  // /clear must use the same gateway reset as WebUI sessions.reset so channel and
  // Control UI share one transcript + stage-card cleanup path.
  if (matched === "clear") {
    if (!params.sessionKey?.trim()) {
      return {
        shouldContinue: false,
        reply: { text: "⚠️ Unable to clear chat history: missing session key." },
      };
    }
    // Capture delivery before reset: performGatewaySessionReset aborts the active
    // reply-run registry entry for this session, which would drop a normal command
    // reply returned via shouldContinue:false.
    const deliveryChannel = params.ctx.OriginatingChannel || params.command.channel;
    const deliveryTo = params.ctx.OriginatingTo || params.command.to || params.command.from;
    const clearResult = await performGatewaySessionReset({
      key: params.sessionKey,
      reason: "new",
      commandSource: `${params.command.surface ?? "text"}:/clear`,
      onCommitted: (commit) => {
        (params.opts as InternalResetCommandOptions | undefined)?.onSessionPrepared?.({
          sessionKey: commit.key,
          sessionId: commit.sessionId,
        });
      },
    });
    if (!clearResult.ok) {
      logVerbose(
        `channel /clear failed for ${params.sessionKey}: ${clearResult.error?.message ?? "unknown"}`,
      );
      return {
        shouldContinue: false,
        reply: { text: "⚠️ Failed to clear chat history. Try again in a moment." },
      };
    }
    params.command.resetHookTriggered = true;
    const ackText = "✅ Chat history cleared.";
    // Deliver ack out-of-band so channel users still get confirmation after the
    // reply-run was force-cleared by the session reset.
    if (deliveryChannel && deliveryTo) {
      try {
        const { routeReply } = await loadRouteReplyRuntime();
        await routeReply({
          payload: { text: ackText, isStatusNotice: true },
          channel: deliveryChannel,
          to: deliveryTo,
          sessionKey: clearResult.key,
          accountId: params.ctx.AccountId,
          requesterSenderId: params.command.senderId,
          requesterSenderName: params.ctx.SenderName,
          requesterSenderUsername: params.ctx.SenderUsername,
          requesterSenderE164: params.ctx.SenderE164,
          threadId: params.ctx.MessageThreadId,
          cfg: params.cfg,
          replyKind: "final",
        });
        return { shouldContinue: false };
      } catch (err) {
        logVerbose(`channel /clear routeReply failed: ${String(err)}`);
      }
    }
    // Fallback: return reply for callers that still have a live delivery path.
    return {
      shouldContinue: false,
      reply: { text: ackText },
    };
  }
  const commandAction: ResetCommandAction = matched === "reset" ? "reset" : "new";
  const resetTail = params.command.commandBodyNormalized.slice(resetMatch[0].length).trimStart();
  const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
  const boundAcpKey =
    boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey)
      ? boundAcpSessionKey.trim()
      : undefined;
  if (boundAcpKey) {
    const resetResult = await resetConfiguredBindingTargetInPlace({
      cfg: params.cfg,
      sessionKey: boundAcpKey,
      reason: commandAction,
      commandSource: `${params.command.surface}:${params.ctx.CommandSource ?? "text"}`,
    });
    if (!resetResult.ok) {
      logVerbose(`acp reset failed for ${boundAcpKey}: ${resetResult.error ?? "unknown error"}`);
    }
    if (resetResult.ok) {
      if (resetResult.sessionId) {
        (params.opts as InternalResetCommandOptions | undefined)?.onSessionPrepared?.({
          sessionKey: resetResult.sessionKey ?? boundAcpKey,
          sessionId: resetResult.sessionId,
          storePath: resetResult.storePath,
        });
      }
      params.command.resetHookTriggered = true;
      if (resetTail) {
        applyAcpResetTailContext(params.ctx, resetTail);
        if (params.rootCtx && params.rootCtx !== params.ctx) {
          applyAcpResetTailContext(params.rootCtx, resetTail);
        }
        return { shouldContinue: false };
      }
      return {
        shouldContinue: false,
        reply: { text: "✅ ACP session reset in place." },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: "⚠️ ACP session reset failed. Check /acp status and try again." },
    };
  }

  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;

  const hookResult = await emitResetCommandHooks({
    action: commandAction,
    ctx: params.ctx,
    cfg: params.cfg,
    command: params.command,
    sessionKey: params.sessionKey,
    sessionEntry: targetSessionEntry,
    previousSessionEntry: params.previousSessionEntry,
    workspaceDir: params.workspaceDir,
  });
  if (!resetTail) {
    return {
      shouldContinue: false,
      ...(hookResult.routedReply
        ? {}
        : {
            reply: {
              text: commandAction === "reset" ? "✅ Session reset." : "✅ New session started.",
            },
          }),
    };
  }
  return null;
}
