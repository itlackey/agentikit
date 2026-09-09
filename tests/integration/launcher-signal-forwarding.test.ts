// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #9543 decision 1: the published launcher (`scripts/node-runtime/akm`) used
 * to `spawn` its Bun/Node child with no signal handling at all — a
 * `kill <launcher-pid>` (a scheduler timeout, a supervisor, an operator) left
 * the child running as an orphan, still holding whatever lock it had. This
 * spawns the REAL launcher script against a fake child entry (mirrors
 * `tests/integration/scheduler-context-launcher.test.ts`'s fixture pattern)
 * and sends SIGTERM only to the launcher's own pid (no shared foreground
 * process group here, since the test spawns it directly) — so a passing
 * assertion proves the launcher's own forwarding code moved the signal, not
 * incidental OS group delivery.
 *
 * Integration-scoped (ORG-03/06): spawns real child processes.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "../_helpers/sandbox";

function launcherFixture(root: string): { launcher: string; readyFile: string; signalFile: string } {
  const dist = path.join(root, "package", "dist");
  const launcher = path.join(dist, "akm");
  const readyFile = path.join(root, "ready.txt");
  const signalFile = path.join(root, "signal.json");
  fs.mkdirSync(dist, { recursive: true });
  fs.copyFileSync(path.resolve("scripts/node-runtime/akm"), launcher);
  // A fake child entry: announces it is alive (readyFile), then records the
  // FIRST signal it receives and its own view of the launcher pid (proving
  // AKM_LAUNCHER_PID reached it) before exiting 0. Never resolves on its own
  // otherwise, so it stays alive until signaled or killed.
  fs.writeFileSync(
    path.join(dist, "cli.js"),
    [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
      'process.once("SIGTERM", () => {',
      `  fs.writeFileSync(${JSON.stringify(signalFile)}, JSON.stringify({ signal: "SIGTERM", launcherPid: process.env.AKM_LAUNCHER_PID }));`,
      "  process.exit(0);",
      "});",
      "await new Promise(() => {});",
    ].join("\n"),
  );
  return { launcher, readyFile, signalFile };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("launcher signal forwarding (#9543 decision 1)", () => {
  test("SIGTERM to the launcher forwards to the child, which the launcher then exits alongside", async () => {
    const sandbox = makeSandboxDir("akm-launcher-signal-");
    try {
      const fixture = launcherFixture(sandbox.dir);
      const launcherProc = spawn(process.execPath, [fixture.launcher, "sentinel"], {
        stdio: ["ignore", "ignore", "ignore"],
        env: process.env,
      });

      await waitFor(() => fs.existsSync(fixture.readyFile));
      // Sent only to the launcher's own pid — no shared foreground process
      // group here, so nothing but the launcher's own forwarding code can
      // move this to the child.
      launcherProc.kill("SIGTERM");

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        launcherProc.once("exit", (code, signal) => resolve({ code, signal }));
      });

      // The child exited cleanly (0) once signaled, so the launcher reports
      // that same code rather than a signal of its own.
      expect(exit.code).toBe(0);
      expect(exit.signal).toBeNull();

      await waitFor(() => fs.existsSync(fixture.signalFile));
      const received = JSON.parse(fs.readFileSync(fixture.signalFile, "utf8")) as {
        signal: string;
        launcherPid: string | undefined;
      };
      expect(received.signal).toBe("SIGTERM");
      expect(received.launcherPid).toBe(String(launcherProc.pid));
    } finally {
      sandbox.cleanup();
    }
  }, 15000);
});
