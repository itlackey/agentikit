// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// R-033a: `getAllFlagValuesFrom` (the shared primitive behind
// `parseAllFlagValues`/`ParsedInvocation.getAllFlagValues`) must stop
// collecting repeatable-flag values at a literal `--` separator — everything
// after `--` is passthrough/positional, never a flag akm should interpret.
// This is unit-level coverage of the primitive itself, independent of any one
// command (`akm feedback --tag`, `akm search --filter`, `akm remember
// --xref`/`--supersedes`, `akm stash --supersedes`/`--xref`, `akm
// observability --include-tags`/`--exclude-tags`, `akm health --windows` all
// read through this same function and inherit the fix for free).
//
// No `ParsedInvocation` singleton is ever set under `bun test` (the
// `src/cli.ts` `import.meta.main` startup block that calls
// `setParsedInvocation` never runs here — see invocation.ts's module
// docstring), so `getParsedInvocation()` always takes the fallback path:
// parse the CURRENT `process.argv` fresh, on every call. Tests here mutate
// `process.argv` directly (restored in `finally`), mirroring the pattern
// `tests/_helpers/cli.ts` uses for the same reason.

import { describe, expect, test } from "bun:test";
import { getParsedInvocation, parseAllFlagValues } from "../../src/cli/invocation";
import { hasBooleanFlag, parseFlagValue } from "../../src/output/context";

function withArgv<T>(userArgs: string[], fn: () => T): T {
  const real = process.argv;
  process.argv = ["bun", "cli.ts", ...userArgs];
  try {
    return fn();
  } finally {
    process.argv = real;
  }
}

describe("invocation.ts argv `--` boundary (R-033a)", () => {
  test("parseAllFlagValues does not collect a repeated flag's value placed AFTER `--`", () => {
    const values = withArgv(["feedback", "ref", "--positive", "--", "--tag", "leaked:yes"], () =>
      parseAllFlagValues("--tag"),
    );
    expect(values).toEqual([]);
  });

  test("parseAllFlagValues still collects occurrences BEFORE `--` (control)", () => {
    const values = withArgv(["feedback", "ref", "--positive", "--tag", "slice:train", "--", "leftover"], () =>
      parseAllFlagValues("--tag"),
    );
    expect(values).toEqual(["slice:train"]);
  });

  test("parseAllFlagValues collects occurrences before `--` but drops the ones after it (mixed)", () => {
    const values = withArgv(["cmd", "--tag", "a", "--", "--tag", "b"], () => parseAllFlagValues("--tag"));
    expect(values).toEqual(["a"]);
  });

  test("`--flag=value` form is also excluded once past the `--` boundary", () => {
    const values = withArgv(["cmd", "--", "--tag=leaked"], () => parseAllFlagValues("--tag"));
    expect(values).toEqual([]);
  });

  test("with no `--` at all, every occurrence is still collected (unaffected)", () => {
    const values = withArgv(["cmd", "--tag", "a", "--tag", "b"], () => parseAllFlagValues("--tag"));
    expect(values).toEqual(["a", "b"]);
  });

  test("ParsedInvocation.getAllFlagValues (accessed directly) honors the same boundary", () => {
    const values = withArgv(["cmd", "--filter", "type:memory", "--", "--filter", "type:leaked"], () =>
      getParsedInvocation().getAllFlagValues("--filter"),
    );
    expect(values).toEqual(["type:memory"]);
  });

  test("first-value and boolean scans ignore flags after `--`", () => {
    const invocation = withArgv(["env", "run", "env/prod", "--", "tool", "--format", "text", "--quiet"], () =>
      getParsedInvocation(),
    );
    expect(invocation.getFlagValue("--format")).toBeUndefined();
    expect(invocation.hasFlag("--quiet")).toBe(false);
  });

  test("output-mode first-value and boolean primitives stop at `--`", () => {
    const argv = ["bun", "cli.ts", "env", "run", "env/prod", "--", "tool", "--format", "text", "--quiet"];
    expect(parseFlagValue(argv, "--format")).toBeUndefined();
    expect(hasBooleanFlag(argv, "--quiet")).toBe(false);
  });

  test("passthroughArgs() is unaffected — it still returns everything after `--`", () => {
    const invocation = withArgv(["env", "run", "ref", "--", "--tag", "leaked:yes"], () => getParsedInvocation());
    expect(invocation.passthroughArgs()).toEqual(["--tag", "leaked:yes"]);
  });
});
