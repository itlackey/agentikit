// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { main } from "../../src/cli";
import { agentCommand } from "../../src/commands/agent/contribute-cli";
import { commandCommand } from "../../src/commands/command/command-cli";

type DynamicCommand = {
  args?: Record<string, { type?: string; required?: boolean }>;
  subCommands?: Record<string, DynamicCommand>;
};

describe("canonical command CLI surface", () => {
  test("registers command run <ref> with one exact argument string", () => {
    const top = main.subCommands as unknown as Record<string, DynamicCommand>;
    expect(top.command).toBe(commandCommand as unknown as DynamicCommand);

    const run = (commandCommand as unknown as DynamicCommand).subCommands?.run;
    expect(run?.args?.ref).toMatchObject({ type: "positional", required: true });
    expect(run?.args?.arguments).toMatchObject({ type: "string" });
    expect(run?.args?.["dry-run"]).toMatchObject({ type: "boolean", default: false });
  });

  test("keeps agent --command as a compatibility surface with the same exact argument flag", () => {
    const args = (agentCommand as unknown as DynamicCommand).args;
    expect(args?.command).toMatchObject({ type: "string" });
    expect(args?.arguments).toMatchObject({ type: "string" });
    expect(args?.["dry-run"]).toBeUndefined();
  });
});
