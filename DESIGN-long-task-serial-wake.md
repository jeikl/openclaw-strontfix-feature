# 长任务串行驻留

> 仓库：`openclaw-strontfix-feature`  
> 日期：2026-08-13  
> 状态：定稿（按最新需求）  
> 范围：`exec` / 技能长工具 / `sessions_spawn` 的等待、落盘、查询、上下文与配置

---

## 1. 目标

把「等一个跑很久的工具」从 **模型空转 poll** 改成 **运行时状态机**。

- 短轮询、长等待、计时、计数全部由代码完成，不占 CPU，不打大模型。
- 当前 turn **不结束**，普通用户消息继续入队；只有 `/stop` `/clear` `/new` 才能拆掉长任务换活。
- 终态以 **一条折叠过的 tool result** 回到同一轮：状态 + 耗时 + 摘要。历史完整，下一轮不被 N 条 `still running` 撑爆。
- 任务账本独立于 Gateway 进程落盘，可查询，有清理策略。
- 新配置字段写进 schema；旧二进制碰到不认识的键只警告忽略，不拒启动。

一句话：**模型只负责启动和下一步判断；等待是运行时的事。**

正确口径（不要再用旧稿「默认 2 次、还像模型 poll」）：

- `tools.longTask.shortPolls` **默认 4**，不是 2。
- 这 4 次是 **内部状态机** 的短轮询段（`short_polling`），事件等待、不占 CPU、**不转给模型**。
- 4 段仍没结束 → `long_running` 继续内部 park，turn 不结束。
- 只有完成 / 异常 / 超时才把 **一条折叠 tool result** 交回当前 turn。
- `/stop` `/clear` `/new` 拆等待、取消长任务、结束 turn。
- 普通用户消息继续入队，等这轮结束后再处理。

---

## 2. 背景与痛点

技能加载的代理委托通常变成：`exec` 拉起另一个 agent → 约 10s yield → 模型在同一轮反复 `process poll`。每次 poll 之后再把全量 OpenClaw 上下文打给模型。三十分钟任务会空转几十上百次。

模型性格还可能提前 `end_turn`（「做好了告诉你」）。lane 一空，下一则用户消息立刻开新回合。此时 `notifyOnExit` 只进 heartbeat：普通回合不消费 exec 事件、默认 30 分钟冷却、`target=none` 可能只回 `HEARTBEAT_OK`。回调激活不了原来的 agent。

`sessions_spawn` 已经能异步打到用户渠道，但完成包在 runtime context 里，下一轮会被剥掉。通知有了，主会话长期上下文没有。

现有 `task-registry` 已 sqlite 落盘，但 runtime 只有 `subagent | acp | cli | cron`，**exec / 技能长任务不建单**。process session 只在内存，重启即丢。

OpenClaw schema 对未知 JSON 键 `strict()`：新配置碰上旧二进制会拒启动、逼 `doctor --fix`。不友好。

---

## 3. 需求

| ID  | 需求                                                                |
| --- | ------------------------------------------------------------------- |
| R1  | 长任务有一等公民合同，不能靠模型空转 poll                           |
| R2  | 短轮询也是代码 loop，中间态不回模型                                 |
| R3  | 有未完成长任务时禁止 `end_turn`                                     |
| R4  | 完成 / 异常 / 超时必须回到 **当前** turn 的一次 tool result         |
| R5  | 保持现有「turn 未结束则消息入队、结束后处理下一则」                 |
| R6  | 短 poll 次数、段超时、长等待上限、保留期全部可配；有合理默认        |
| R7  | 长等待事件驱动、不占 CPU、有最大超时                                |
| R8  | `/stop` `/clear` `/new` 取消该会话全部长任务并结束当前 turn         |
| R9  | 除非用户强制停止，否则不处理其它业务                                |
| R10 | 账本独立于 Gateway 落盘；重启可查、可恢复                           |
| R11 | 长任务查询是一等公民（agent / 用户 / CLI），不靠 `process poll`     |
| R12 | 合理清理：活跃不删；终态 TTL；lost 短 TTL                           |
| R13 | 状态机：短轮询中 / 长任务执行中 / 完成 / 异常 / 超时（+ 取消）      |
| R14 | 上下文要完整但折叠：内部重复 poll 只记次数和耗时，终态写一条        |
| R15 | 下一个长任务再走同一循环                                            |
| R16 | 新 JSON 字段进 schema；未知字段警告忽略，不拒启动（已知遗留键除外） |
| R17 | spawn 通知渠道可保留；完成必须进不可剥的主会话记录（P2）            |

