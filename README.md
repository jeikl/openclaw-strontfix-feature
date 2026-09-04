# 🦞 JeikClaw — OpenClaw 增强版

<p align="center">
  <strong>JeikClaw</strong> = <a href="https://github.com/openclaw/openclaw">OpenClaw</a> 社区增强 Fork
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/jeikclaw"><img src="https://img.shields.io/npm/v/jeikclaw.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/jeikclaw"><img src="https://img.shields.io/npm/dm/jeikclaw.svg?style=flat&colorA=18181B&colorB=28CF8D&cacheSeconds=0" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="README.en.md">🇺🇸 English</a> •
  <a href="https://openclaw.ai/">OpenClaw 官网</a> •
  <a href="https://docs.openclaw.ai/">文档</a>
</p>

---

**JeikClaw** 基于 [OpenClaw](https://github.com/openclaw/openclaw) 社区维护，在保留原版全部能力的基础上，重点增强：

- 🛠️ **长任务管理体系** — 串行驻留 + 事件等待，告别模型轮询
- 🎨 **阶段卡 & 思考卡** — 实时 pipeline 阶段可视化，思考过程透明
- 🔧 **工具卡 UI** — 调用即显示输入，按 callId 配对输出
- ⏹️ **/stop 命令穿透** — 毫秒级终止长任务 + 强制杀残留进程
- 🐛 **incomplete 误报消除** — 智能过滤后台 exec / 工具成功后的误报
- ⚡ **致命性能修复** — 消除 O(N²) CPU 卡死，会话历史修复流水线优化
- 🖼️ **图片 & 媒体增强** — 公网 URL 直传 / 内网 Base64 降级 / file:// 协议支持
- 🔌 **与原版完全共存** — 独立 bin 命令 `jeikclaw`，不覆盖 `openclaw`

---

## 安装

运行环境：**Node 24.15+（推荐）、Node 22.22.3+ 或 Node 25.9+**

```bash
npm install -g jeikclaw@latest
# 或
pnpm add -g jeikclaw@latest

jeikclaw onboard --install-daemon
```

> `jeikclaw` 和 `openclaw` 可以同时安装、互不冲突。两者使用不同的全局 bin 命令。

升级：

```bash
npm update -g jeikclaw
jeikclaw doctor
```

---

## 最近核心增强（2026.07 – 2026.09）

### 🛠️ 长任务管理体系

| 能力          | 说明                                                  |
| ------------- | ----------------------------------------------------- |
| **串行驻留**  | 长任务（bash/exec/Cron）串行排队执行，不会并发击穿    |
| **事件等待**  | 用事件通知取代模型短轮询（short-poll），减少 CPU 空转 |
| **重启台账**  | Gateway 重启后自动恢复长任务台账，不丢失执行状态      |
| **exec 裁剪** | 后台 exec 任务结束后自动裁剪，防止残留进程            |

### ⏹️ /stop 命令穿透

`/stop`、`/abort`、`停止` 等命令支持穿透入站队列：

- 毫秒级调用 `chat.abort` 终止底层 Agent 与运行进程
- 自动作废当前会话已排队的后续任务，防止幽灵唤醒
- 强制杀掉残留 bash/exec 子进程
- 中止卡片文案：`🛑 正在停止当前任务…` → `🛑 任务已中止`

### 🎨 阶段卡 & 思考卡

| 功能                       | 说明                                                |
| -------------------------- | --------------------------------------------------- |
| **Pipeline 阶段标签**      | 每个阶段（reasoning / tool_call / reply）带独立计时 |
| **阶段卡持久化**           | 阶段卡与思考卡服务端落盘，WebUI 刷新后恢复          |
| **远程 WebUI 同步**        | 阶段卡通过 gateway server-side 持久化，远程访问一致 |
| **折叠 + 多轮配色**        | 思考过程可折叠，多轮对话自动分配不同颜色            |
| **reasoning_content 透传** | 始终透传模型的 `reasoning_content` 字段到流式输出   |

### 🔧 工具卡 UI

- 工具调用时**立即显示输入参数**，不需要等到完成
- 按 `callId` 配对输出，多个并行工具调用互不干扰
- 工具卡按阶段落盘，WebUI 刷新后恢复输入和输出
- 独立运行状态指示

### 🐛 incomplete 误报消除

| 场景                            | 修复                           |
| ------------------------------- | ------------------------------ |
| 工具成功后空回答                | 允许续写，避免 incomplete 误杀 |
| `payloads=1` pre-tool 后空 stop | 覆盖 incomplete 判定           |
| 后台 exec 假终止                | 不再误报 incomplete            |
| exec 业务失败                   | 不升级为 error final           |
| `incomplete_turn` 误报          | 智能过滤，已有真实答案时不覆盖 |

### ⚡ 致命性能修复

- **O(N²) 消除** — 索引化 `collectFollowingToolResults`，消除 repair 残留 O(N²) 瓶颈
- **CPU 卡死修复** — 会话历史修复流水线中导致 CPU 卡死的 O(N²) 性能问题
- **事件循环让出** — `sanitizeSessionHistory` 分阶段让出事件循环，防止阻塞
- **死循环防护** — 限制 `allocateOpenAIStyleId` 循环上界

### 🖼️ 图片 & 媒体增强

- **公网 URL 直传** — 图片输入支持公网 URL 直接提交给大模型
- **内网 Base64 降级** — 内网 URL 自动降级为 Base64 编码
- **file:// 协议** — 支持中文路径 / 空格 URL 解码
- **非工作区路径** — 放行非工作区绝对路径图片读取

### 🔌 其他增强

| 功能                  | 说明                                                         |
| --------------------- | ------------------------------------------------------------ |
| **jeikclaw bin 隔离** | 全局命令为 `jeikclaw`，与原版 `openclaw` 完全共存            |
| **plugins inspect**   | 优先显示 `package.json` 版本，而非 manifest 版本             |
| **outbound 上下文**   | message 工具发送后自动注入 model-visible 的 delivery context |
| **target ID 规则**    | 强化 outbound 消息 target ID 保留 Base64 后缀与大小写        |
| **DNS / DoH**         | DNS-over-HTTPS 绕过软路由 53 端口劫持                        |
| **GPT-5.6 Ultra**     | 支持 GPT-5.6 Ultra 跨 OpenClaw 和 Codex 运行时               |

---

## OpenClaw 原版能力

JeikClaw 保留 OpenClaw 的全部能力：

- **多渠道收件箱** — WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、IRC、Microsoft Teams、Matrix、飞书、LINE、Mattermost、Nostr、钉钉、QQ 等 20+ 渠道
- **语音唤醒 + Talk** — macOS/iOS 唤醒词 + Android 持续语音
- **Live Canvas** — Agent 驱动的可视化工作区
- **工具体系** — 浏览器、Canvas、Nodes、Cron、Sessions
- **多 Agent 路由** — 渠道/账号/对端 → 独立 Agent 路由
- **伴侣应用** — Windows Hub、macOS 菜单栏、iOS/Android 节点

---

## 快速开始

```bash
# 安装
npm install -g jeikclaw@latest

# 引导配置（交互式，推荐）
jeikclaw onboard --install-daemon

# 检查状态
jeikclaw gateway status

# 前台调试模式
jeikclaw gateway stop
jeikclaw gateway --port 18789 --verbose
```

### 从源码构建（开发）

```bash
git clone https://github.com/jeikl/openclaw-strontfix-feature.git
cd openclaw-strontfix-feature

pnpm install
pnpm openclaw setup

# 预构建 Control UI
pnpm ui:build

# 开发循环（自动热重载）
pnpm gateway:watch

# 极速后端构建
pnpm build:fast
```

---

## 配置

最简配置 `~/.openclaw/openclaw.json`：

```json5
{
  agent: {
    model: "<provider>/<model-id>",
  },
}
```

[完整配置参考](https://docs.openclaw.ai/gateway/configuration)

---

## 相关项目

| 项目                                                                                       | 说明                                                                                                                         |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| [OpenClaw](https://github.com/openclaw/openclaw)                                           | 原版 OpenClaw                                                                                                                |
| [钉钉连接器（社区版）](https://github.com/jeikl/dingtalk-openclaw-connector-fix-Community) | `@jeik/dingtalk-connector` — 钉钉社区增强版插件                                                                              |
| [JeikCode](https://github.com/jeikl/jeikcode)                                              | 极速、自主的终端 AI Coding Agent（Rust 驱动）— 更好的上下文管理与模型编程性能，代码索引超越 Codex / Grok Build / Claude Code |

> 🤖 **搭配 [JeikCode](https://github.com/jeikl/jeikcode) 使用效果更佳**：Rust 原生内核、自研 CodeExplore 加权 AST + 中英双语语义检索（效率 +60–70%、准确率 90%+）、严格 Append-Only KV Cache 保护（`sacred_floor` + `user-wrap.md`）、五级工具自愈链与 Loop Guard 熔断。安装：`curl -fsSL https://raw.githubusercontent.com/jeikl/jeikcode/local-dev/scripts/install.sh | bash`

---

## 许可证

[MIT](LICENSE) — 基于 OpenClaw，同许可证。
