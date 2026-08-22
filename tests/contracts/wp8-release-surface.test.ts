// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Immutable 0.9.2 release-surface contract.
 *
 * This suite intentionally reads public documentation and package metadata as
 * data. It does not restate every implementation detail; it pins the facts an
 * upgrader, author, operator, or npm consumer must be able to discover without
 * reading source code. Historical design/review documents are excluded from
 * current-truth scans and instead receive an explicit supersession banner.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");

type Requirement = readonly [label: string, pattern: RegExp];

function read(relative: string): string {
  const absolute = path.join(ROOT, relative);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
}

function missing(relative: string, requirements: readonly Requirement[]): string[] {
  const text = read(relative);
  return requirements.filter(([, pattern]) => !pattern.test(text)).map(([label]) => `${relative}: ${label}`);
}

function section(markdown: string, heading: string): string | undefined {
  const marker = `## [${heading}]`;
  const start = markdown.indexOf(marker);
  if (start < 0) return undefined;
  const bodyStart = markdown.indexOf("\n", start);
  if (bodyStart < 0) return "";
  const next = markdown.indexOf("\n## [", bodyStart + 1);
  return markdown.slice(bodyStart + 1, next < 0 ? markdown.length : next);
}

const CURRENT_TRUTH_DOCS = [
  "README.md",
  ".github/README.npm.md",
  "docs/README.md",
  "docs/reference/README.md",
  "docs/migration/README.md",
  "docs/reference/cli.md",
  "docs/reference/configuration.md",
  "docs/reference/data-and-telemetry.md",
  "docs/reference/supported-formats.md",
  "docs/reference/tasks.md",
  "docs/reference/workflows.md",
  "docs/reference/workflow-schema.md",
  "docs/guides/author-workflows.md",
  "docs/guides/run-workflows.md",
  "docs/guides/scheduling.md",
  "docs/architecture/adapters.md",
  "docs/architecture/architecture.md",
  "docs/architecture/workflow-engine.md",
  "docs/architecture/internals/functional-contract-patterns.md",
  "docs/architecture/internals/health-advisories.md",
  "docs/architecture/internals/storage-locations.md",
] as const;

