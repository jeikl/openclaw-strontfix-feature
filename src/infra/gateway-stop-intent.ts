/**
 * Records how the Gateway was last stopped so startup can tell
 * user-forced teardown from a normal Ctrl+C / gateway stop.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type GatewayStopMode = "graceful" | "force";

export type GatewayStopIntent = {
  mode: GatewayStopMode;
  at: number;
  source: string;
};

const INTENT_FILENAME = "gateway-stop-intent.json";

export function resolveGatewayStopIntentPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), INTENT_FILENAME);
}

export function writeGatewayStopIntent(params: {
  mode: GatewayStopMode;
  source: string;
  env?: NodeJS.ProcessEnv;
}): GatewayStopIntent {
  const intent: GatewayStopIntent = {
    mode: params.mode,
    at: Date.now(),
    source: params.source,
  };
  const filePath = resolveGatewayStopIntentPath(params.env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(intent)}\n`, "utf8");
  return intent;
}

export function readGatewayStopIntent(
  env: NodeJS.ProcessEnv = process.env,
): GatewayStopIntent | null {
  const filePath = resolveGatewayStopIntentPath(env);
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<GatewayStopIntent>;
    if (parsed.mode !== "graceful" && parsed.mode !== "force") {
      return null;
    }
    return {
      mode: parsed.mode,
      at: typeof parsed.at === "number" && Number.isFinite(parsed.at) ? parsed.at : 0,
      source: typeof parsed.source === "string" && parsed.source.trim() ? parsed.source : "unknown",
    };
  } catch {
    return null;
  }
}

export function consumeGatewayStopIntent(
  env: NodeJS.ProcessEnv = process.env,
): GatewayStopIntent | null {
  const intent = readGatewayStopIntent(env);
  try {
    fs.unlinkSync(resolveGatewayStopIntentPath(env));
  } catch {
    // Missing file is fine.
  }
  return intent;
}

export function resolveExecOutputPath(
  processSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "exec-output", `${processSessionId}.log`);
}

export function appendExecOutputLog(outputPath: string, chunk: string): void {
  if (!chunk) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.appendFileSync(outputPath, chunk, "utf8");
  } catch {
    // Output capture is best-effort; the process itself still runs.
  }
}

export function readExecOutputLog(outputPath: string | undefined): string {
  if (!outputPath?.trim()) {
    return "";
  }
  try {
    return fs.readFileSync(outputPath, "utf8");
  } catch {
    return "";
  }
}
