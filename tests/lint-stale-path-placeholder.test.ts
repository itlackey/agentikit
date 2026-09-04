// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #927 — `stale-path` flagged a run-time filename template (e.g.
// `/reports/portfolio-review-<timestamp>.md`) as a broken literal path. These
// pin the placeholder forms that must be skipped, and that a genuinely
// missing literal path is still reported.

import { afterEach, describe, expect, test } from "bun:test";
import { runBaseChecks } from "../src/commands/lint/base-linter";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

function staleIssues(storage: IsolatedAkmStorage, body: string) {
  const issues = runBaseChecks({
    filePath: `${storage.stashDir}/workflows/w.md`,
    relPath: "workflows/w.md",
    raw: `---\nname: w\n---\n\n${body}`,
    data: { name: "w" },
    body,
    frontmatter: "name: w",
    fix: false,
    stashRoot: storage.stashDir,
  });
  return issues.filter((issue) => issue.issue === "stale-path");
}

describe("stale-path skips run-time filename templates (#927)", () => {
  let storage: IsolatedAkmStorage;
  afterEach(() => storage?.cleanup());

  test.each([
    ["angle-bracket placeholder", "Write to /home/founder3/akm/reports/portfolio-review-<timestamp>.md."],
    ["brace placeholder", "Write to /home/founder3/akm/reports/portfolio-review-{stamp}.md."],
    ["${VAR} placeholder", "Write to /home/founder3/akm/reports/portfolio-review-${STAMP}.md."],
    ["YYYYMMDD date-format run", "Write to /home/founder3/akm/reports/portfolio-review-YYYYMMDD.md."],
    ["HHMMSS date-format run", "Write to /home/founder3/akm/reports/portfolio-review-HHMMSS.md."],
    ["glob star", "Write to /home/founder3/akm/reports/portfolio-review-*.md."],
    ["glob question mark", "Write to /home/founder3/akm/reports/portfolio-review-?.md."],
  ])("%s is not reported", (_label, body) => {
    storage = withIsolatedAkmStorage();
    expect(staleIssues(storage, body)).toEqual([]);
  });

  test("a genuinely missing literal path is still reported", () => {
    storage = withIsolatedAkmStorage();
    const issues = staleIssues(storage, "Write to /home/founder3/akm/reports/portfolio-review-final.md.");
    expect(issues.length).toBe(1);
    expect(issues[0]?.detail).toContain("portfolio-review-final");
  });

  test("an existing literal path is not reported", () => {
    storage = withIsolatedAkmStorage();
    expect(staleIssues(storage, `Read from \`${storage.stashDir}\` for config.`)).toEqual([]);
  });
});
