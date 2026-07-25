import { describe, expect, it } from "vitest";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../shared/transcript-only-openclaw-assistant.js";
import {
  OUTBOUND_MESSAGE_MODEL,
  OUTBOUND_MESSAGE_TYPE,
  buildOutboundMessagePayload,
  cleanSessionDisplayTitle,
  formatOutboundMessageTranscriptText,
  resolveMessageDeliveryContextMode,
  shouldSkipDeliveryMirrorForSend,
  shouldWriteSourceDeliveryContext,
  shouldWriteTargetDeliveryContext,
  snapshotMessageToolArgs,
} from "./outbound-delivery-context.js";

describe("resolveMessageDeliveryContextMode", () => {
  it("defaults to target", () => {
    expect(resolveMessageDeliveryContextMode({ cfg: {} })).toBe("target");
    expect(
      resolveMessageDeliveryContextMode({
        cfg: { tools: { message: {} } },
      }),
    ).toBe("target");
  });

  it("reads global and agent override", () => {
    expect(
      resolveMessageDeliveryContextMode({
        cfg: { tools: { message: { deliveryContext: "off" } } },
      }),
    ).toBe("off");
    expect(
      resolveMessageDeliveryContextMode({
        cfg: {
          tools: { message: { deliveryContext: "target" } },
          agents: {
            list: [{ id: "main", tools: { message: { deliveryContext: "both" } } }],
          },
        },
        agentId: "main",
      }),
    ).toBe("both");
  });
});

describe("delivery context mode helpers", () => {
  it("maps target/source/both/off", () => {
    expect(shouldWriteTargetDeliveryContext("target")).toBe(true);
    expect(shouldWriteTargetDeliveryContext("both")).toBe(true);
    expect(shouldWriteTargetDeliveryContext("source")).toBe(false);
    expect(shouldWriteTargetDeliveryContext("off")).toBe(false);

    expect(shouldWriteSourceDeliveryContext("source")).toBe(true);
    expect(shouldWriteSourceDeliveryContext("both")).toBe(true);
    expect(shouldWriteSourceDeliveryContext("target")).toBe(false);

    expect(shouldSkipDeliveryMirrorForSend("target")).toBe(true);
    expect(shouldSkipDeliveryMirrorForSend("both")).toBe(true);
    expect(shouldSkipDeliveryMirrorForSend("source")).toBe(false);
    expect(shouldSkipDeliveryMirrorForSend("off")).toBe(false);
  });
});

describe("snapshotMessageToolArgs", () => {
  it("keeps original media params and drops internal keys", () => {
    const args = snapshotMessageToolArgs({
      actionParams: {
        action: "send",
        to: "user:u1",
        message: "hello",
        media: "https://intranet.example/a.png",
        mediaUrl: "/mnt/share/photo.jpg",
        mediaUrls: ["https://cdn.example/b.png"],
        __sessionKey: "agent:main:dingtalk:group:g1",
        __agentId: "main",
      },
      channel: "dingtalk-connector",
    });

    expect(args).toEqual({
      action: "send",
      to: "user:u1",
      message: "hello",
      media: "https://intranet.example/a.png",
      mediaUrl: "/mnt/share/photo.jpg",
      mediaUrls: ["https://cdn.example/b.png"],
      channel: "dingtalk-connector",
    });
    expect(args).not.toHaveProperty("__sessionKey");
    expect(JSON.stringify(args)).not.toContain("mediaId");
  });
});

