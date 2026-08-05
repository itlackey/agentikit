// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";

const [mode = "success", ...args] = process.argv.slice(2);

switch (mode) {
  case "success":
    process.stdout.write("qa-agent-success\n");
    break;
  case "capture":
    process.stdout.write(
      `${JSON.stringify({
        argv: args,
        cwd: process.cwd(),
        opencodeCredentialPresent: Boolean(process.env.OPENCODE_API_KEY),
      })}\n`,
    );
    break;
  case "fail":
    process.stderr.write("qa-agent-failure\n");
    process.exitCode = 7;
    break;
  case "echo-secret": {
    const value = process.env.OPENCODE_API_KEY ?? "qa-secret-missing";
    process.stdout.write(`${value}\n`);
    process.stderr.write(`${value}\n`);
    break;
  }
  case "judge-pass":
    process.stdout.write('{"complete":true,"missing":[],"feedback":""}\n');
    break;
  case "judge-reject":
    process.stdout.write('{"complete":false,"missing":["fixture criterion"],"feedback":"qa-gate-rejected"}\n');
    break;
  case "malformed":
    process.stdout.write("not-json\n");
    break;
  case "sleep": {
    const durationMs = Number.parseInt(args[0] ?? "10000", 10);
    const markerPath = args[1];
    const handleSignal = (signal: NodeJS.Signals): void => {
      if (markerPath) fs.writeFileSync(markerPath, `${signal}\n`);
      process.exit(signal === "SIGINT" ? 130 : 143);
    };
    process.once("SIGINT", () => handleSignal("SIGINT"));
    process.once("SIGTERM", () => handleSignal("SIGTERM"));
    await Bun.sleep(Number.isFinite(durationMs) ? durationMs : 10_000);
    process.stdout.write("qa-agent-sleep-complete\n");
    break;
  }
  default:
    process.stderr.write(`Unknown fake-agent mode: ${mode}\n`);
    process.exitCode = 2;
}