**非目标**

- 同一 session 两个主 agent 并行
- 长任务期间插队执行普通新业务
- harness 逼模型一直 poll
- 把 heartbeat 修成完成总线
- 给所有子代理无脑灌记忆
- 主路径依赖「先 end_turn 再新回合叫醒」（仅重启兜底）

---

## 4. 关键决策

| 决策       | 选择                           | 理由                             |
| ---------- | ------------------------------ | -------------------------------- |
| 串行       | 当前 turn 不结束，复用入队     | 不必另造任务锁                   |
| 换任务     | 仅 `/stop` `/clear` `/new`     | 普通消息只入队                   |
| 短轮询     | 代码 loop，默认 4 段           | 「still running」没有决策价值    |
| 长等待     | 同一状态机下一态，事件 park    | 零 LLM、零忙等                   |
| 回模型     | 只在终态回一次折叠 tool result | 历史完整且省 token               |
| 账本       | 扩现有 task-registry sqlite    | 不要第二份 JSON 账本             |
| 查询       | 读落盘，禁止为此再 poll        | 「好了吗」走 status              |
| 未知配置键 | 警告并忽略，不改文件、不拒启动 | 新配置可在旧二进制上跑           |
| 已知遗留键 | 仍报错，留给 doctor 迁移       | 避免 `memorySearch` 等静默丢搬家 |

---

## 5. 状态机

```text
                  ┌─ 正常退出 ─────────────────► succeeded     执行完成
                  │
  工具启动        ├─ 非零退出 / 崩溃 / 异常 ───► failed        执行异常
      │           │
      ▼           ├─ exec.timeout / 段内到期 ──► timed_out     执行超时
short_polling ────┤
  短轮询中        ├─ /stop /clear /new ────────► cancelled
  代码 loop×N     │
                  └─ N 段用尽仍 running ───────► long_running  长任务执行中
                                                      │
                         同样四个终态 ◄────────────────┘
                         succeeded | failed | timed_out(maxWaitMs) | cancelled
```

| 对外         | 落盘                                            | 谁在跑                               | 回模型                    |
| ------------ | ----------------------------------------------- | ------------------------------------ | ------------------------- |
| 短轮询中     | `short_polling`（或 `running` + `phase=short`） | `wait(exit, shortPollTimeoutMs)` × N | 否                        |
| 长任务执行中 | `long_running`（或 `running` + `phase=long`）   | `wait(exit, deadline, abort)`        | 否                        |
| 执行完成     | `succeeded`                                     | 无                                   | 是，一次折叠 tool result  |
| 执行异常     | `failed`                                        | 无                                   | 是                        |
| 执行超时     | `timed_out`                                     | 无                                   | 是                        |
| 用户打断     | `cancelled`                                     | 无                                   | 否（turn 被系统指令拆掉） |

短轮询：

```text
for i in 1..shortPolls:
  await waitUntilExit(shortPollTimeoutMs)   // 事件等待，禁止 250ms 空转
  if exited: → 终态，return
→ long_running
```

中间态只写账本，供查询。模型整条链只看见：**启动那一次 tool call** + **终态那一次折叠结果**。

---

## 6. 主路径

