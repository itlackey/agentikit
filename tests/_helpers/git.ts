// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Temp git-repo fixtures for the worktree integration suites. Real `git` only
 * — callers gate on `isGitAvailable()` and skip when it is absent.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Run a git command in `cwd`; throws on a non-zero exit, returns stdout. */
export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout ?? "";
}

export interface MakeGitRepoOptions {
  /** mkdtemp prefix for the repo dir (helps attribute leftovers to a suite). */
  prefix?: string;
  /** Called with the new repo dir so the suite can schedule its removal. */
  register?: (dir: string) => void;
}

/** Init a temp git repo with one committed file (`README.md`). */
export function makeGitRepo(options: MakeGitRepoOptions = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? "akm-git-repo-"));
  options.register?.(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@akm.invalid"]);
  git(dir, ["config", "user.name", "akm-test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "fixture"]);
  return dir;
}
