# 长任务串行驻留

> 仓库：`openclaw-strontfix-feature`  
> 日期：2026-08-14  
> 状态：定稿  
> 范围：`exec` 等待、落盘、查询、Gateway 停机与恢复

---

## 1. 目标

模型只负责启动和下一步判断；等待是运行时的事。

- `exec` 阻塞到命令结束，返回 **一条折叠 tool result**（状态、耗时、摘要）。
- 等待是事件驱动：进程退出通知、session 退出、或 `maxWaitMs` 超时。不占 CPU，不打大模型。
- 当前 turn 不结束。普通用户消息入队。`/stop` `/clear` `/new` 才能拆长任务。
- 任务账本落在 sqlite，用 `tasks_status` / `tasks_list` 查询。
- 未知配置键警告忽略，不拒启动。

---

## 2. 状态机

```text
工具启动
   ↓
long_running     事件等待，最长 maxWaitMs
   ├─ 正常退出              → succeeded
   ├─ 非零 / 崩溃           → failed
   ├─ timeout / 到期        → timed_out
   ├─ /stop /clear /new     → cancelled
   └─ 重启后找不到 pid      → lost（立刻终态，elapsed 停）
```

中间态只写账本。模型看见：**一次 exec 调用** + **一条终态折叠结果**。

---

## 3. 主路径

```text
用户：开发一个系统
  → 模型调用 exec（仅此一次）
  → long_running（事件 park，最长 maxWaitMs）
        turn 仍 occupied
        普通消息 → 入队
        完成/异常/超时 → 折叠 tool result → 模型继续
        /stop /clear /new → cancelled + 拆 turn
  → 本轮结束后，队列下一则才跑
```

有 running 长任务时，`end_turn` / `sessions_yield` 一律 park，不放行 lane。

折叠结果写入 transcript：

```text
phase: long_running → succeeded
elapsedMs: 612034
status: succeeded
exitCode: 0
sessionId: …
outputPath: ~/.openclaw/state/exec-output/<sessionId>.log
summary: …
```

完整输出只落盘。上下文挤的时候，`exec` 历史条 soft-trim 留头 1000 / 尾 4000；再挤则换成带 `outputPath` 的占位符，模型用 `read` 打开全文。其他工具仍是头尾各 1500。

---

## 4. 配置

`tools.longTask`（全部可选）：

```json
{
  "tools": {
    "longTask": {
      "maxWaitMs": 1800000,
      "blockEndTurn": true,
      "retention": {
        "succeededDays": 7,
        "failedDays": 7,
        "lostDays": 1,
        "outputDays": 3
      }
    }
  }
}
```

| 键                        | 默认             | 含义                                |
| ------------------------- | ---------------- | ----------------------------------- |
| `maxWaitMs`               | `1800000`（30m） | 事件等待上限，到期 `timed_out`      |
| `blockEndTurn`            | `true`           | 仍有 running 长任务时禁止结束 turn  |
| `retention.succeededDays` | `7`              | 成功记录保留（天，可小数）          |
| `retention.failedDays`    | `7`              | failed / timed_out / cancelled 保留 |
| `retention.lostDays`      | `1`              | lost 保留                           |
| `retention.outputDays`    | `3`              | 完整输出文件保留                    |

exec 参数：

| 字段         | 默认                              | 含义                             |
| ------------ | --------------------------------- | -------------------------------- |
| `yieldMs`    | `tools.exec.backgroundMs` = 10000 | 前台先盯这么久，再交给运行时等待 |
| `timeout`    | `tools.exec.timeoutSec` = 1800    | 进程最长存活秒数                 |
| `background` | false                             | `true` 则立刻交给运行时等待      |

时间轴：

```text
yieldMs / backgroundMs     前台先盯一会儿
maxWaitMs                  运行时等待上限
exec.timeout / timeoutSec  进程总寿命
```

---

## 5. 查询

| 谁       | 怎么查                                      |
| -------- | ------------------------------------------- |
| 主 agent | `tasks_status` / `tasks_list`（本 session） |
| 用户     | `/status`                                   |
| 运维     | `openclaw tasks list/show`                  |

`process` 保留 list / log / write / send-keys / submit / paste / kill。`process poll` 已去掉；等待由 exec 内部完成。

终态任务查询不带 in-progress 的 `phase`。记录带 `runtime`。

---

## 6. Gateway 停机

| 方式                               | 行为                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Ctrl+C` / `openclaw gateway stop` | 意图是优雅停：exec 继续跑；启动后按原 `startedAt` 重挂，输出写回原 tool 卡片，叫醒该会话                                        |
| 启动时 pid 已死                    | 立刻 `lost`。elapsed 用输出文件 mtime（没有则用发现时刻），写回已有输出并通知该会话。`lost` 表示结果无法回收，不是精确的 failed |
| `openclaw gateway stop --force`    | 强制停：杀掉所有 agent 会话里还在跑的 exec，账本 `cancelled`；启动后不重挂、不叫醒                                              |

exec 输出落在 `~/.openclaw/state/exec-output/<sessionId>.log`，重挂完成或发现进程已死后写回对应 `toolCallId` 的 tool result。

Gateway 挂在 IDE 终端里时，Ctrl+C / 重启仍可能把 exec 一起带走（进程组 / stdout 管道）。那种情况下走「启动时 pid 已死」而不是重挂。

---

## 7. 系统指令

| 指令            | 驻留中                                     |
| --------------- | ------------------------------------------ |
| `/stop`         | abort 等待；杀该 session 长任务；结束 turn |
| `/clear` `/new` | 同上，再按原语义重置会话                   |

普通文本只入队。长任务期间禁用 steer。

---

## 8. 验收

1. 秒级命令：一次折叠结果。
2. 长命令：0 次额外模型调用，turn 不结束，完成后再回一条折叠 result。
3. `process poll` 被拒绝，提示用 `tasks_status` / `tasks_list`。
4. 驻留中「查邮箱」入队；完成后先收尾再跑队列。
5. `/stop` `/clear` `/new`：长任务 `cancelled`，turn 结束。
6. 改 `maxWaitMs` 立刻生效。
7. 优雅停机后启动：卡片和 turn 按原计时恢复。
8. `--force` 停机后启动：不叫醒任何 turn。