```text
用户：开发一个系统
  → 模型调用 exec / 长工具（仅此一次）
  → short_polling（代码，默认 4×10s）
        段内结束 → 折叠 tool result → 模型判断下一步
  → 仍 running → long_running（事件 park，最长 maxWaitMs）
        turn 仍 occupied
        普通消息 → 入队
        完成/异常/超时 → 折叠 tool result → 模型继续
        /stop /clear /new → cancelled + 拆 turn
  → 若模型再启动下一个长任务 → 同一状态机再走一轮
  → 本轮结束后，队列下一则才跑
```

有 running 长任务时，`end_turn` / `sessions_yield` 一律改 park，不放行 lane。

### 6.1 折叠后的会话上下文

内部记账（不回模型）：

```text
开始等待
short_poll #1 … #N     计数、分段耗时
long_running           累计耗时
终态
```

写入 transcript、下一轮模型看见的：

```text
assistant: 开始等待后台任务
tool: exec / 长工具（原始那一次）
tool result:
  shortPolls: 4
  shortPollElapsedMs: 38210
  phase: long_running → succeeded
  elapsedMs: 612034
  status: succeeded
  exitCode: 0
  summary: …截断输出
assistant: 根据结果继续；若还有下一个长任务，再循环
```

规则：

- 禁止落 N 条 `Process still running`
- 重复内部 poll 合并为 `shortPolls=N, elapsed=…`
- 长等待只在终态写一次 `{status, elapsedMs, summary}`
- 下一个长任务再开「一次调用 + 一次折叠结果」
- 质量不降：退出码、摘要、耗时都在

例外（二期）：进程 `waitingForInput` 时代码填不了 stdin。一期继续 park；需要人机交互再单独回一次「等输入」。

### 6.2 系统指令

| 指令            | 驻留中                                                     |
| --------------- | ---------------------------------------------------------- |
| `/stop`         | abort 等待；杀该 session 长任务；结束 turn；不自动开新业务 |
| `/clear` `/new` | 同上，再按原语义重置会话                                   |
| 其它 `/`        | 一期至少与 stop/clear/new 对齐：先拆长任务再执行           |

普通文本只入队。`/stop` 默认杀进程，避免幽灵代理；记录留到 TTL 可查。迟到的完成看到 `cancelled` 不再叫醒续作。

---

## 7. 配置

分两层：**openclaw.json（运营）** 和 **exec 工具参数（模型每次调用）**。

### 7.1 openclaw.json：`tools.longTask`（本仓库已进 schema）

路径：`src/config/types.tools.ts`、`src/config/zod-schema.agent-runtime.ts`。

全部可选。省略则用默认。

```json
{
  "tools": {
    "profile": "full",
    "exec": {
      "backgroundMs": 10000,
      "timeoutSec": 1800,
      "notifyOnExit": true,
      "notifyOnExitEmptySuccess": false
    },
    "longTask": {
      "shortPolls": 4,
      "shortPollTimeoutMs": 10000,
      "maxWaitMs": 1800000,
      "blockEndTurn": true,
      "retention": {
        "succeededMs": 604800000,
        "failedMs": 604800000,
        "lostMs": 86400000,
        "outputMs": 259200000
      }
    }
  }
}
```

| 键                                     | 类型 | 默认              | 约束          | 含义                                                             |
| -------------------------------------- | ---- | ----------------- | ------------- | ---------------------------------------------------------------- |
| `tools.longTask.shortPolls`            | int  | `4`               | 1–20          | 进入 `long_running` 前的**运行时**短轮询段数，不是模型 tool 次数 |
| `tools.longTask.shortPollTimeoutMs`    | int  | `10000`           | 100–60000     | 每一段最多等多少毫秒（事件等待）                                 |
| `tools.longTask.maxWaitMs`             | int  | `1800000`（30m）  | 1000–86400000 | `long_running` park 上限，到期 `timed_out`                       |
| `tools.longTask.blockEndTurn`          | bool | `true`            | —             | 仍有 running 长任务时禁止结束 turn                               |
| `tools.longTask.retention.succeededMs` | int  | `604800000`（7d） | ≥0            | 成功记录保留                                                     |
| `tools.longTask.retention.failedMs`    | int  | `604800000`（7d） | ≥0            | failed / timed_out / cancelled 保留                              |
| `tools.longTask.retention.lostMs`      | int  | `86400000`（24h） | ≥0            | lost 保留                                                        |
| `tools.longTask.retention.outputMs`    | int  | `259200000`（3d） | ≥0            | 完整输出文件保留，不超过记录 TTL                                 |