describe("0.9.2 release surface", () => {
  test("cuts package and changelog metadata without stranding the #814 migration note", () => {
    const packageJson = JSON.parse(read("package.json")) as { version?: string };
    const changelog = read("CHANGELOG.md");
    const unreleased = section(changelog, "Unreleased");
    const released = section(changelog, "0.9.2");

    expect(packageJson.version).toBe("0.9.2");
    expect(changelog).toContain("## [0.9.2] - 2026-08-22");
    expect(changelog).toMatch(/## \[Unreleased\]\s*## \[0\.9\.2\] - 2026-08-22/);
    expect(unreleased?.trim()).toBe("");
    expect(released).toMatch(/improve\.strategies\.\*\.processes\.triage\.judgment/);
    expect(released).toMatch(/judgment:\s*false/);
    expect(released).toMatch(/unknown (?:object )?keys?.*(?:reject|error)/is);
  });

  test("ships the task reference and both 0.9.2 migration documents", () => {
    const requiredDocs = [
      "docs/reference/tasks.md",
      "docs/migration/v0.9.1-to-v0.9.2.md",
      "docs/migration/release-notes/0.9.2.md",
    ];
    expect(requiredDocs.filter((relative) => !fs.existsSync(path.join(ROOT, relative)))).toEqual([]);

    const packageJson = JSON.parse(read("package.json")) as { files?: string[] };
    expect(packageJson.files).toContain("docs/reference/tasks.md");
    expect(packageJson.files).toContain("docs/migration/v0.9.1-to-v0.9.2.md");
    expect(packageJson.files).toContain("docs/migration/release-notes");
  });

  test("indexes the new current-truth and upgrade documents from every public entry point", () => {
    const failures = [
      ...missing("README.md", [
        ["links the task-v3 reference", /\[[^\]]*tasks?[^\]]*\]\(docs\/reference\/tasks\.md(?:#[^)]+)?\)/i],
        [
          "links the 0.9.2 migration guide",
          /\[[^\]]*(?:0\.9\.2|migration)[^\]]*\]\(docs\/migration\/v0\.9\.1-to-v0\.9\.2\.md(?:#[^)]+)?\)/i,
        ],
      ]),
      ...missing(".github/README.npm.md", [
        [
          "links the packaged task-v3 reference",
          /github\.com\/itlackey\/akm\/blob\/[^/]+\/docs\/reference\/tasks\.md/i,
        ],
        [
          "links the packaged 0.9.2 migration guide",
          /github\.com\/itlackey\/akm\/blob\/[^/]+\/docs\/migration\/v0\.9\.1-to-v0\.9\.2\.md/i,
        ],
      ]),
      ...missing("docs/README.md", [
        ["links tasks", /\]\(reference\/tasks\.md(?:#[^)]+)?\)/i],
        ["links the 0.9.2 migration guide", /\]\(migration\/v0\.9\.1-to-v0\.9\.2\.md(?:#[^)]+)?\)/i],
      ]),
      ...missing("docs/reference/README.md", [["links tasks", /\]\(tasks\.md(?:#[^)]+)?\)/i]]),
      ...missing("docs/migration/README.md", [["links the 0.9.2 guide", /\]\(v0\.9\.1-to-v0\.9\.2\.md(?:#[^)]+)?\)/i]]),
    ];
    expect(failures).toEqual([]);
  });

  test("documents the exact task-v3 grammar, supported targets, refusals, and fail-closed v2 migration", () => {
    const failures = [
      ...missing("docs/reference/tasks.md", [
        ["the only task extension is .yml", /\.yml.*(?:only|recognized)|only.*\.yml/is],
        [
          ".yaml is a rejected near miss",
          /\.yaml.*(?:never|not).*(?:index|schedul|run)|(?:never|not).*(?:index|schedul|run).*\.yaml/is,
        ],
        ["version 3 is mandatory", /version:\s*3/],
        ["uses xor run", /exactly one of [`*]*uses[`*]* (?:or|and) [`*]*run|uses.*run.*mutual/is],
        [
          "akm.schedule xor on",
          /exactly one.*(?:akm\.schedule).*(?:`on`|\bon\b)|(?:akm\.schedule).*(?:`on`|\bon\b).*exactly one/is,
        ],
        ["built-in command target", /akm\/command/],
        ["command workflow and script refs", /commands\/.*workflows\/.*scripts\//is],
        [
          "version-pinned GitHub action syntax is recognized but not acquired",
          /owner\/repo(?:\[\/path\]|\/path)?.*@(?:ref|revision|sha)[\s\S]{0,500}(?:recognized)[\s\S]{0,300}(?:remote action acquisition|unsupported in 0\.9\.2)/i,
        ],
        ["agent refs are not executable", /agents\/[^.\n]{0,240}(?:not executable|reject)/i],
        ["task refs are not executable", /tasks\/[^.\n]{0,240}(?:not executable|reject)/i],
        [
          "local and Docker actions are refused",
          /(?:local|\.\/).*action.*(?:reject|unsupported).*(?:Docker|docker:\/\/)|(?:Docker|docker:\/\/).*action.*(?:reject|unsupported).*(?:local|\.\/)/is,
        ],
        ["GitHub expressions are refused", /GitHub (?:expressions|expression).*(?:unsupported|reject)/i],
        ["closed host-shell table", /bash.*sh.*zsh.*pwsh.*powershell.*cmd/is],
        ["working-directory is relative and contained", /working-directory.*(?:relative|contain)/is],
        [
          "normal execution rejects v2",
          /(?:normal )?execution.*(?:reject|does not accept).*v2|v2.*(?:reject|does not accept).*(?:normal )?execution/is,
        ],
        ["migration preview", /akm migrate apply --dry-run/],
        ["migration apply", /akm migrate apply(?:`|\s|$)/m],
        ["ambiguous argv arrays are blocked", /argv array.*(?:block|manual)|(?:block|manual).*argv array/is],
      ]),
      ...missing("docs/migration/v0.9.1-to-v0.9.2.md", [
        ["v2 before example", /(?:before|0\.9\.1)[\s\S]*version:\s*2/i],
        ["v3 after example", /(?:after|0\.9\.2)[\s\S]*version:\s*3/i],
        ["preview and apply commands", /akm migrate apply --dry-run[\s\S]*akm migrate apply/i],
        ["immediate backup behavior", /back(?:s|ed)? up|backup/i],
        ["changed skipped and blocked report", /changed.*skipped.*blocked/is],
        ["argv-array manual case", /argv array.*(?:block|manual)|(?:block|manual).*argv array/is],
      ]),
      ...missing("docs/reference/cli.md", [
        ["links the canonical task reference", /docs\/reference\/tasks\.md|\]\(tasks\.md(?:#[^)]+)?\)/i],
        ["names task v3", /task v3/i],
      ]),
      ...missing("docs/reference/supported-formats.md", [
        ["task .yml-only v3 contract", /akm-task.*\.yml.*(?:version\s*3|v3)|(?:version\s*3|v3).*akm-task.*\.yml/is],
      ]),
      ...missing("docs/architecture/adapters.md", [
        ["adapter task-v3 contract", /akm-task.*(?:version:\s*3|task v3)|(?:version:\s*3|task v3).*akm-task/is],
      ]),
      ...missing("docs/guides/scheduling.md", [
        ["links the task source reference", /reference\/tasks\.md/i],
        ["names task v3", /task v3/i],
      ]),
    ];
    expect(failures).toEqual([]);
  });

  test("documents peer workflow sources, source IR v1, durable v4, and the explicit 0.9.3 boundary", () => {
    const failures = [
      ...missing("docs/reference/workflow-schema.md", [
        [
          "peer .md and .yml sources",
          /(?:peer|both)[^\n]{0,160}\.md[^\n]{0,160}\.yml|(?:peer|both)[^\n]{0,160}\.yml[^\n]{0,160}\.md/i,
        ],
        [".yaml is not a workflow source", /\.yaml.*(?:not|unsupported|reject)|(?:not|unsupported|reject).*\.yaml/is],
        ["shared source IR v1", /source IR (?:version )?1|sourceIrVersion:?\s*1/i],
        ["GitHub YAML root vocabulary", /\bname\b.*\bon\b.*\bjobs\b/is],
        ["local runner restriction", /runs-on:\s*\[self-hosted\]/i],
        ["schedule and manual triggers", /schedule.*workflow_dispatch/is],
        [
          "workflow_dispatch takes no inputs",
          /workflow_dispatch[^.\n]{0,200}(?:empty|no inputs|inputs are unsupported)/i,
        ],
        ["service events are refused", /service events?[^.\n]{0,300}(?:unsupported|reject)/i],
        [
          "only token-safe local run is accepted",
          /(?:token-safe|safe tokens?)[^\n]{0,240}run|run[^\n]{0,240}(?:token-safe|safe tokens?)/i,
        ],
        [
          "shell expansion and operators are refused",
          /shell expansion[^.\n]{0,240}operators?[^.\n]{0,240}(?:unsupported|reject)|operators?[^.\n]{0,240}shell expansion[^.\n]{0,240}(?:unsupported|reject)/i,
        ],
        [
          "local and Docker actions are refused",
          /(?:local|\.\/) actions?[^.\n]{0,300}(?:Docker|docker:\/\/)[^.\n]{0,300}(?:unsupported|reject)|(?:Docker|docker:\/\/) actions?[^.\n]{0,300}(?:local|\.\/)[^.\n]{0,300}(?:unsupported|reject)/i,
        ],
        ["remote actions are refused", /remote action.*(?:out of scope|unsupported|reject)/is],
        ["nested workflows are refused", /nested workflow.*(?:unsupported|reject)/is],
        ["GitHub expressions and contexts are refused", /GitHub expressions?.*contexts?.*(?:unsupported|reject)/is],
        [
          "single-job execution boundary",
          /multi-job[^.\n]{0,300}(?:display|index)[^.\n]{0,300}(?:cannot execute|not executable|refus)|single-job[^.\n]{0,300}(?:execution|runtime)/i,
        ],
      ]),
      ...missing("docs/reference/workflows.md", [
        [
          "Markdown and GitHub-shaped YAML are peer formats",
          /Markdown.*GitHub[- ]shaped YAML.*peer|peer.*Markdown.*GitHub[- ]shaped YAML/is,
        ],
        ["new runs freeze durable v4", /new (?:run|start).*(?:IR|plan).*v4|v4.*new (?:run|start)/is],
        ["stored v3 runs resume unchanged", /v3.*resume.*(?:exact|unchanged|without.*(?:rewrite|normaliz|refreez))/is],
        ["0.9.3 boundary names GitHub semantics", /0\.9\.3[\s\S]{0,1600}(?:full GitHub|expressions|contexts)/i],
        ["0.9.3 boundary names actions", /0\.9\.3[\s\S]{0,1600}actions?/i],
        ["0.9.3 boundary names service events", /0\.9\.3[\s\S]{0,1600}(?:service )?events?/i],
        ["0.9.3 boundary names runners", /0\.9\.3[\s\S]{0,1600}runners?/i],
      ]),
      ...missing("docs/reference/supported-formats.md", [
        ["both workflow extensions", /workflow.*\.md.*\.yml|workflow.*\.yml.*\.md/is],
      ]),
      ...missing("docs/guides/author-workflows.md", [
        [
          "authors can choose Markdown or GitHub-shaped YAML",
          /Markdown.*GitHub[- ]shaped YAML|GitHub[- ]shaped YAML.*Markdown/is,
        ],
        ["YAML subset links to authoritative reference", /reference\/workflow-schema\.md/i],
      ]),
      ...missing("docs/guides/run-workflows.md", [
        ["new starts use v4", /new (?:run|start).*(?:v4|version 4)|(?:v4|version 4).*new (?:run|start)/is],
        ["v3 resume compatibility", /v3.*resume.*(?:exact|unchanged|compatibility)/is],
      ]),
      ...missing("docs/guides/scheduling.md", [
        [
          "scheduled fires fresh-freeze current source",
          /scheduled (?:fire|run)[^.\n]{0,300}(?:current source|re-read)[^.\n]{0,300}(?:fresh|new)[^.\n]{0,120}(?:freeze|v4)/i,
        ],
        [
          "sync evidence is not an executable snapshot",
          /(?:sync|validation) evidence[^.\n]{0,300}(?:not|never)[^.\n]{0,120}(?:executable|execution) snapshot/i,
        ],
      ]),
    ];
    expect(failures).toEqual([]);
  });

  test("states durable-v4 immutability, its narrow live-value exceptions, and at-least-once dispatch truth", () => {
    expect(
      missing("docs/architecture/workflow-engine.md", [
        ["durable plan IR v4", /(?:durable|frozen).*(?:IR|plan).*v4|v4.*(?:durable|frozen).*(?:IR|plan)/is],
        ["new starts persist v4", /new (?:run|start).*(?:persist|freeze|create).*v4|v4.*new (?:run|start)/is],
        [
          "v3 is an exact compatibility island",
          /v3.*(?:exact|byte[- ]stable|unchanged).*compatibility|compatibility island.*v3/is,
        ],
        [
          "resume does not re-read source or config",
          /resume.*does not re-read.*(?:source|config)|(?:source|config).*not re-read.*resume/is,
        ],
        ["frozen source read set", /source read set|sourceReadSet/i],
        [
          "resolved target runner cwd executable and git identity",
          /target.*runner.*(?:cwd|working director).*executable.*git/is,
        ],
        [
          "environment values are a narrow live exception",
          /environment (?:asset )?values?.*(?:narrow|only).*live.*exception|live[- ]value exception.*environment/is,
        ],
        [
          "environment owner key set and token topology stay frozen",
          /owner.*key set.*(?:secret[- ]token|token) topology.*(?:frozen|fixed)/is,
        ],
        [
          "pass-through values are read at dispatch",
          /pass-through.*(?:dispatch|materializ).*current|current.*pass-through.*(?:dispatch|materializ)/is,
        ],
        ["at-least-once execution", /at-least-once/i],
        [
          "crash reclaim reuses the stable dispatchId",
          /reclaim[^.\n]{0,300}(?:same|stable) dispatch(?:Id| ID)|dispatch(?:Id| ID)[^.\n]{0,300}(?:same|stable)[^.\n]{0,200}reclaim/i,
        ],
        [
          "explicit retries get a new dispatchId under one stable unit id",
          /retr(?:y|ies)[^.\n]{0,300}new dispatch(?:Id| ID)[^.\n]{0,300}stable unit (?:id|identity)|stable unit (?:id|identity)[^.\n]{0,300}retr(?:y|ies)[^.\n]{0,300}new dispatch(?:Id| ID)/i,
        ],
        [
          "ambiguous crash outcomes may rerun",
          /(?:unknown|ambiguous).*(?:outcome|dispatch).*(?:re-run|rerun|duplicate)|(?:re-run|rerun|duplicate).*(?:unknown|ambiguous).*(?:outcome|dispatch)/is,
        ],
      ]),
    ).toEqual([]);
  });

  test("documents safe command diagnostics and health checks without claiming value disclosure", () => {
    const failures = [
      ...missing("docs/reference/cli.md", [
        ["command run dry-run", /akm command run[^\n]*--dry-run/i],
        ["command-dry-run shape", /command-dry-run/],
        ["safe provenance fields", /field.*layer.*kind.*via/is],
        ["safe lowering notice fields", /code.*severity.*adapter.*field.*message/is],
        [
          "dry-run still performs authorization and lowering",
          /--dry-run[\s\S]{0,1200}(?:authoriz|policy)[\s\S]{0,500}(?:lower|lowering)|--dry-run[\s\S]{0,1200}(?:lower|lowering)[\s\S]{0,500}(?:authoriz|policy)/i,
        ],
        [
          "dry-run does not dispatch or materialize credentials",
          /--dry-run[\s\S]{0,1200}(?:does not|never)[\s\S]{0,200}dispatch[\s\S]{0,400}credential[^\n]{0,120}materializ/i,
        ],
        [
          "verbose diagnostics use stderr and preserve stdout",
          /--verbose[\s\S]{0,1000}stderr[\s\S]{0,500}stdout[^.\n]{0,160}(?:unchanged|preserv)|stdout[^.\n]{0,160}(?:unchanged|preserv)[\s\S]{0,500}--verbose[\s\S]{0,500}stderr/i,
        ],
        [
          "resolved values are excluded",
          /(?:never|does not).*(?:resolved values|prompt content|environment values|credential values)/is,
        ],
      ]),
      ...missing("docs/architecture/internals/health-advisories.md", [
        ["selected-model-aliases check", /selected-model-aliases/],
        ["configured-engines check", /configured-engines/],
        [
          "health checks do not make network calls",
          /(?:no|without).*(?:network|provider call)|(?:network|provider call).*(?:never|not)/is,
        ],
        [
          "health evidence excludes sensitive values",
          /evidence.*(?:never|does not).*(?:endpoint|model ID|credential|provider output)/is,
        ],
      ]),
      ...missing("docs/reference/data-and-telemetry.md", [
        [
          "command dry-run has no writes or usage",
          /command.*dry-run.*(?:no|without).*(?:write|usage|event)|(?:write|usage|event).*(?:never|not).*command.*dry-run/is,
        ],
      ]),
      ...missing("docs/architecture/internals/functional-contract-patterns.md", [
        [
          "provenance is field metadata not resolved values",
          /provenance.*(?:field|layer|kind|via).*(?:not|never).*(?:value|content)|(?:not|never).*(?:value|content).*provenance/is,
        ],
        ["lowering notices are secret-free", /secret-free.*(?:lowering )?notices|(?:lowering )?notices.*secret-free/is],
      ]),
    ];
    expect(failures).toEqual([]);
  });

  test("removes staged WP6/WP7 and single-format claims from current-truth docs", () => {
    const stale: Requirement[] = [
      ["claims task YAML begins with version 2", /task YAML[^.\n]*(?:begins|requires?)[^.\n]*version:\s*2/i],
      ["claims an akm-task bundle requires version 2", /akm-task[^.\n]*requires?[^.\n]*version:\s*2/i],
      [
        "describes a current task-v2 runtime arm",
        /(?:current|existing|new)[^.\n]*task[- ]v2[^.\n]*(?:arm|runtime|adapter)/i,
      ],
      ["claims task v3 is outstanding", /task[- ]v3[^.\n]*(?:outstanding|unfinished|remain(?:s|ed)? separate)/i],
      ["claims WP6 is unfinished", /WP6[^.\n]*(?:outstanding|unfinished|remain(?:s|ed)? separate)/i],
      ["claims WP7 is unfinished", /WP7[^.\n]*(?:outstanding|unfinished|remain(?:s|ed)? separate)/i],
      ["claims workflows have one Markdown-only format", /there is \*?\*?one\*?\*? format|one format[^.\n]*Markdown/i],
      [
        "claims there is no YAML workflow surface",
        /no separate YAML[^.\n]*(?:workflow|program)|no [`*]*\.ya?ml[^.\n]*workflow/i,
      ],
      ["defines every workflow as a structured Markdown document", /a workflow is a structured markdown document/i],
    ];
    const offenses: string[] = [];
    for (const relative of CURRENT_TRUTH_DOCS) {
      const text = read(relative);
      for (const [label, pattern] of stale) if (pattern.test(text)) offenses.push(`${relative}: ${label}`);
    }
    expect(offenses).toEqual([]);
  });

  test("marks staged design documents as historical and points to current truth instead of rewriting history", () => {
    const historical = [
      "docs/architecture/specs/agent-command-engine-model-design.md",
      "docs/plans/0.9.2-agent-command-workflow-plan.md",
    ];
    const failures: string[] = [];
    for (const relative of historical) {
      const banner = read(relative).split("\n").slice(0, 60).join("\n");
      if (!/(?:historical|superseded|implementation-complete)/i.test(banner)) {
        failures.push(`${relative}: historical/supersession banner`);
      }
      if (!/docs\/reference\/tasks\.md|\.\.\/\.\.\/reference\/tasks\.md|\.\.\/reference\/tasks\.md/i.test(banner)) {
        failures.push(`${relative}: current task reference link`);
      }
      if (!/workflow-schema\.md|workflow-engine\.md|reference\/workflows\.md/i.test(banner)) {
        failures.push(`${relative}: current workflow reference link`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("the 0.9.2 terminal note is self-contained and links the long-form guide", () => {
    expect(
      missing("docs/migration/release-notes/0.9.2.md", [
        ["terminal heading", /Migration notes for akm v0\.9\.2/i],
        ["task-v3 migration", /task v3/i],
        ["dry-run command", /akm migrate apply --dry-run/],
        ["workflow source IR and durable v4", /source IR.*(?:v1|version 1).*v4|v4.*source IR.*(?:v1|version 1)/is],
        ["judgment false change", /judgment:\s*false/],
        ["long-form guide", /v0\.9\.1-to-v0\.9\.2\.md/],
      ]),
    ).toEqual([]);
  });

  test("the release script inspects every required npm tar member", () => {
    const releaseCheck = read("tests/release-check.sh");
    for (const member of [
      "package/dist/assets/models.json",
      "package/docs/reference/tasks.md",
      "package/docs/migration/v0.9.1-to-v0.9.2.md",
      "package/docs/migration/release-notes/0.9.2.md",
      "package/docs/reference/workflow-schema.md",
    ]) {
      expect(releaseCheck).toContain(member);
    }
  });
});
