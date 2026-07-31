/** @deprecated Compatibility subpath. Use `openclaw/plugin-sdk/channel-outbound`. */
export {
  buildOutboundSessionContext,
  createOutboundPayloadPlan,
  createReplyToFanout,
  createRuntimeOutboundDelegates,
  projectOutboundPayloadPlanForDelivery,
  resolveAgentOutboundIdentity,
  resolveOutboundSendDep,
  sanitizeForPlainText,
} from "./channel-outbound.js";
export type {
  OutboundDeliveryFormattingOptions,
  OutboundIdentity,
  OutboundSendDeps,
  OutboundSessionContext,
  ReplyToResolution,
} from "./channel-outbound.js";

/** @deprecated Direct outbound delivery is compatibility/runtime substrate. */
export { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
/** @deprecated Direct outbound delivery params are compatibility/runtime substrate. */
export type { DeliverOutboundPayloadsParams } from "../infra/outbound/deliver.js";
export { type OutboundDeliveryResult } from "../infra/outbound/deliver.js";

/**
 * OC-4: after a successful outbound send (message tool or channel-side hooks such as
 * DWS CLI send), append a model-visible + gateway-visible outbound_message row.
 * Safe to call best-effort after delivery already succeeded.
 */
export {
  appendOutboundMessageDeliveryContext,
  resolveMessageDeliveryContextMode,
  OUTBOUND_MESSAGE_TYPE,
  OUTBOUND_MESSAGE_MODEL,
} from "../infra/outbound/outbound-delivery-context.js";
export type {
  AppendOutboundMessageDeliveryContextParams,
  OutboundMessagePayload,
  OutboundMessageParty,
  OutboundMessageInvoker,
} from "../infra/outbound/outbound-delivery-context.js";

/** Resolve / ensure session routes for outbound targets (group:/user:/…). */
export {
  resolveOutboundSessionRoute,
  ensureOutboundSessionEntry,
} from "../infra/outbound/outbound-session.js";
export type {
  OutboundSessionRoute,
  ResolveOutboundSessionRouteParams,
} from "../infra/outbound/outbound-session.js";
