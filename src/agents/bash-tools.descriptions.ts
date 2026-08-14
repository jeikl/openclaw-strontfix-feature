/**
 * Tool descriptions for bash exec and process-control tools.
 * Descriptions include platform-specific guidance and approved executable
 * hints that are safe to show to the model.
 */
import path from "node:path";
import { loadExecApprovals, resolveExecApprovalsFromFile } from "../infra/exec-approvals.js";

/**
 * Show the exact approved token in hints. Absolute paths stay absolute so the
 * hint cannot imply an equivalent PATH lookup that resolves to a different binary.
 */
function deriveExecShortName(fullPath: string): string {
  if (path.isAbsolute(fullPath)) {
    return fullPath;
  }
  const base = path.basename(fullPath);
  return base.replace(/\.exe$/i, "") || base;
}

/** Builds the model-facing exec tool description for the current platform/config. */
export function describeExecTool(params?: { agentId?: string; hasCronTool?: boolean }): string {
  const base = [
    "Execute shell commands. The runtime waits for long commands internally (short polls, then event park) and returns one folded result. Do not process-poll to wait.",
    "Use yieldMs/background only to hand the command to that runtime wait. Use process for logs, stdin, or kill — not as a wait loop.",
    params?.hasCronTool
      ? "Do not use exec sleep or delay loops for reminders or deferred follow-ups; use cron instead."
      : undefined,
    "Use pty=true for TTY-required commands (terminal UIs, coding agents).",
  ]
    .filter(Boolean)
    .join(" ");
  if (process.platform !== "win32") {
    return base;
  }
  const lines: string[] = [base];
  lines.push(
    "IMPORTANT (Windows): Run executables directly; do NOT wrap commands in `cmd /c`, `powershell -Command`, `& ` prefix, or WSL. Use backslash paths (C:\\path), not forward slashes. Use short executable names (e.g. `node`, `python3`) instead of full paths.",
  );
  try {
    const approvalsFile = loadExecApprovals();
    const approvals = resolveExecApprovalsFromFile({
      file: approvalsFile,
      agentId: params?.agentId,
    });
    const allowlist = approvals.allowlist.filter((entry) => {
      const pattern = entry.pattern?.trim() ?? "";
      return (
        pattern.length > 0 &&
        pattern !== "*" &&
        !pattern.startsWith("=command:") &&
        (pattern.includes("/") || pattern.includes("\\") || pattern.includes("~"))
      );
    });
    if (allowlist.length > 0) {
      lines.push(
        "Pre-approved executables (exact arguments are enforced at runtime; no approval prompt needed when args match):",
      );
      for (const entry of allowlist.slice(0, 10)) {
        const shortName = deriveExecShortName(entry.pattern);
        const argNote = entry.argPattern ? "(restricted args)" : "(any arguments)";
        lines.push(`  ${shortName} ${argNote}`);
      }
    }
  } catch {
    // Allowlist loading is best-effort; don't block tool creation.
  }
  return lines.join("\n");
}

/** Builds the model-facing process-control tool description. */
export function describeProcessTool(params?: { hasCronTool?: boolean }): string {
  return [
    "Manage running exec sessions for commands already started: list, poll, log, write, send-keys, submit, paste, kill.",
    "Do not poll a session owned by the long-task runtime. Use tasks_status or /status to inspect. Use log/write/send-keys/submit/paste/kill for output or intervention.",
    params?.hasCronTool
      ? "Do not use process polling to emulate timers or reminders; use cron for scheduled follow-ups."
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}
