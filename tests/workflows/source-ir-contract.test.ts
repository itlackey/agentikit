import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileGithubWorkflowSource, compileMarkdownWorkflowSource } from "../../src/workflows/source-ir/compile";
import { sourceStepInstructions, sourceStepProgramUnit } from "../../src/workflows/source-ir/program";
import { decodeWorkflowSourceIrV1, type WorkflowSourceIrV1 } from "../../src/workflows/source-ir/schema";

const FIXTURES = path.join(import.meta.dir, "../fixtures/execution-contracts/workflows");

function readFixture(relative: string): string {
  return fs.readFileSync(path.join(FIXTURES, relative), "utf8");
}

function github(yaml: string, filePath = "workflows/contract.yml") {
  return compileGithubWorkflowSource(yaml, { path: filePath });
}

function expectGithubError(yaml: string, code: string, line?: number): void {
  const result = github(yaml);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(
    result.errors.some((error) => error.code === code),
    JSON.stringify(result.errors),
  ).toBe(true);
  if (line !== undefined) expect(result.errors.find((error) => error.code === code)?.line).toBe(line);
}

function requireOnlyDecodedStep(ir: WorkflowSourceIrV1): WorkflowSourceIrV1["jobs"][number]["steps"][number] {
  const step = ir.jobs[0]?.steps[0];
  if (!step) throw new Error("decoded source-IR fixture must contain one step");
  return step;
}

function replaceOnlyDecodedStep(
  ir: WorkflowSourceIrV1,
  step: WorkflowSourceIrV1["jobs"][number]["steps"][number],
): void {
  const job = ir.jobs[0];
  if (!job) throw new Error("decoded source-IR fixture must contain one job");
  job.steps[0] = step;
}

function canonicalPortableWorkflowSourceBytes(ir: WorkflowSourceIrV1): string {
  const decoded = decodeWorkflowSourceIrV1(ir);
  const portable = {
    schemaVersion: 1,
    name: decoded.name,
    ...(decoded.params ? { params: decoded.params } : {}),
    ...(decoded.defaults ? { defaults: decoded.defaults } : {}),
    ...(decoded.budget ? { budget: decoded.budget } : {}),
    triggers: decoded.triggers.map((trigger) =>
      trigger.kind === "workflow_dispatch" ? "workflow_dispatch" : { schedule: trigger.cron },
    ),
    jobs: decoded.jobs.map((job) => ({
      id: job.id,
      needs: [...job.needs],
      steps: job.steps.map((step) => {
        const { source: _source, extensions: _extensions, instructions: _instructions, ...body } = step;
        return body;
      }),
    })),
  };
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([key, item]) => [key, stable(item)]),
          )
        : value;
  return JSON.stringify(stable(portable));
}

const VALID_HEADER = `name: Local contract
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:`;