相关已有键（不是新设计，但和时间轴绑在一起）：

| 键                                    | 默认    | 含义                                                       |
| ------------------------------------- | ------- | ---------------------------------------------------------- |
| `tools.exec.backgroundMs`             | `10000` | 模型未传 `yieldMs` 时，前台先等这么久再后台化              |
| `tools.exec.timeoutSec`               | `1800`  | 模型未传 `timeout` 时，进程最长存活秒数，到期杀进程        |
| `tools.exec.notifyOnExit`             | `true`  | 启用长任务后只用来推进状态机并写盘，**不再走 heartbeat**   |
| `tools.exec.notifyOnExitEmptySuccess` | `false` | 长任务终态即使 stdout 为空也必须有终端态（实现时覆盖这条） |

建议补进 schema、尚未落地的可选键（不挡主路径）：

| 键                                   | 建议默认 | 含义                                       |
| ------------------------------------ | -------- | ------------------------------------------ |
| `tools.longTask.maxActivePerSession` | `8`      | 每 session 活跃长任务上限，超额拒绝新 park |

### 7.2 exec 工具参数（模型填，都不是 json 必填）

```json
{
  "command": "…",
  "workdir": "…",
  "yieldMs": 10000,
  "timeout": 1800,
  "background": false
}
```

| 字段         | 必填 | 默认来自                          | 含义                                                         |
| ------------ | ---- | --------------------------------- | ------------------------------------------------------------ |
| `command`    | 是   | —                                 | 命令                                                         |
| `workdir`    | 否   | 默认 cwd                          | 工作目录                                                     |
| `yieldMs`    | 否   | `tools.exec.backgroundMs` = 10000 | 前台先等多少 **毫秒** 再后台化，返回 `Command still running` |
| `timeout`    | 否   | `tools.exec.timeoutSec` = 1800    | 进程最长活多少 **秒**，到期杀。`0` = 不杀                    |
| `background` | 否   | false                             | `true` 则立刻后台，不再等 `yieldMs`                          |

三层时间不要混：

```text
yieldMs / backgroundMs     先盯一会儿再把控制权交给运行时状态机
shortPollTimeoutMs × N     代码短轮询
maxWaitMs                  长任务 park 上限
exec.timeout / timeoutSec  进程总寿命，到期杀进程
```

### 7.3 未知字段与 Gateway 启动

加载层（`validateConfigObjectRaw`）已改：

1. schema 仍 `strict()`，便于 doctor 识别键。
2. 遇到 **当前版本不认识的键**：从内存视图删掉，打警告，**不改磁盘文件**，继续启动。
3. 真类型错误（如 `port` 写成字符串）仍拒绝。
4. 已知遗留键（顶层 `memorySearch` / `heartbeat`、`sandbox.perSession` 等）仍报错，留给 doctor 迁移。

警告文案：

`Unrecognized key for this OpenClaw version; ignored at runtime. The config file was not modified.`

因此：新版 json 拿到尚未含 `tools.longTask` 行为的旧二进制上，只要装了本补丁，gateway 能启动；字段被忽略，长任务行为要等实现 PR 才生效。本仓库已登记 schema 后，本 fork 上写 `tools.longTask` 不会再告警。

---

## 8. 持久化、查询、清理

进入 `short_polling` 即 upsert sqlite。Gateway 只是读写者，文件在 state 目录。

最低字段：

