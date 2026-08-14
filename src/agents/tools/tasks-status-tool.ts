/**
 * tasks_status / tasks_list: inspect persisted long-task ledger without process poll.
 */
import { Type } from "typebox";
import {
  listTasksForRelatedSessionKey,
  listTasksForSessionKey,
} from "../../tasks/task-registry.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { formatLongTaskQueryRecord } from "../long-task-runtime.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const TasksStatusToolSchema = Type.Object({
  taskId: Type.Optional(Type.String()),
  sessionKey: Type.Optional(Type.String()),
});

const TasksListToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  includeTerminal: Type.Optional(Type.Boolean()),
});

function resolveSessionTasks(sessionKey: string): TaskRecord[] {
  const related = listTasksForRelatedSessionKey(sessionKey);
  if (related.length > 0) {
    return related;
  }
  return listTasksForSessionKey(sessionKey);
}

function createScopedTaskRecords(sessionKey: string | undefined): TaskRecord[] {
  const key = sessionKey?.trim();
  if (!key) {
    return [];
  }
  return resolveSessionTasks(key);
}

export function createTasksStatusTool(opts?: { sessionKey?: string }): AnyAgentTool {
  return {
    label: "Task Status",
    name: "tasks_status",
    description:
      "Inspect a long task or this session's active long tasks. Do not process poll to wait.",
    parameters: TasksStatusToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = readStringParam(params, "sessionKey") || opts?.sessionKey;
      const taskId = readStringParam(params, "taskId");
      const records = createScopedTaskRecords(sessionKey);
      const match = taskId
        ? records.find((task) => task.taskId === taskId || task.sourceId === taskId)
        : (records.find((task) => task.status === "queued" || task.status === "running") ??
          records[0]);
      if (!match) {
        return jsonResult({ status: "empty", tasks: [] });
      }
      return jsonResult({
        status: "ok",
        task: formatLongTaskQueryRecord(match),
      });
    },
  };
}

export function createTasksListTool(opts?: { sessionKey?: string }): AnyAgentTool {
  return {
    label: "Task List",
    name: "tasks_list",
    description: "List this session's long-task ledger. Do not process poll to wait.",
    parameters: TasksListToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = readStringParam(params, "sessionKey") || opts?.sessionKey;
      const includeTerminal = params.includeTerminal !== false;
      const records = createScopedTaskRecords(sessionKey).filter((task) => {
        if (includeTerminal) {
          return true;
        }
        return task.status === "queued" || task.status === "running";
      });
      return jsonResult({
        status: "ok",
        tasks: records.map((task) => formatLongTaskQueryRecord(task)),
      });
    },
  };
}