describe("workflow source IR portable contract", () => {
  test("direct Markdown argv stays distinct from GitHub shell text in canonical portable IR", () => {
    const markdown = compileMarkdownWorkflowSource(readFixture("equivalent/contract-review.md"), {
      path: "workflows/contract-review.md",
    });
    const yaml = compileGithubWorkflowSource(readFixture("equivalent/contract-review.yml"), {
      path: "workflows/contract-review.yml",
    });

    expect(markdown.ok).toBe(true);
    expect(yaml.ok).toBe(true);
    if (!markdown.ok || !yaml.ok) return;

    expect(markdown.ir.sourceIrVersion).toBe(1);
    expect(yaml.ir.sourceIrVersion).toBe(1);
    expect(markdown.ir.source.path).toBe("workflows/contract-review.md");
    expect(yaml.ir.source.path).toBe("workflows/contract-review.yml");
    expect(Object.keys(markdown.ir.extensions ?? {})).toEqual(["akm.dev/workflow-markdown"]);
    expect(Object.keys(yaml.ir.jobs[0]?.extensions ?? {})).toEqual(["github.com/actions-workflow"]);
    expect(markdown.ir.jobs[0]?.steps[0]).toMatchObject({
      exec: { command: ["printf", "contract-reviewed"] },
    });
    expect(markdown.ir.jobs[0]?.steps[0]?.run).toBeUndefined();
    expect(canonicalPortableWorkflowSourceBytes(markdown.ir)).not.toEqual(
      canonicalPortableWorkflowSourceBytes(yaml.ir),
    );
  });

  test("equivalent built-in command sources have exact portable bytes", () => {
    const markdown = compileMarkdownWorkflowSource(
      `---\ntype: workflow\nsteps:\n  - id: review\n---\n# Contract review\n\n## review\n\nReview the execution contract.\n`,
      { path: "workflows/contract-review.md" },
    );
    const yaml = github(`name: Contract review
on: { workflow_dispatch: null }
jobs:
  contract:
    runs-on: [self-hosted]
    steps:
      - id: review
        uses: akm/command
        with:
          content: Review the execution contract.
`);
    expect(markdown.ok).toBe(true);
    expect(yaml.ok).toBe(true);
    if (!markdown.ok || !yaml.ok) return;
    expect(canonicalPortableWorkflowSourceBytes(markdown.ir)).toEqual(canonicalPortableWorkflowSourceBytes(yaml.ir));
  });

  test.each([
    ["embedded whitespace", ["printf", "a b"]],
    ["literal shell operator", ["printf", "a;b"]],
    ["literal variable spelling", ["printf", "$HOME"]],
    ["literal quote bytes", ["printf", "'quoted'"]],
    ["explicit interpreter payload", ["bash", "-lc", "a | b"]],
  ] as const)("preserves %s argv without an argv-to-shell join", (_label, command) => {
    const source = `---
type: workflow
steps:
  - id: direct
    unit:
      exec:
        command: ${JSON.stringify(command)}
---
# Direct

## direct

Run the direct command.
`;
    const result = compileMarkdownWorkflowSource(source, { path: "workflows/direct.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = result.ir.jobs[0]?.steps[0];
    expect(step?.exec?.command).toEqual([...command]);
    expect(step?.run).toBeUndefined();
    expect(sourceStepProgramUnit(step!).exec?.command).toEqual([...command]);
    expect(canonicalPortableWorkflowSourceBytes(result.ir)).not.toContain(`"run":${JSON.stringify(command.join(" "))}`);
  });

  test("canonicalizes equivalent direct cwd spellings without changing argv bytes", () => {
    const markdown = (cwd: string) => `---
type: workflow
steps:
  - id: direct
    unit:
      exec:
        command: [bash, -lc, "a | b"]
        cwd: ${JSON.stringify(cwd)}
---
# Direct

## direct

Run the direct command.
`;
    const dotted = compileMarkdownWorkflowSource(markdown("packages/./cli"), { path: "workflows/direct.md" });
    const slashed = compileMarkdownWorkflowSource(markdown("packages\\cli"), { path: "workflows/direct.md" });
    expect(dotted.ok).toBe(true);
    expect(slashed.ok).toBe(true);
    if (!dotted.ok || !slashed.ok) return;
    expect(dotted.ir.jobs[0]?.steps[0]?.exec).toEqual({ command: ["bash", "-lc", "a | b"], cwd: "packages/cli" });
    expect(slashed.ir.jobs[0]?.steps[0]?.exec).toEqual({ command: ["bash", "-lc", "a | b"], cwd: "packages/cli" });
    expect(canonicalPortableWorkflowSourceBytes(dotted.ir)).toBe(canonicalPortableWorkflowSourceBytes(slashed.ir));
  });

  test("preserves a Markdown agent unit as explicit common semantics while using the built-in command action", () => {
    const result = compileMarkdownWorkflowSource(readFixture("current/agent-unit.md"), {
      path: "workflows/agent-unit.md",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.jobs[0]?.steps[0]).toMatchObject({
      id: "review",
      uses: "akm/command",
      with: { content: "Review the execution contract." },
      unit: { engine: "fixture-agent", model: "fixture-exact-model", timeoutMs: 45_000 },
    });
  });

  // P4 DELETE (docs/plans/specs/p4-deletions-closeout.md §3.3, F-A3.8 —
  // discovered flip, recorded in the Review log): "normalizes a multi-job
  // graph into deterministic dependency order" tested that two
  // differently-authored multi-job documents (different job order, different
  // needs spellings) normalize to the same canonical portable bytes. Both
  // fixtures are 3-job documents; a workflow source now accepts exactly one
  // job (row B-34), so neither `a` nor `b` parses any more — the capability
  // this test pinned no longer exists to normalize.

  // FLIPPED in P4 (F-A3.8): the job-ordering half of this test ("ready jobs")
  // has no reachable scenario once a source is confined to one job — the
  // mapping-key half (locale-independent ordering of a `with:` object's own
  // keys, unrelated to job count) survives on a single-job fixture.
  test("uses locale-independent code-point ordering for with: mapping keys", () => {
    const result = github(`name: Ordering
on: { workflow_dispatch: null }
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: lower
        uses: commands/lower
        with: { a: second, Z: first }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(canonicalPortableWorkflowSourceBytes(result.ir)).toContain('"with":{"Z":"first","a":"second"}');
  });

  // FLIPPED in P4 (docs/plans/specs/p4-deletions-closeout.md §3.3, F-A3.8):
  // `missing-job-dependency` and `job-dependency-cycle` are deleted with the
  // rest of the multi-job dependency machinery. A single job with a
  // non-empty `needs:` (however it fails to resolve) and a 2-job cycle
  // attempt both now hit the SAME multi-job-unsupported rejection — the
  // first because one job has nothing to depend on, the second because the
  // document never reaches per-job needs validation at all.
  test("rejects a job needs (single-job) and a job-count mismatch (multi-job) with multi-job-unsupported", () => {
    expectGithubError(
      `${VALID_HEADER}
      - id: ok
        run: echo ok
    needs: absent
`,
      "multi-job-unsupported",
    );
    expectGithubError(
      `name: Cycle
on: { workflow_dispatch: null }
jobs:
  a:
    needs: b
    runs-on: [self-hosted]
    steps: [{ id: a, run: echo a }]
  b:
    needs: a
    runs-on: [self-hosted]
    steps: [{ id: b, run: echo b }]
`,
      "multi-job-unsupported",
    );
  });
});

describe("strict bounded GitHub-shaped YAML", () => {
  test.each([
    ["duplicate-key", `name: A\nname: B\non: { workflow_dispatch: null }\njobs: {}`],
    ["yaml-anchor", `name: A\non: &events { workflow_dispatch: null }\njobs: {}`],
    ["yaml-alias", `name: A\non: &events { workflow_dispatch: null }\njobs: *events`],
    ["yaml-custom-tag", `name: !contract A\non: { workflow_dispatch: null }\njobs: {}`],
    ["mapping-root-required", `- name\n- on\n- jobs`],
    ["unsafe-key", `name: A\non: { workflow_dispatch: null }\njobs:\n  constructor: {}`],
    ["unknown-key", `name: A\non: { workflow_dispatch: null }\njobs: {}\npermissions: read-all`],
  ])("rejects %s", (code, yaml) => expectGithubError(yaml, code));

  test("rejects excessive source bytes, YAML depth, and collection size", () => {
    expectGithubError(
      `${VALID_HEADER}\n      - id: huge\n        run: echo ${"x".repeat(1_048_576)}\n`,
      "source-size-limit",
    );
    const nested = `${VALID_HEADER}\n      - id: deep\n        uses: commands/deep\n        with:\n          value: ${"[".repeat(40)}x${"]".repeat(40)}\n`;
    expectGithubError(nested, "yaml-depth-limit");
    const steps = Array.from({ length: 257 }, (_, index) => `      - id: s${index}\n        run: echo s${index}`).join(
      "\n",
    );
    expectGithubError(`${VALID_HEADER}\n${steps}\n`, "step-count-limit");
  });

  test("accepts only local schedule/manual triggers and no workflow_dispatch inputs", () => {
    const valid = github(`name: Timed
on:
  schedule:
    - cron: "0 8 * * 1"
    - cron: "30 9 * * 2"
  workflow_dispatch: null
jobs:
  main:
    runs-on: [self-hosted]
    steps: [{ id: ok, run: echo ok }]
`);
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.ir.triggers.map((trigger) => trigger.kind)).toEqual(["schedule", "schedule", "workflow_dispatch"]);
      expect(valid.ir.triggers[1]).toMatchObject({ cron: "30 9 * * 2", ordinal: 1 });
    }
    expectGithubError(`name: Push\non:\n  push: { branches: [main] }\njobs: {}`, "unsupported-service-event", 3);
    expectGithubError(
      `name: Inputs\non:\n  workflow_dispatch:\n    inputs:\n      name: { required: true }\njobs: {}`,
      "workflow-dispatch-inputs-unsupported",
      4,
    );
  });

  test("exposes the immutable WP6 trigger classifier as an injected pure boundary", () => {
    let classified: unknown;
    const result = compileGithubWorkflowSource(
      `name: Bound
on:
  schedule:
    - cron: "0 8 * * 1"
  workflow_dispatch: {}
jobs:
  main:
    runs-on: [self-hosted]
    steps: [{ id: ok, run: echo ok }]
`,
      {
        path: "workflows/bound.yml",
        classifyTriggers: (value, options) => {
          classified = value;
          expect(options.filePath).toBe("workflows/bound.yml");
          expect(options.lineAt?.(["on", "schedule", 0, "cron"])).toBe(4);
          expect(options.lineAt?.(["on", "workflow_dispatch"])).toBe(5);
          return {
            manual: true,
            schedules: [{ cron: "0 8 * * 1", source: "on.schedule[0].cron", ordinal: 0 }],
          };
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(classified).toEqual({
      on: { schedule: [{ cron: "0 8 * * 1" }], workflow_dispatch: {} },
    });
  });

  test("requires exactly the local self-hosted runner", () => {
    expectGithubError(
      `${VALID_HEADER.replace("[self-hosted]", "ubuntu-latest")}\n      - id: ok\n        run: echo ok\n`,
      "unsupported-runner",
    );
    expectGithubError(
      `${VALID_HEADER.replace("[self-hosted]", "[self-hosted, linux]")}\n      - id: ok\n        run: echo ok\n`,
      "unsupported-runner",
    );
  });

  test.each([
    ["job strategy", "strategy: { matrix: { node: [20, 22] } }", "unknown-key"],
    ["job container", "container: node:22", "unknown-key"],
    ["job services", "services: { db: { image: postgres } }", "unknown-key"],
  ])("rejects unsupported %s semantics", (_label, field, code) => {
    expectGithubError(
      `name: Unsupported
on: { workflow_dispatch: null }
jobs:
  main:
    runs-on: [self-hosted]
    ${field}
    steps: [{ id: ok, run: echo ok }]
`,
      code,
    );
  });

  test("rejects step conditionals and duplicate step ids", () => {
    expectGithubError(
      `${VALID_HEADER}\n      - id: conditional\n        if: success()\n        run: echo ok\n`,
      "unknown-key",
    );
    expectGithubError(
      `${VALID_HEADER}\n      - id: repeated\n        run: echo one\n      - id: repeated\n        run: echo two\n`,
      "duplicate-step-id",
    );
  });

  // P3a FLIP (docs/plans/specs/p3a-plan-v5-child-freeze.md §1.5/§6 F-B2, row
  // B-02): "workflows/child" moves out of the rejection table below and into
  // this acceptance loop — decodeWorkflowSourceIrV1's nested-workflow throw
  // (A-N4's one producer, semantics.ts:155-159) is gone, so a direct
  // `uses: workflows/x` step compiles cleanly through this SAME pipeline just
  // like any other target-ref-shaped uses:. Test name drops "nested
  // workflows" accordingly.
  test("accepts workflow-step task definitions and rejects remote actions", () => {
    for (const uses of [
      "akm/command",
      "commands/review",
      "team//commands/review",
      "tasks/review",
      "team//tasks/review",
      "scripts/build.sh",
      "workflows/child",
    ]) {
      const withBlock = uses === "akm/command" ? "\n        with: { content: Review this }" : "";
      const result = github(`${VALID_HEADER}\n      - id: local\n        uses: ${uses}${withBlock}\n`);
      expect(result.ok, uses).toBe(true);
    }
    for (const [uses, code] of [
      // P4 FLIP (docs/plans/specs/p4-deletions-closeout.md §3.1, row B-05,
      // F-A1.9): the locator grammar and its shape override are deleted —
      // a github-action-shaped uses: is now just an unrecognized ref shape.
      ["actions/checkout@v4", "unsupported-uses-target"],
      ["./actions/review", "local-action-path-unsupported"],
      ["docker://alpine:latest", "docker-action-unsupported"],
      ["agents/reviewer", "non-executable-asset-ref"],
      ["akm:commands/review", "unsupported-uses-target"],
      ["bad.bundle//commands/review", "unsupported-uses-target"],
      ["commands/review#fragment", "unsupported-uses-target"],
      ["actions/checkout@bad:ref", "unsupported-uses-target"],
      ["review", "unsupported-uses-target"],
    ] as const) {
      expectGithubError(`${VALID_HEADER}\n      - id: rejected\n        uses: ${uses}\n`, code);
    }
  });

  test("preserves the built-in command action's exact empty content and arguments contract", () => {
    const result = github(`${VALID_HEADER}
      - id: inline
        uses: akm/command
        with:
          content: ""
          arguments: ""
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.jobs[0]?.steps[0]?.with).toEqual({ content: "", arguments: "" });
    expect(result.ir.jobs[0]?.steps[0]?.commandMode).toBe("portable-template");
  });

  test("validates portable inline command templates at source compile and strict decode boundaries", () => {
    expectGithubError(
      `${VALID_HEADER}
      - id: unsafe
        uses: akm/command
        with:
          content: echo $HOME
          arguments: exact input
`,
      "builtin-command-inputs",
      11,
    );

    const stored = github(`${VALID_HEADER}
      - id: stored
        uses: akm/command
        with:
          ref: commands/review
          arguments: "  exact $HOME input  "
`);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.ir.jobs[0]?.steps[0]).toMatchObject({
      uses: "akm/command",
      commandMode: "stored-ref",
      with: { ref: "commands/review", arguments: "  exact $HOME input  " },
    });
    expect(decodeWorkflowSourceIrV1(stored.ir)).toEqual(stored.ir);
    expect(canonicalPortableWorkflowSourceBytes(stored.ir)).toContain('"commandMode":"stored-ref"');

    const mismatchedStored = structuredClone(stored.ir);
    requireOnlyDecodedStep(mismatchedStored).commandMode = "literal";
    expect(() => decodeWorkflowSourceIrV1(mismatchedStored)).toThrow(/stored.*commandMode stored-ref/i);

    const hostile = structuredClone(stored.ir);
    const hostileStep = requireOnlyDecodedStep(hostile);
    hostileStep.commandMode = "portable-template";
    hostileStep.with = { content: "echo $HOME", arguments: "exact input" };
    expect(() => decodeWorkflowSourceIrV1(hostile)).toThrow(/unsupported portable template construct/i);
  });

  test("carries literal and portable-template command semantics explicitly in portable bytes", () => {
    const markdown = compileMarkdownWorkflowSource(
      `---
type: workflow
steps:
  - id: review
---
# Review

## review

Review $ARGUMENTS and \${{ github.sha }} literally.
`,
      { path: "workflows/literal.md" },
    );
    const yaml = github(`${VALID_HEADER}
      - id: review
        uses: akm/command
        with:
          content: Review $ARGUMENTS
          arguments: "  exact $HOME input  "
`);
    expect(markdown.ok).toBe(true);
    expect(yaml.ok).toBe(true);
    if (!markdown.ok || !yaml.ok) return;

    expect(markdown.ir.jobs[0]?.steps[0]?.commandMode).toBe("literal");
    expect(yaml.ir.jobs[0]?.steps[0]?.commandMode).toBe("portable-template");
    const stored = github(
      `${VALID_HEADER}\n      - id: stored\n        uses: akm/command\n        with: { ref: commands/review }\n`,
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(canonicalPortableWorkflowSourceBytes(markdown.ir)).toContain('"commandMode":"literal"');
    expect(canonicalPortableWorkflowSourceBytes(yaml.ir)).toContain('"commandMode":"portable-template"');
    expect(canonicalPortableWorkflowSourceBytes(markdown.ir)).not.toBe(canonicalPortableWorkflowSourceBytes(yaml.ir));
    expect(
      new Set([
        canonicalPortableWorkflowSourceBytes(markdown.ir),
        canonicalPortableWorkflowSourceBytes(yaml.ir),
        canonicalPortableWorkflowSourceBytes(stored.ir),
      ]).size,
    ).toBe(3);
    const expectedLiteralText = "Review $ARGUMENTS and $" + "{{ github.sha }} literally.";
    expect(sourceStepInstructions(markdown.ir.jobs[0]!.steps[0]!)).toContain(expectedLiteralText);
    expect(sourceStepInstructions(yaml.ir.jobs[0]!.steps[0]!)).toBe("Review   exact $HOME input  ");

    const withoutOwnerExtension = structuredClone(markdown.ir);
    delete withoutOwnerExtension.extensions;
    expect(decodeWorkflowSourceIrV1(withoutOwnerExtension)).toEqual(withoutOwnerExtension);
    expect(sourceStepInstructions(withoutOwnerExtension.jobs[0]!.steps[0]!)).toContain(expectedLiteralText);

    const missingMode = structuredClone(markdown.ir);
    delete requireOnlyDecodedStep(missingMode).commandMode;
    expect(() => decodeWorkflowSourceIrV1(missingMode)).toThrow(/explicit commandMode/i);

    const withSpoofedOwnerExtension = structuredClone(yaml.ir);
    withSpoofedOwnerExtension.extensions = { "akm.dev/workflow-markdown": { workflowSchemaVersion: 3 } };
    expect(sourceStepInstructions(decodeWorkflowSourceIrV1(withSpoofedOwnerExtension).jobs[0]!.steps[0]!)).toBe(
      "Review   exact $HOME input  ",
    );
    expect(canonicalPortableWorkflowSourceBytes(withSpoofedOwnerExtension)).toBe(
      canonicalPortableWorkflowSourceBytes(yaml.ir),
    );
  });

  test("exposes the immutable WP6 uses classifier as an injected pure boundary", () => {
    let classified: string | undefined;
    const result = compileGithubWorkflowSource(`${VALID_HEADER}\n      - id: local\n        uses: commands/review\n`, {
      path: "workflows/classified.yml",
      classifyUses: (value) => {
        classified = value;
        return { kind: "command", ref: value };
      },
    });
    expect(result.ok).toBe(true);
    expect(classified).toBe("commands/review");
  });

  // P4 FLIP (docs/plans/specs/p4-deletions-closeout.md §3.1.2, row B-09;
  // implementer addition to §7.1 alongside F-A1.9/F-A1.10, same root cause —
  // recorded in the commit body and the Review log): canonicalTaskTarget,
  // which used to intercept a task ref BEFORE ever calling the injected
  // classifier, is deleted along with the locator grammar it existed to keep
  // priority over. The injected classifier is now consulted for task refs
  // exactly like any other uses: value — classifyTargetRef's own tasks/ arm
  // is the one authority (brief §8.1).
  test("consults the injected WP6 task-context classifier for task composition", () => {
    let calls = 0;
    const result = compileGithubWorkflowSource(`${VALID_HEADER}\n      - id: local\n        uses: tasks/review\n`, {
      path: "workflows/classified-task.yml",
      classifyUses: (value) => {
        calls++;
        return { kind: "task", ref: value };
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
  });

  test.each([
    [
      "literal env",
      `${VALID_HEADER}\n      - id: local\n        run: echo ok\n        env: { MODE: safe }\n`,
      /contract\.yml:8.*literal env values.*cannot preserve/is,
    ],
    [
      "task composition",
      `${VALID_HEADER}\n      - id: local\n        uses: tasks/review\n`,
      /contract\.yml:8.*tasks\/review.*source-target resolver/is,
    ],
  ] as const)("keeps %s semantics in source IR without a display-to-runtime bridge", (_label, source) => {
    const result = github(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.jobs[0]?.steps).toHaveLength(1);
  });

  test("accepts token-safe local run with the closed shell table and contained working directories", () => {
    for (const shell of ["bash", "sh", "zsh", "pwsh", "powershell", "cmd"]) {
      const result = github(
        `${VALID_HEADER}\n      - id: local\n        run: bun run check --filter=unit\n        shell: ${shell}\n        working-directory: packages/cli\n`,
      );
      expect(result.ok, shell).toBe(true);
    }
    for (const [run, code] of [
      ["echo ok && curl example.com", "unsafe-run-syntax"],
      ["echo $HOME", "unsafe-run-syntax"],
      ["echo %PATH%", "unsafe-run-syntax"],
      ["echo $" + "{{ github.sha }}", "unsupported-github-expression"],
    ] as const) {
      expectGithubError(`${VALID_HEADER}\n      - id: unsafe\n        run: ${run}\n`, code);
    }
    expectGithubError(
      `${VALID_HEADER}\n      - id: multiline\n        run: |\n          echo ok\n`,
      "unsafe-run-syntax",
    );
    expectGithubError(
      `${VALID_HEADER}\n      - id: shell\n        run: echo ok\n        shell: fish\n`,
      "unsupported-shell",
    );
    expectGithubError(
      `${VALID_HEADER}\n      - id: cwd\n        run: echo ok\n        working-directory: ../outside\n`,
      "working-directory-escape",
    );
    expectGithubError(
      `${VALID_HEADER}\n      - id: cwd\n        run: echo ok\n        working-directory: packages//cli\n`,
      "working-directory-escape",
    );
  });

  test("canonicalizes accepted cron, token-safe run, and contained cwd spellings", () => {
    const left = github(`name: Canonical
on:
  schedule: [{ cron: "0  8\t* * 1" }]
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: run
        run: "bun\t run   check"
        working-directory: packages/./cli
`);
    const right = github(`name: Canonical
on:
  schedule: [{ cron: "0 8 * * 1" }]
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: run
        run: bun run check
        working-directory: packages/cli
`);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.ir.triggers[0]).toMatchObject({ cron: "0 8 * * 1" });
    expect(left.ir.jobs[0]?.steps[0]).toMatchObject({ run: "bun run check", workingDirectory: "packages/cli" });
    expect(canonicalPortableWorkflowSourceBytes(left.ir)).toBe(canonicalPortableWorkflowSourceBytes(right.ir));
  });

  // P4 DELETE (docs/plans/specs/p4-deletions-closeout.md §3.3, F-A3.9 —
  // discovered flip, recorded in the Review log): this test pinned
  // cross-job topological/decoder-idempotence behavior for a 3-job document
  // ("z"/"b"/"a", with "a" depending on "b") — unreachable once a source is
  // confined to exactly one job (row B-34).

  // FLIPPED in P4 (docs/plans/specs/p4-deletions-closeout.md §3.3, row B-34,
  // F-A3.3): a multi-job document no longer "parses clean, but the runtime
  // refuses to execute it" (R-05) — it now fails at PARSE, at the adapter
  // boundary, with multi-job-unsupported. compileWorkflowPlan's own "exactly
  // one source-IR job" check is deleted (row B-43); it never sees this
  // document, so this is no longer "display-only" — criterion 23.
  test("rejects multi-job YAML at the adapter boundary — it is not display-only core behavior", () => {
    const result = github(`name: Multi-job
on: { workflow_dispatch: null }
jobs:
  build:
    runs-on: [self-hosted]
    steps: [{ id: build, run: echo build }]
  deploy:
    needs: build
    runs-on: [self-hosted]
    steps: [{ id: deploy, run: echo deploy }]
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      {
        code: "multi-job-unsupported",
        message:
          "AKM workflow YAML requires exactly one job; this document declares 2. AKM's YAML is an AKM workflow " +
          "format executed by AKM's native engine, not GitHub Actions — split the jobs into separate workflows.",
        path: "workflows/contract.yml",
        line: 7,
      },
    ]);
  });

  test("rejects NUL and control bytes in compiler working directories", () => {
    expectGithubError(
      `${VALID_HEADER}\n      - id: nul\n        run: echo ok\n        working-directory: "packages\\0cli"\n`,
      "working-directory-control-character",
    );
    expectGithubError(
      `${VALID_HEADER}\n      - id: control\n        run: echo ok\n        working-directory: "packages\\x1fcli"\n`,
      "working-directory-control-character",
    );
  });

  test("anchors missing akm/command with input at the uses selector", () => {
    expectGithubError(`${VALID_HEADER}\n      - id: inline\n        uses: akm/command\n`, "builtin-command-inputs", 9);
  });

  test("preserves direct argv, cwd, map, route, inputs, schemas, and gates as explicit common semantics", () => {
    const result = compileMarkdownWorkflowSource(
      `---
type: workflow
description: Characterize every current dispatch form
defaults: { engine: local }
budget: { max_units: 9 }
steps:
  - id: discover
    output: { type: object }
  - id: review
    map:
      over: steps.discover.output.items
      concurrency: 2
      reducer: collect
      unit:
        exec:
          command: [bash, -lc, "a | b"]
          cwd: packages/./cli
        on_error: continue
    inputs: [steps.discover.output]
    gate: { max_loops: 2 }
  - id: choose
    route:
      input: steps.review.output
      when:
        - { match: pass, step: ship }
      default: repair
  - id: ship
  - id: repair
---
# Explicit semantics

Preamble.

## discover

Discover items.

## review

Review each item.

### gate

Every item passes.

## choose

Routing documentation.

## ship

Ship.

## repair

Repair.
`,
      { path: "workflows/explicit.md" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir).toMatchObject({
      description: "Characterize every current dispatch form",
      defaults: { engine: "local" },
      budget: { maxUnits: 9 },
      preamble: "# Explicit semantics\n\nPreamble.",
    });
    expect(result.ir.jobs[0]?.steps[1]).toMatchObject({
      id: "review",
      exec: { command: ["bash", "-lc", "a | b"], cwd: "packages/cli" },
      unit: { onError: "continue" },
      map: { over: "steps.discover.output.items", concurrency: 2, reducer: "collect" },
      inputs: ["steps.discover.output"],
      gate: { maxLoops: 2, rubric: "Every item passes." },
      instructions: "Review each item.",
    });
    expect(result.ir.jobs[0]?.steps[2]).toMatchObject({
      route: {
        input: "steps.review.output",
        branches: [{ match: "pass", stepId: "ship" }],
        defaultStepId: "repair",
      },
      instructions: "Routing documentation.",
    });
  });

  test("rejects a working-directory symlink that physically escapes its workspace", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akm-source-ir-"));
    const workspace = path.join(sandbox, "workspace");
    const outside = path.join(sandbox, "outside");
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, "escape"), "dir");
    try {
      const result = compileGithubWorkflowSource(
        `${VALID_HEADER}\n      - id: cwd\n        run: echo ok\n        working-directory: escape\n`,
        { path: "workflows/escape.yml", workspaceRoot: workspace },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((error) => error.code === "working-directory-escape")).toBe(true);

      const markdown = compileMarkdownWorkflowSource(
        `---
type: workflow
steps:
  - id: cwd
    unit:
      exec:
        command: [echo, ok]
        cwd: escape
---
# Escape

## cwd

Run it.
`,
        { path: "workflows/escape.md", workspaceRoot: workspace },
      );
      expect(markdown.ok).toBe(false);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("source-locates Markdown cwd semantic failures at the authored field", () => {
    const source = `---
type: workflow
steps:
  - id: cwd
    unit:
      exec:
        command: [echo, ok]
        cwd: "bad\\0cwd"
---
# Bad cwd

## cwd

Run it.
`;
    const result = compileMarkdownWorkflowSource(source, {
      path: "workflows/bad-cwd.md",
      workspaceRoot: process.cwd(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "working-directory-control-character", line: 8 }),
      );
    }

    const invalidArgv = compileMarkdownWorkflowSource(
      source.replace("command: [echo, ok]", 'command: ["bad\\0argv"]'),
      {
        path: "workflows/bad-argv.md",
        workspaceRoot: process.cwd(),
      },
    );
    expect(invalidArgv.ok).toBe(false);
    if (!invalidArgv.ok) {
      expect(invalidArgv.errors[0]).toMatchObject({ code: "invalid-markdown-workflow", line: 7 });
      expect(invalidArgv.errors[0]?.message).toMatch(/NUL/i);
    }
  });

  test("fails closed on dangling cwd symlinks before an outside target can appear", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akm-source-ir-dangling-"));
    const workspace = path.join(sandbox, "workspace");
    const outside = path.join(sandbox, "outside-missing");
    fs.mkdirSync(workspace);
    fs.symlinkSync(outside, path.join(workspace, "escape"), "dir");
    const markdownSource = `---
type: workflow
steps:
  - id: cwd
    unit:
      exec:
        command: [echo, ok]
        cwd: escape
---
# Escape

## cwd

Run it.
`;
    const compileBoth = () => [
      compileGithubWorkflowSource(
        `${VALID_HEADER}\n      - id: cwd\n        run: echo ok\n        working-directory: escape\n`,
        { path: "workflows/dangling.yml", workspaceRoot: workspace },
      ),
      compileMarkdownWorkflowSource(markdownSource, {
        path: "workflows/dangling.md",
        workspaceRoot: workspace,
      }),
    ];
    try {
      const beforeAppearance = compileBoth();
      for (const result of beforeAppearance) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors[0]).toMatchObject({ code: "working-directory-unverifiable" });
      }
      const markdownBeforeAppearance = beforeAppearance[1];
      if (markdownBeforeAppearance && !markdownBeforeAppearance.ok) {
        expect(markdownBeforeAppearance.errors[0]).toMatchObject({ line: 8 });
      }
      fs.mkdirSync(outside);
      for (const result of compileBoth()) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors[0]?.code).toMatch(/working-directory-(?:escape|unverifiable)/);
      }
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("strict source IR decoder", () => {
  const valid: WorkflowSourceIrV1 = {
    sourceIrVersion: 1,
    name: "Decoded",
    triggers: [{ kind: "workflow_dispatch", source: { path: "x.yml", start: 2, end: 2 } }],
    jobs: [
      {
        id: "main",
        needs: [],
        steps: [{ id: "ok", run: "echo ok", source: { path: "x.yml", start: 8, end: 9 } }],
        source: { path: "x.yml", start: 5, end: 9 },
      },
    ],
    source: { path: "x.yml", start: 1, end: 9 },
  };

  test("round-trips the canonical plain-data representation", () => {
    const input = structuredClone(valid);
    const decoded = decodeWorkflowSourceIrV1(input);
    expect(decoded).toEqual(valid);
    expect(decoded).not.toBe(input);
    input.name = "mutated after decode";
    expect(decoded.name).toBe("Decoded");
  });

  test("rejects accessors, non-plain prototypes, sparse arrays, unsafe keys, and unknown keys", () => {
    const accessor = structuredClone(valid) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "name", { enumerable: true, get: () => "pwned" });
    expect(() => decodeWorkflowSourceIrV1(accessor)).toThrow(/accessor/i);

    const prototyped = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, valid);
    expect(() => decodeWorkflowSourceIrV1(prototyped)).toThrow(/plain object/i);

    const sparse = structuredClone(valid);
    sparse.jobs.length = 2;
    expect(() => decodeWorkflowSourceIrV1(sparse)).toThrow(/sparse/i);

    const unsafe = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    Object.defineProperty(unsafe, "__proto__", { enumerable: true, value: {} });
    expect(() => decodeWorkflowSourceIrV1(unsafe)).toThrow(/unsafe key/i);

    expect(() => decodeWorkflowSourceIrV1({ ...structuredClone(valid), mystery: true })).toThrow(/unknown key/i);
  });

  test("never invokes array accessors and rejects extra or non-enumerable properties", () => {
    const accessorArray = structuredClone(valid);
    let getterInvoked = false;
    Object.defineProperty(accessorArray.jobs, "0", {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return valid.jobs[0];
      },
    });
    expect(() => decodeWorkflowSourceIrV1(accessorArray)).toThrow(/accessor/i);
    expect(getterInvoked).toBe(false);

    const extendedArray = structuredClone(valid) as unknown as { jobs: unknown[] };
    Object.defineProperty(extendedArray.jobs, "extra", { enumerable: true, value: true });
    expect(() => decodeWorkflowSourceIrV1(extendedArray)).toThrow(/unexpected array property/i);

    const hidden = structuredClone(valid) as unknown as Record<string, unknown>;
    Object.defineProperty(hidden, "mystery", { enumerable: false, value: true });
    expect(() => decodeWorkflowSourceIrV1(hidden)).toThrow(/non-enumerable/i);
  });

  test("does not invoke inherited serialization hooks while snapshotting", () => {
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    let invoked = false;
    let decoded: WorkflowSourceIrV1 | undefined;
    let failure: unknown;
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() {
        invoked = true;
        throw new Error("inherited serialization hook ran");
      },
    });
    try {
      decoded = decodeWorkflowSourceIrV1(structuredClone(valid));
    } catch (cause) {
      failure = cause;
    } finally {
      if (original) Object.defineProperty(Object.prototype, "toJSON", original);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
    }
    expect(failure).toBeUndefined();
    expect(invoked).toBe(false);
    expect(decoded).toEqual(valid);
  });

  test("rejects proxies, invalid extension owners, unsupported versions, and ill-formed Unicode", () => {
    expect(() => decodeWorkflowSourceIrV1(new Proxy(structuredClone(valid), {}))).toThrow(/proxy/i);
    expect(() =>
      decodeWorkflowSourceIrV1({ ...structuredClone(valid), extensions: { markdown: { safe: true } } }),
    ).toThrow(/invalid owner/i);
    expect(() => decodeWorkflowSourceIrV1({ ...structuredClone(valid), sourceIrVersion: 2 })).toThrow(
      /sourceIrVersion must be 1/,
    );
    expect(() => decodeWorkflowSourceIrV1({ ...structuredClone(valid), name: "bad\ud800" })).toThrow(
      /well-formed Unicode/i,
    );
  });

  test("reapplies authoritative semantic validation to hostile decoded objects", () => {
    const scheduled = structuredClone(valid);
    scheduled.triggers = [{ kind: "schedule", cron: "61 25 * * *", ordinal: 0, source: scheduled.source }];
    expect(() => decodeWorkflowSourceIrV1(scheduled)).toThrow(/cron|schedule/i);

    const unsafeRun = structuredClone(valid);
    requireOnlyDecodedStep(unsafeRun).run = "echo ok && curl example.com";
    expect(() => decodeWorkflowSourceIrV1(unsafeRun)).toThrow(/safe tokens|unsafe run/i);

    const escapedCwd = structuredClone(valid);
    requireOnlyDecodedStep(escapedCwd).workingDirectory = "../outside";
    expect(() => decodeWorkflowSourceIrV1(escapedCwd)).toThrow(/contained|workingDirectory/i);

    const controlCwd = structuredClone(valid);
    requireOnlyDecodedStep(controlCwd).workingDirectory = "packages\0cli";
    expect(() => decodeWorkflowSourceIrV1(controlCwd)).toThrow(/control/i);

    // P4 FLIP (row B-05, F-A1.10): a github-action-shaped uses: is no longer
    // a recognized-but-out-of-scope construct; the locator grammar is
    // deleted, so this now rejects for the same generic reason as any other
    // unrecognized ref shape.
    const remote = structuredClone(valid);
    replaceOnlyDecodedStep(remote, { id: "ok", uses: "actions/checkout@v4", source: remote.source });
    expect(() => decodeWorkflowSourceIrV1(remote)).toThrow(/target ref/i);

    // P3a FLIP (spec §1.5/§6 F-B2, row B-02): decodeWorkflowSourceIrV1 no
    // longer throws for a step whose uses: is a workflow ref — A-N4's one
    // producer (semantics.ts:155-159) is gone, and decodeWorkflowSourceIrV1
    // is one of its three independent call chains (A-N4). The neighboring
    // `remote`, `escapedCwd`, `controlCwd`, and `builtin` cases immediately
    // around this one are untouched.
    const nested = structuredClone(valid);
    replaceOnlyDecodedStep(nested, { id: "ok", uses: "workflows/child", source: nested.source });
    expect(decodeWorkflowSourceIrV1(nested)).toEqual(nested);

    const builtin = structuredClone(valid);
    replaceOnlyDecodedStep(builtin, {
      id: "ok",
      uses: "akm/command",
      commandMode: "stored-ref",
      with: { ref: "commands/review", content: "both are forbidden" },
      source: builtin.source,
    });
    expect(() => decodeWorkflowSourceIrV1(builtin)).toThrow(/exactly one|mutually exclusive/i);

    const expression = structuredClone(valid);
    replaceOnlyDecodedStep(expression, {
      id: "ok",
      uses: "tasks/$" + "{{ github.ref }}",
      source: expression.source,
    });
    expect(() => decodeWorkflowSourceIrV1(expression)).toThrow(/expression/i);

    const builtinExpression = structuredClone(valid);
    replaceOnlyDecodedStep(builtinExpression, {
      id: "ok",
      uses: "akm/command",
      commandMode: "portable-template",
      with: { content: "Review $" + "{{ github.sha }}" },
      source: builtinExpression.source,
    });
    expect(() => decodeWorkflowSourceIrV1(builtinExpression)).toThrow(/expression|template construct/i);
  });

  test("canonicalizes decoded cron, run, and cwd and physically contains decoded cwd", () => {
    const canonical = structuredClone(valid);
    canonical.triggers = [{ kind: "schedule", cron: " 0  8\t* * 1 ", ordinal: 0, source: canonical.source }];
    const canonicalStep = requireOnlyDecodedStep(canonical);
    canonicalStep.run = " bun\t run   check ";
    canonicalStep.workingDirectory = "packages/./cli";
    expect(decodeWorkflowSourceIrV1(canonical)).toMatchObject({
      triggers: [{ cron: "0 8 * * 1" }],
      jobs: [{ steps: [{ run: "bun run check", workingDirectory: "packages/cli" }] }],
    });

    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akm-decoded-cwd-"));
    const workspace = path.join(sandbox, "workspace");
    const outside = path.join(sandbox, "outside");
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, "escape"), "dir");
    try {
      const escaped = structuredClone(valid);
      requireOnlyDecodedStep(escaped).workingDirectory = "escape";
      expect(() => decodeWorkflowSourceIrV1(escaped, { workspaceRoot: workspace })).toThrow(/symlink|workspace/i);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("enforces authoritative dispatch bounds on hostile decoded objects", () => {
    const oversizedArgv = structuredClone(valid);
    replaceOnlyDecodedStep(oversizedArgv, {
      id: "ok",
      exec: { command: Array.from({ length: 65 }, () => "x") },
      source: oversizedArgv.source,
    });
    expect(() => decodeWorkflowSourceIrV1(oversizedArgv)).toThrow(/at most 64|argv/i);

    const oversizedArg = structuredClone(valid);
    replaceOnlyDecodedStep(oversizedArg, {
      id: "ok",
      exec: { command: ["x".repeat(4097)] },
      source: oversizedArg.source,
    });
    expect(() => decodeWorkflowSourceIrV1(oversizedArg)).toThrow(/4096 bytes/i);

    const emptyPassEnv = structuredClone(valid);
    replaceOnlyDecodedStep(emptyPassEnv, {
      id: "ok",
      exec: { command: ["echo", "ok"], passEnv: [] },
      source: emptyPassEnv.source,
    });
    expect(() => decodeWorkflowSourceIrV1(emptyPassEnv)).toThrow(/non-empty array/i);

    const invalidUnit = structuredClone(valid);
    requireOnlyDecodedStep(invalidUnit).unit = {
      engine: "NOT_CANONICAL",
      timeoutMs: 0,
      retry: { max: 101, on: ["invented"] },
    };
    expect(() => decodeWorkflowSourceIrV1(invalidUnit)).toThrow(/engine name|timeout|retry/i);

    const invalidFanout = structuredClone(valid);
    const fanoutStep = requireOnlyDecodedStep(invalidFanout);
    fanoutStep.map = { over: "steps.previous.output", concurrency: 65 };
    fanoutStep.gate = { maxLoops: 101 };
    expect(() => decodeWorkflowSourceIrV1(invalidFanout)).toThrow(/concurrency|maxLoops/i);

    const invalidLlm = structuredClone(valid);
    requireOnlyDecodedStep(invalidLlm).unit = { llm: { headers: { Authorization: "secret" } } };
    expect(() => decodeWorkflowSourceIrV1(invalidLlm)).toThrow(/unknown key|llm/i);

    const invalidSchema = structuredClone(valid);
    requireOnlyDecodedStep(invalidSchema).output = { type: "string", pattern: ".*" };
    expect(() => decodeWorkflowSourceIrV1(invalidSchema)).toThrow(/pattern|schema|unsupported/i);
  });

  test("rejects noncanonical trigger and needs order, and a job count other than 1", () => {
    const triggers = structuredClone(valid);
    triggers.triggers = [
      { kind: "workflow_dispatch", source: { path: "x.yml", start: 2, end: 2 } },
      { kind: "schedule", cron: "0 8 * * 1", ordinal: 0, source: { path: "x.yml", start: 3, end: 3 } },
    ];
    expect(() => decodeWorkflowSourceIrV1(triggers)).toThrow(/canonical schedule-then-manual order/i);

    // FLIPPED in P4 (docs/plans/specs/p4-deletions-closeout.md §3.3, row
    // B-42, F-A3.10 — discovered flip, recorded in the Review log):
    // validateTopologicalJobs (and its "canonical dependency-topological
    // order" message) is deleted with the rest of the multi-job machinery;
    // the decoder's own jobs-array-length check now fires first — it
    // requires EXACTLY 1 entry, not 1 through 256 in canonical order.
    const jobs = structuredClone(valid);
    const baseJob = jobs.jobs[0];
    const baseStep = baseJob?.steps[0];
    if (!baseJob || !baseStep) throw new Error("source IR fixture must contain a baseline job and step");
    jobs.jobs = [
      { id: "a", needs: [], steps: baseJob.steps, source: baseJob.source },
      { id: "B", needs: [], steps: [{ ...baseStep, id: "upper" }], source: baseJob.source },
    ];
    expect(() => decodeWorkflowSourceIrV1(jobs)).toThrow(/jobs must contain exactly 1 entry/i);

    // FLIPPED in P4 (F-A3.10): the per-job needs-canonical-order check
    // SURVIVES — it validates one job's own `needs:` array, independent of
    // job count — but can no longer be exercised via a 3-job fixture now
    // that jobs must be exactly 1 entry; the probe moves onto a single job
    // whose own needs are unsorted.
    const needs = structuredClone(valid);
    const needsBaseJob = needs.jobs[0];
    if (!needsBaseJob) throw new Error("source IR fixture must contain a baseline job");
    needs.jobs = [{ ...needsBaseJob, needs: ["b", "a"] }];
    expect(() => decodeWorkflowSourceIrV1(needs)).toThrow(/needs are not in canonical order/i);
  });
});
