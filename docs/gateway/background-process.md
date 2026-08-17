---
summary: "Background exec execution and process management"
read_when:
  - Adding or modifying background exec behavior
  - Debugging long-running exec tasks
title: "Background exec and process tool"
---

OpenClaw runs shell commands through the `exec` tool. The runtime waits internally until the command finishes or `tools.longTask.maxWaitMs` expires, then returns one folded result. The `process` tool is for logs, stdin, or kill — not as a wait loop.

## exec tool

Parameters:

| Parameter    | Description                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `command`    | Required. Shell command to run.                                                                                               |
| `workdir`    | Working directory; omit to use the default cwd.                                                                               |
| `env`        | Extra environment variables for the command.                                                                                  |
| `yieldMs`    | Ignored. Park timing is `tools.exec.backgroundMs`.                                                                            |
| `background` | Ignored. Park timing is `tools.exec.backgroundMs`.                                                                            |
| `timeout`    | Ignored. Process lifetime is `tools.longTask.maxWaitMs`.                                                                      |
| `pty`        | Run in a pseudo-terminal when available (TTY-required CLIs, coding agents).                                                   |
| `elevated`   | Run outside the sandbox if elevated mode is enabled/allowed (`gateway` by default, or `node` when the exec target is `node`). |
| `host`       | Exec target: `auto`, `sandbox`, `gateway`, or `node`.                                                                         |
| `node`       | Node id/name, used with `host: "node"`.                                                                                       |

Behavior:

- Call `exec` once. The runtime waits (event-driven, up to `maxWaitMs`) and returns one folded tool result.
- Foreground watch duration is `tools.exec.backgroundMs` (default 10s, `0` parks immediately). Then the runtime parks until exit, cancel, or `maxWaitMs`.
- Model `timeout` / `yieldMs` / `background` do not control wait or process lifetime.
- `/stop` `/clear` `/new` cancel the wait and kill the process. Diagnostic stuck-session recovery and the LLM idle watchdog do not.
- If the `process` tool is disallowed, `exec` still runs to completion under the same wait.
- Spawned exec commands receive `OPENCLAW_SHELL=exec` for context-aware shell/profile rules.
- Don't emulate reminders or delayed follow-ups with `sleep` loops or repeated polling — use cron for future work.
- Don't process-poll to wait. Use `tasks_status` / `tasks_list` to inspect.

### Env overrides

| Variable                                 | Effect                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_BASH_YIELD_MS`                 | Default foreground watch before runtime park (ms). Default 10000, clamped 0-120000.                              |
| `OPENCLAW_BASH_MAX_OUTPUT_CHARS`         | In-memory output cap (chars).                                                                                    |
| `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS` | Pending stdout/stderr cap per stream (chars).                                                                    |
| `OPENCLAW_BASH_JOB_TTL_MS`               | TTL for finished sessions (ms), bounded to 1m-3h.                                                                |
| `OPENCLAW_PROCESS_INPUT_WAIT_IDLE_MS`    | Idle-output threshold before writable background sessions are marked as likely waiting for input. Default 15000. |

### Config (preferred over env overrides)

| Key                                   | Default | Effect                                                                          |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `tools.longTask.maxWaitMs`            | 1800000 | Sole wait and process-lifetime cap. Model `timeout`/`yieldMs` are ignored.      |
| `tools.exec.backgroundMs`             | 10000   | Same as `OPENCLAW_BASH_YIELD_MS`. Not a model argument.                         |
| `tools.exec.timeoutSec`               | 1800    | Legacy key. Process lifetime follows `tools.longTask.maxWaitMs`.                |
| `tools.exec.cleanupMs`                | 1800000 | Same as `OPENCLAW_BASH_JOB_TTL_MS`.                                             |
| `tools.exec.notifyOnExit`             | true    | Enqueue a system event + request heartbeat when a backgrounded exec exits.      |
| `tools.exec.notifyOnExitEmptySuccess` | false   | Also enqueue completion events for successful backgrounded runs with no output. |

## Child process bridging

When spawning long-running child processes outside the exec/process tools (CLI respawns, gateway helpers), attach the child-process bridge helper so termination signals forward and listeners detach on exit/error. This avoids orphaned processes on systemd and keeps shutdown consistent across platforms.

## process tool

Actions:

| Action      | Effect                                                                        |
| ----------- | ----------------------------------------------------------------------------- |
| `list`      | Running + finished sessions.                                                  |
| `poll`      | Rejected. Waiting is owned by `exec`; use `tasks_status` / `tasks_list`.      |
| `log`       | Read aggregated output and input-recovery hints. Supports `offset` + `limit`. |
| `write`     | Send stdin (`data`, optional `eof`).                                          |
| `send-keys` | Send explicit key tokens or bytes to a PTY-backed session.                    |
| `submit`    | Send Enter/carriage return to a PTY-backed session.                           |
| `paste`     | Send literal text, optionally wrapped in bracketed paste mode.                |
| `kill`      | Terminate a background session.                                               |
| `clear`     | Remove a finished session from memory.                                        |
| `remove`    | Kill if running, otherwise clear if finished.                                 |

Notes:

- Only runtime-parked sessions are listed/persisted — in memory only, not on disk. Sessions are lost on process restart.
- Session logs are only saved to chat history if you run `process log` and the tool result is recorded.
- `process` is scoped per agent; it only sees sessions started by that agent.
- Do not process-poll to wait. Use `tasks_status` / `tasks_list` to inspect. Use `log` for output.
- Use `log` before recovering an interactive CLI, so the current transcript, stdin state, and input-wait hint are visible together.
- Use `write`/`send-keys`/`submit`/`paste`/`kill` when you need input or intervention.
- `process list` includes a derived `name` (command verb + target) for quick scans.
- `process list`, `poll`, and `log` report `waitingForInput` only when the session still has writable stdin and has been idle longer than the input-wait threshold (default 15000 ms, `OPENCLAW_PROCESS_INPUT_WAIT_IDLE_MS`).
- `process log` uses line-based `offset`/`limit`. When both are omitted, it returns the last 200 lines with a paging hint. When `offset` is set and `limit` isn't, it returns from `offset` to the end (not capped to 200).
- `process poll` is rejected. Waiting is owned by `exec`.
- If the work should happen later, use cron.

## Examples

Call once and wait. Do not poll:

```json
{ "tool": "exec", "command": "sleep 5 && echo done" }
```

Inspect without waiting:

```json
{ "tool": "tasks_status" }
```

Inspect an interactive session before sending input:

```json
{ "tool": "process", "action": "log", "sessionId": "<id>" }
```

Same call for a long build. The runtime parks after `tools.exec.backgroundMs`:

```json
{ "tool": "exec", "command": "npm run build" }
```

Send stdin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```

Send PTY keys:

```json
{ "tool": "process", "action": "send-keys", "sessionId": "<id>", "keys": ["C-c"] }
```

Submit current line:

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Paste literal text:

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## Related

- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)