```text
taskId
runtime: exec | longtask | subagent | …
status / phase
requesterSessionKey, ownerKey, agentId
delivery: channel, to, threadId, accountId
process: sessionId, pid, command summary
shortPolls, shortPollElapsedMs
maxWaitMs, deadlineAt
elapsedMs
progressSummary, terminalSummary
createdAt, startedAt, endedAt, lastEventAt, cleanupAfter
```

完整 stdout 走旁路文件；查询默认只带摘要。

| 谁       | 怎么查                                                                 |
| -------- | ---------------------------------------------------------------------- |
| 主 agent | `tasks_status` / `tasks_list`（本 session）。禁止为此再 `process poll` |
| 用户     | `/status`                                                              |
| 运维     | `openclaw tasks list/show`                                             |

驻留中「好了吗」：有查询后可只读回一条，不放行业务；未做前入队。

**清理**

| 状态                                      | 默认        | 说明                                 |
| ----------------------------------------- | ----------- | ------------------------------------ |
| `short_polling` / `long_running` / queued | 不按 TTL 删 | backing 没了 > 5min → `lost`         |
| succeeded                                 | 7d          | `retention.succeededMs`              |
| failed / timed_out / cancelled            | 7d          | `retention.failedMs`                 |
| lost                                      | 24h         | `retention.lostMs`                   |
| 输出文件                                  | 3d          | `retention.outputMs`，不超过记录 TTL |

`/new` `/clear` `/stop` 把活跃任务标 `cancelled`，记录留到 TTL。清理不动 transcript 里已写入的 tool result。sweeper 复用现有 60s 一轮。

**重启**

1. `loadSnapshot`
2. 活跃且 pid 还在 → 重挂 park
3. 人不在 → grace 后 `lost`，必要时补 **一轮** 叫醒（仅此时走新回合）
4. 已终态不重放通知

---

## 9. spawn 与 exec

|                    | `exec` / 技能长工具       | `sessions_spawn`                           |
| ------------------ | ------------------------- | ------------------------------------------ |
| 异步通知用户渠道   | 现在不可靠（heartbeat）   | **已经能打到渠道**                         |
| 进主会话长期上下文 | 无                        | 包在 runtime context，下一轮会剥           |
| 本设计             | 状态机 + 折叠 tool result | P2：完成改成不可剥的 transcript / 账本摘要 |

spawn 不必再造「通知用户」。缺的是主会话里删不掉的完成记录，以及可选记忆（`memory: none \| search \| inherit`）。

---

## 10. P 级

### P0

| ID   | 修什么                                                  |
| ---- | ------------------------------------------------------- |
| P0-1 | 有长任务禁止 `end_turn`；强制 park                      |
| P0-2 | 短轮询改代码 loop，中间态 0 次模型调用                  |
| P0-3 | 完成/异常/超时只 resolve 当前等待，一次折叠 tool result |

### P1

| ID   | 修什么                                      |
| ---- | ------------------------------------------- |
| P1-1 | `tools.longTask.*` 可配（schema 已加）      |
| P1-2 | 事件驱动等待，禁止 250ms 空转               |
| P1-3 | `/stop` `/clear` `/new` 取消长任务并拆 turn |
| P1-4 | 空成功、技能工具也要有终端态                |
| P1-5 | 进入短轮询即落盘                            |
| P1-6 | `tasks_status` / `tasks_list` / `/status`   |

### P2

| ID   | 修什么                                         |
| ---- | ---------------------------------------------- |
| P2-1 | 重启重挂或 lost + 补叫醒                       |
| P2-2 | 技能 `longRunning` / `tasks.complete` 同一合同 |
| P2-3 | spawn 完成进不可剥历史；子代理记忆可配         |
| P2-4 | 长任务期间禁用 steer，只入队                   |
| P2-5 | sweeper 按 retention 清理                      |

### P3

进入 park 提示、钉钉阶段文案、「好了吗」只读状态、折叠写入 transcript。

未知键警告忽略：**已在本仓库校验层落地**，不属于长任务运行时 PR。

