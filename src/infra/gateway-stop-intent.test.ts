import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeGatewayStopIntent,
  readExecOutputLog,
  readGatewayStopIntent,
  resolveExecOutputPath,
  writeGatewayStopIntent,
} from "./gateway-stop-intent.js";

const tempDirs: string[] = [];

function makeEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-stop-intent-"));
  tempDirs.push(dir);
  return { ...process.env, OPENCLAW_STATE_DIR: dir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway stop intent", () => {
  it("records a user force-stop separately from a graceful Ctrl+C stop", () => {
    const env = makeEnv();
    writeGatewayStopIntent({ mode: "force", source: "cli.gateway.stop --force", env });
    expect(readGatewayStopIntent(env)).toMatchObject({
      mode: "force",
      source: "cli.gateway.stop --force",
    });
    writeGatewayStopIntent({ mode: "graceful", source: "SIGINT", env });
    expect(readGatewayStopIntent(env)?.mode).toBe("graceful");
    const consumed = consumeGatewayStopIntent(env);
    expect(consumed?.mode).toBe("graceful");
    expect(readGatewayStopIntent(env)).toBeNull();
  });

  it("round-trips exec output next to state dir", () => {
    const env = makeEnv();
    const outputPath = resolveExecOutputPath("dawn-river", env);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "hello\n", "utf8");
    expect(readExecOutputLog(outputPath)).toBe("hello\n");
    expect(readExecOutputLog("/no/such/file.log")).toBe("");
  });
});
