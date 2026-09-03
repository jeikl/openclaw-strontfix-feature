# 长任务串行驻留 · 已做 / 剩余

> 仓库：`/root/src-dev/openclaw-strontfix-feature`  
> 设计稿：`DESIGN-long-task-serial-wake.md`  
> 日期：2026-08-17  
> 版本：2026.7.780

---

## 0. 口径

- `exec` 阻塞到命令结束，事件等待，最长 `maxWaitMs`。等待和进程寿命只认配置，模型 `timeout` / `yieldMs` / `background` 忽略。
- 只有完成 / 异常 / 超时才把一条折叠 tool result 交回当前 turn。
- `/stop` `/clear` `/new` 拆等待、杀进程、结束 turn。诊断 stuck-session / idle watchdog 不得杀长任务。
- 普通用户消息入队。
- 查询用 `tasks_status` / `tasks_list`。`process poll` 已去掉。
- 同一轮并行工具可以跑；用户下一句话串行入队。

---

## 1. 已落地

`8484d2cf8a` 及之后的工作区改动：

| 内容                                                                                                 |
| ---------------------------------------------------------------------------------------------------- |
| exec 交给运行时事件等待（最长 `maxWaitMs`），一条折叠 tool result                                    |
| `tools.longTask`：`maxWaitMs`、`blockEndTurn`、按天 retention                                        |
| `/stop` `/clear` `/new` 取消 waiter；759：`/stop` 与 WebUI Stop 强制 SIGKILL 残留 bash/exec          |
| task-registry `runtime=exec`，`tasks_status` / `tasks_list`                                          |
| 完成通知立刻结束等待                                                                                 |
| 优雅停机重挂：原 `startedAt` 接着算；输出写回原 tool 卡片；叫醒该会话                                |
| 启动时 backing pid 已死：立刻 `lost`，elapsed 停（优先输出文件 mtime），写回已有输出并通知该会话     |
| 折叠结果带 `outputPath`；历史 pruning 对 `exec` 多留尾（1000/4000），hard-clear 占位符带完整日志路径 |
| `openclaw gateway stop --force`：清空全部 running exec，启动后不叫醒                                 |
| 终态台账不带 in-progress `phase`，带 `runtime`                                                       |
| 会话 running 时发送按钮为停止                                                                        |
| `process` 保留 list/log/write/send-keys/kill；`poll` 拒绝                                            |
| 模型 `timeout`/`yieldMs`/`background` 忽略；进程寿命 = `maxWaitMs`                                   |
| 诊断 stuck-session / LLM idle / 工具 abort 不杀长任务                                                |
| 整轮 `timeoutSeconds` 有限超时时至少抬到 `maxWaitMs`                                                 |

关键文件：`src/agents/long-task-runtime.ts`、`long-task-config.ts`、`bash-tools.exec.ts`、`bash-tools.process.ts`、`src/infra/gateway-stop-intent.ts`、`src/cli/daemon-cli/lifecycle.ts`

运行时配置：`/root/.openclaw/openclaw.json` → `tools.longTask`（`maxWaitMs` 1800000，`blockEndTurn` true，retention 7/7/1/3 天）。

---

## 2. 先不做

| ID                    | 内容                                  |
| --------------------- | ------------------------------------- |
| P2-2                  | 技能 `longRunning` / `tasks.complete` |
| P2-3                  | spawn 完成进不可剥历史；子代理记忆    |
| P3                    | 钉钉专用阶段卡                        |
| `maxActivePerSession` | 未加 schema                           |

---

## 3. 明确不做

- 模型 `process poll` 当等待入口
- 模型用 `timeout` / `yieldMs` 控制等待或杀进程
- 诊断 stuck-session 6 分钟误杀长任务
- 内部短轮询切片
- heartbeat 当完成总线
- 同一 session 两个主 agent 并行
- 长任务期间插队执行普通新用户业务

---

## 4. 已知缺口

- Gateway 挂在 IDE 终端里时，Ctrl+C / 重启仍可能把 exec 进程一起带走（进程组 / stdout 管道）。启动后会立刻记 `lost`，而不是继续跑。`lost` 只表示结果无法回收，不是精确的 `failed`。
- 非 `exec` 的历史 tool result 仍是头尾各 1500。`exec` 改为头 1000 / 尾 4000，hard-clear 带输出路径。
