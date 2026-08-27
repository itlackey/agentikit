// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { main } from "../../src/cli";
import { commandCommand } from "../../src/commands/command/command-cli";
import { taskCommand } from "../../src/commands/tasks/tasks-cli";

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
});

// P2b Lane B (spec docs/plans/specs/p2b-input-bindings.md §1.2 binding, §7
// F-B3): the contract must be extended in the SAME commit that registers a
// new verb. `akm task explain` (B-N4) is read-only introspection — a `ref`
// positional plus the global `format` flag (GLOBAL_OUTPUT_ARGS,
// src/cli/shared.ts), like every defineJsonCommand leaf.
describe("canonical task CLI surface", () => {
  test("registers task explain <ref> with a format flag", () => {
    const top = main.subCommands as unknown as Record<string, DynamicCommand>;
    expect(top.task).toBe(taskCommand as unknown as DynamicCommand);

    const explain = (taskCommand as unknown as DynamicCommand).subCommands?.explain;
    expect(explain?.args?.ref).toMatchObject({ type: "positional", required: true });
    expect(explain?.args?.format).toMatchObject({ type: "string" });
  });
});