---

## 11. PR 计划

| PR      | 覆盖           | 内容                                                             |
| ------- | -------------- | ---------------------------------------------------------------- |
| **PR0** | 配置友好       | 未知键警告忽略（已做）；`tools.longTask` schema + 默认值（已做） |
| **PR1** | P0-2           | exec yield 后代码短轮询；折叠计数；再 `process poll` 则拒        |
| **PR2** | P0-1/3, P1-2/5 | park、拦 `end_turn`、落盘、掐断 heartbeat、终态折叠 tool result  |
| **PR3** | P1-1/3/6       | 读配置；系统指令；查询工具                                       |
| **PR4** | P2-2, P1-4     | 技能合同，同一账本                                               |
| **PR5** | P2-1/5         | 重启重挂 + sweeper                                               |
| **PR6** | P2-3, P3       | spawn 上下文 + 记忆 + 体验                                       |

PR1+PR2 上线后：「性格停了 → 下一问进来 → 异步通知激活不了」应消失。

---

## 12. 关键文件

| 区域        | 路径                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------ |
| 长任务配置  | `src/config/types.tools.ts`、`zod-schema.agent-runtime.ts`、`schema.help.ts`、`schema.labels.ts` |
| 未知键加载  | `src/config/validation.ts`                                                                       |
| exec / poll | `src/agents/bash-tools.exec.ts`、`process.ts`、`exec-runtime.ts`                                 |
| 拦 end_turn | `src/agents/embedded-agent-runner/run/incomplete-turn.ts`                                        |
| 入队        | `src/auto-reply/reply/queue-policy.ts`                                                           |
| 假回调      | `src/infra/system-events.ts`、`heartbeat-runner.ts`                                              |
| 账本        | `src/tasks/task-registry*.ts`                                                                    |
| spawn       | `src/agents/subagent-announce.ts`、`workspace.ts`                                                |

---

## 13. 验收

1. 秒级命令：短轮询内结束，一次折叠结果，无 park。
2. 默认 4 段短轮询后仍 running：0 次额外模型调用，turn 不结束。
3. transcript 只有「一次启动 + 一条带 shortPolls/耗时/终态的 result」，没有 N 条 still running。
4. 驻留中「查邮箱」入队；完成后先收尾再跑队列。
5. 模型企图提前停：lane 不放行，完成后同一轮回复。
6. 完成 / 失败 / 到期：各一次 tool result。
7. `/stop` `/clear` `/new`：长任务 `cancelled`，turn 结束。
8. 改 `shortPolls` / `maxWaitMs` 立刻生效。
9. 钉钉回原会话，不是 HEARTBEAT_OK。
10. 重启后 `tasks show` 仍在；pid 在则重挂，不在则 lost。
11. running 不被 TTL 删；7d / 24h 清理符合 retention。
12. json 含本版本不认识的键：警告、启动成功、文件未被 doctor 改掉。
13. 本仓库写 `tools.longTask`：schema 接受，不告警。
14. 连续两个长任务：各走一遍状态机，上下文各一条折叠结果。

---

## 14. 风险与开放问题

| 风险                               | 缓解                          |
| ---------------------------------- | ----------------------------- |
| 驻留像死机                         | P3 提示 + `/stop`             |
| `steer` 在短轮询前把用户话打进模型 | 进入状态机后禁用 steer        |
| `maxWaitMs` 太短                   | 默认 30m，到期给 timeout 结果 |
| `sessions_yield` 放行 lane         | 有长任务时视为 park           |
| 未知键忽略丢掉该搬家的旧键         | 遗留键仍走 doctor             |

开放问题（不挡 P0）：

1. 驻留中「好了吗」一期入队，PR3 后只读。
2. 多 session 同一 agent：park / 查询按 session。
3. `maxActivePerSession` 是否进第一批 schema（建议 8）。
4. 折叠 tool result 的最大摘要长度（建议 4k 字符，全文走文件）。
