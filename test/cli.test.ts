import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

describe("command line", () => {
  it("prints help and refuses to start without an api key", async () => {
    const help = await run(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /ns1\.vultr\.com/);

    const missing = await run([]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /VULTR_API_KEY is required/);
  });
});

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.VULTR_API_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
