// Version-stamp metadata is kept for diagnostics, but older binaries are allowed
// to start, migrate, and mutate config written by any newer OpenClaw/jeikclaw.
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

/** Override env var retained for compatibility; the version guard no longer blocks. */
export const ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV =
  "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS";

/** Block payload shown when an older binary would mutate newer-written config. */
export type FutureConfigActionBlock = {
  action: string;
  currentVersion: string;
  touchedVersion: string;
  message: string;
  hints: string[];
};

type FutureConfigGuardParams = {
  action: string;
  snapshot?: Pick<ConfigFileSnapshot, "config" | "sourceConfig"> | null;
  config?: Pick<OpenClawConfig, "meta"> | null;
  currentVersion?: string;
  env?: Record<string, string | undefined>;
};

/** Resolves whether a destructive action should be blocked by future config metadata. */
export function resolveFutureConfigActionBlock(
  _params: FutureConfigGuardParams,
): FutureConfigActionBlock | null {
  return null;
}

/** Formats a future-config action block for CLI/service error output. */
export function formatFutureConfigActionBlock(block: FutureConfigActionBlock): string {
  return [block.message, ...block.hints].join("\n");
}