describe("buildOutboundMessagePayload", () => {
  it("includes full args plus from/to channel identity", () => {
    const payload = buildOutboundMessagePayload({
      agentId: "main",
      sourceSessionKey: "agent:main:webchat:direct:operator",
      sourceToolContext: {
        currentChannelProvider: "webchat",
        currentChannelId: "operator",
      },
      sourceAccountId: "acct-src",
      targetTo: "group:cidOpenConv",
      targetChannel: "dingtalk-connector",
      targetAccountId: "acct-dst",
      targetRoute: {
        sessionKey: "agent:main:dingtalk-connector:group:cidOpenConv",
        baseSessionKey: "agent:main:dingtalk-connector:group:cidOpenConv",
        peer: { kind: "group", id: "cidOpenConv" },
        chatType: "group",
        from: "dingtalk-connector:group:cidOpenConv",
        to: "dingtalk-connector:group:cidOpenConv",
      },
      actionParams: {
        action: "send",
        to: "group:cidOpenConv",
        message: "请看图",
        media: "https://intranet.example/chart.png",
      },
      action: "send",
    });

    expect(payload.type).toBe(OUTBOUND_MESSAGE_TYPE);
    expect(payload.from).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:webchat:direct:operator",
      channel: "webchat",
      accountId: "acct-src",
      peerId: "operator",
    });
    expect(payload.to).toMatchObject({
      raw: "group:cidOpenConv",
      sessionKey: "agent:main:dingtalk-connector:group:cidOpenConv",
      channel: "dingtalk-connector",
      accountId: "acct-dst",
      peerId: "cidOpenConv",
      chatType: "group",
    });
    expect(payload.args).toMatchObject({
      action: "send",
      message: "请看图",
      media: "https://intranet.example/chart.png",
      to: "group:cidOpenConv",
    });
    expect(JSON.stringify(payload)).not.toMatch(/mediaId/i);
  });

  it("formats group-origin relay template with invoker fields", () => {
    const payload = buildOutboundMessagePayload({
      agentId: "main",
      sourceSessionKey: "agent:main:dingtalk-connector:group:cid123",
      invokerId: "staff-1",
      invokerName: "不是不是来夫人",
      targetTo: "user:u1",
      targetChannel: "dingtalk-connector",
      targetRoute: {
        sessionKey: "agent:main:dingtalk-connector:direct:u1",
        baseSessionKey: "agent:main:dingtalk-connector:direct:u1",
        peer: { kind: "direct", id: "u1" },
        chatType: "direct",
        from: "dingtalk-connector:u1",
        to: "dingtalk-connector:u1",
      },
      actionParams: { message: "我是宝宝", media: "/mnt/share/a.png" },
      action: "send",
    });
    payload.from.chatType = "group";
    payload.from.peerId = "cid123";

    const text = formatOutboundMessageTranscriptText(payload, {
      fromTitle: "机器人测试群",
      audience: "target",
    });
    expect(text).toContain(
      "此条信息为他人调用我向当前对话的用户发送的信息。如果用户问你是谁向他发了消息、能否看到来源等，不需要调用 session 相关工具搜索确认",
    );
    expect(text).toContain("内容：我是宝宝");
    expect(text).toContain("附件：/mnt/share/a.png");
    expect(text).toContain("来源群id：cid123");
    expect(text).toContain("来源群名：机器人测试群");
    expect(text).toContain("调用人id：staff-1");
    expect(text).toContain("调用人昵称：不是不是来夫人");
    expect(text).toContain("【回复指引】");
    expect(text).toContain("要在群里回复，还是直接私聊通知他");
    expect(text).toContain("目标设定为【来源群id】原样复制：cid123");
    expect(text).toContain("目标设定为【调用人id】原样复制：staff-1");
    expect(text).toContain("【重要：目标 ID 填写约束】");
    expect(text).toContain("严禁遗漏、截断或修改尾部的 ==、= 等任何特殊符号");
    expect(text).toContain("不是不是来夫人，你发送的消息当前对话的用户收到了，这是他给你的回复");
    expect(text).toContain("[原始信息]");
    expect(text).not.toContain("来源类型：私聊");
    expect(text).toContain('"type": "outbound_message"');

    const message = {
      role: "assistant",
      provider: "openclaw",
      model: OUTBOUND_MESSAGE_MODEL,
      content: [{ type: "text", text }],
    };
    expect(isTranscriptOnlyOpenClawAssistantMessage(message)).toBe(false);
  });

  it("formats DM-origin template without group fields", () => {
    const payload = buildOutboundMessagePayload({
      agentId: "main",
      sourceSessionKey: "agent:main:dingtalk-connector:direct:staff-9",
      invokerId: "staff-9",
      invokerName: "小明",
      targetTo: "user:u2",
      targetChannel: "dingtalk-connector",
      targetRoute: {
        sessionKey: "agent:main:dingtalk-connector:direct:u2",
        baseSessionKey: "agent:main:dingtalk-connector:direct:u2",
        peer: { kind: "direct", id: "u2" },
        chatType: "direct",
        from: "dingtalk-connector:u2",
        to: "dingtalk-connector:u2",
      },
      actionParams: { message: "你好" },
      action: "send",
    });
    payload.from.chatType = "direct";
    payload.from.peerId = "staff-9";

    const text = formatOutboundMessageTranscriptText(payload, {
      fromTitle: "小明",
      audience: "target",
    });
    expect(text).toContain("来源类型：私聊");
    expect(text).toContain("来源用户id：staff-9");
    expect(text).toContain("来源用户昵称：小明");
    expect(text).toContain("调用人id：staff-9");
    expect(text).toContain("调用人昵称：小明");
    expect(text).toContain("内容：你好");
    expect(text).toContain("【回复指引】");
    expect(text).toContain("目标设定为【调用人id】原样复制：staff-9");
    expect(text).toContain("【重要：目标 ID 填写约束】");
    expect(text).toContain("严禁遗漏、截断或修改尾部的 ==、= 等任何特殊符号");
    expect(text).not.toContain("来源群id");
    expect(text).not.toContain("来源群名");
    expect(text).not.toContain("要在群里回复");
  });

  it("cleans Control UI style display names", () => {
    expect(cleanSessionDisplayTitle("dingtalk-connector:g-机器人测试群")).toBe("机器人测试群");
    expect(cleanSessionDisplayTitle("机器人测试群 id:17751800930235214")).toBe("机器人测试群");
    expect(cleanSessionDisplayTitle("不是不是来夫人")).toBe("不是不是来夫人");
  });
});
