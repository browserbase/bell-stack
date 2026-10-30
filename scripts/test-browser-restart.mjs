import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Browserbase from "@browserbasehq/sdk";

assert.equal(process.env.BELL_LIVE_RESTART, "1", "Set BELL_LIVE_RESTART=1 to run this hosted restart test.");
assert.ok(process.env.BROWSERBASE_API_KEY, "BROWSERBASE_API_KEY is required");
const directory = path.resolve(".bell/restart-e2e", randomUUID()), stateFile = path.join(directory, "state.json");
await mkdir(directory, { recursive: true, mode: 0o700 });
const sdk = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY, timeout: 10_000, maxRetries: 0 });
const env = { ...process.env, BELL_RESTART_STATE_FILE: stateFile, STAGEHAND_BROWSER: "browserbase", BROWSERBASE_CONTEXT_ID: "", BROWSERBASE_1PASSWORD_EXTENSION_ID: "", ONEPASSWORD_ENABLED: "false" };
const report = { passed: false, phases: [], cleanup: false };
let failure;
try {
  for (const phase of ["prepare", "resume"]) {
    const output = path.join(directory, `${phase}.json`), log = await open(path.join(directory, `${phase}.log`), "w", 0o600);
    try {
      const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/browser/browser-restart-real.test.ts", "--reporter=json", `--outputFile=${output}`], {
        env: { ...env, BELL_RESTART_PHASE: phase }, detached: true, stdio: ["ignore", log.fd, log.fd],
      });
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 120_000);
      let code;
      try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); }
      finally { clearTimeout(timer); }
      const result = JSON.parse(await readFile(output, "utf8"));
      report.phases.push({ phase, passed: result.numPassedTests, failed: result.numFailedTests });
      assert.equal(code, 0, `${phase} failed; inspect its local test report`);
    } finally { await log.close(); }
  }
} catch (error) { failure = error; }
finally {
  try {
    let state;
    try { state = JSON.parse(await readFile(stateFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (state) {
      const id = state.browser.sessionId;
      if ((await sdk.sessions.retrieve(id)).status !== "COMPLETED") await sdk.sessions.update(id, { status: "REQUEST_RELEASE" });
      const deadline = Date.now() + 30_000;
      while ((await sdk.sessions.retrieve(id)).status !== "COMPLETED") {
        assert.ok(Date.now() < deadline, "Hosted browser cleanup timed out");
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      for (const extensionId of state.extensionIds) {
        try { await sdk.extensions.delete(extensionId, { headers: { "Content-Type": null } }); }
        catch (error) { if (!(error instanceof Browserbase.APIError) || error.status !== 404) throw error; }
        await assert.rejects(sdk.extensions.retrieve(extensionId), error => error instanceof Browserbase.APIError && error.status === 404);
      }
      report.cleanup = true;
    }
  } catch { failure = new Error("Restart fixture cleanup failed; inspect its private state file before retrying."); }
  report.passed = !failure && report.cleanup;
  await writeFile(path.join(directory, "result.json"), JSON.stringify({ ...report, testedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(`Browser restart ${report.passed ? "passed" : "failed"}. Report: ${path.join(directory, "result.json")}`);
}
if (failure) throw failure;
