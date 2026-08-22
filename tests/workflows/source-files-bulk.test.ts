// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  resolveUniqueWorkflowSource,
  resolveWorkflowSourceDomains,
  WorkflowSourceRejectionError,
} from "../../src/workflows/source-files";
import { makeSandboxDir } from "../_helpers/sandbox";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixtureRoot(prefix: string): string {
  const { dir, cleanup } = makeSandboxDir(prefix);
  cleanups.push(cleanup);
  return dir;
}

function workflow(root: string, name: string): string {
  const file = path.join(root, "workflows", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "name: local\non: workflow_dispatch\njobs: {}\n", "utf8");
  return file;
}

function lexicalDotPath(file: string): string {
  return `${path.dirname(file)}${path.sep}.${path.sep}${path.basename(file)}`;
}

function projection(root: string, inputs: readonly string[]) {
  return resolveWorkflowSourceDomains(root, "akm", inputs).map((domain) => ({
    canonicalName: domain.canonicalName,
    sourcePaths: domain.sourcePaths,
    source: domain.source?.relativePath,
    rejection: domain.rejection?.message,
  }));
}

describe("bulk workflow source ownership deduplicates authored paths", () => {
  test("an exact duplicate absolute path remains one owner with point-lookup parity", () => {
    const root = fixtureRoot("akm-workflow-source-bulk-exact-");
    const file = workflow(root, "exact.yml");
    const point = resolveUniqueWorkflowSource(root, "akm", "exact");

    const domains = resolveWorkflowSourceDomains(root, "akm", [file, file]);

    expect(domains).toHaveLength(1);
    expect(domains[0]).toEqual({
      canonicalName: "exact",
      sourcePaths: ["workflows/exact.yml"],
      source: point,
    });
  });

  test("lexically equivalent normalized paths collapse before domain arbitration", () => {
    const root = fixtureRoot("akm-workflow-source-bulk-lexical-");
    const file = workflow(root, "lexical.yml");
    const lexical = lexicalDotPath(file);

    const domains = resolveWorkflowSourceDomains(root, "akm", [lexical, file, lexical]);

    expect(domains).toHaveLength(1);
    expect(domains[0]?.sourcePaths).toEqual(["workflows/lexical.yml"]);
    expect(domains[0]?.source).toEqual(resolveUniqueWorkflowSource(root, "akm", "lexical.yml"));
    expect(domains[0]?.rejection).toBeUndefined();
  });

  test("deduplication is deterministic across input order and preserves each point owner", () => {
    const root = fixtureRoot("akm-workflow-source-bulk-order-");
    const alpha = workflow(root, "alpha.yml");
    const beta = workflow(root, "beta.yml");
    const inputs = [beta, lexicalDotPath(alpha), beta, alpha, lexicalDotPath(beta)];

    const forward = projection(root, inputs);
    const reverse = projection(root, [...inputs].reverse());

    expect(forward).toEqual(reverse);
    expect(forward).toEqual([
      { canonicalName: "alpha", sourcePaths: ["workflows/alpha.yml"], source: "workflows/alpha.yml" },
      { canonicalName: "beta", sourcePaths: ["workflows/beta.yml"], source: "workflows/beta.yml" },
    ]);
    expect(resolveUniqueWorkflowSource(root, "akm", "alpha")).toMatchObject({ relativePath: forward[0]?.source });
    expect(resolveUniqueWorkflowSource(root, "akm", "beta")).toMatchObject({ relativePath: forward[1]?.source });
  });

  test("a duplicated invalid path yields one domain rejection with point-lookup detail parity", () => {
    const root = fixtureRoot("akm-workflow-source-bulk-invalid-");
    const file = workflow(root, "hostile.md.yml");
    let pointRejection: WorkflowSourceRejectionError | undefined;
    try {
      resolveUniqueWorkflowSource(root, "akm", "hostile.md.yml");
    } catch (cause) {
      if (cause instanceof WorkflowSourceRejectionError) pointRejection = cause;
      else throw cause;
    }

    const domains = resolveWorkflowSourceDomains(root, "akm", [file, lexicalDotPath(file), file]);

    expect(pointRejection).toBeDefined();
    expect(domains).toHaveLength(1);
    expect(domains[0]?.sourcePaths).toEqual(["workflows/hostile.md.yml"]);
    expect(domains[0]?.source).toBeUndefined();
    expect(domains[0]?.rejection?.message).toBe(pointRejection?.message);
    expect(domains[0]?.rejection?.message.match(/has an extensionless stem/g)).toHaveLength(1);
  });
});
