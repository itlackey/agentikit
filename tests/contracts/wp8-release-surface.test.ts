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

function markdownSectionText(markdown: string, headingPattern: RegExp): string | undefined {
  const lines = markdown.split("\n");
  const headings: Array<{ index: number; level: number; title: string }> = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const closing = line.match(/^\s*(`+|~+)\s*$/)?.[1];
      if (closing?.startsWith(fence.marker) && closing.length >= fence.length) fence = undefined;
      continue;
    }
    if (fenceMatch?.[1]) {
      const token = fenceMatch[1];
      fence = { marker: token[0] as "`" | "~", length: token.length };
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!heading?.[1] || !heading[2]) continue;
    headings.push({ index, level: heading[1].length, title: heading[2] });
  }

  const position = headings.findIndex(({ title }) => headingPattern.test(title));
  if (position < 0) return undefined;
  const start = headings[position];
  if (!start) return undefined;
  const next = headings.slice(position + 1).find(({ level }) => level <= start.level);
  return lines.slice(start.index + 1, next?.index ?? lines.length).join("\n");
}

function markdownSection(relative: string, headingPattern: RegExp): string | undefined {
  return markdownSectionText(read(relative), headingPattern);
}

function missingInSection(relative: string, heading: RegExp, requirements: readonly Requirement[]): string[] {
  const body = markdownSection(relative, heading);
  if (body === undefined) return [`${relative}: section ${heading}`];
  return requirements.filter(([, pattern]) => !pattern.test(body)).map(([label]) => `${relative}: ${label}`);
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
  "docs/reference/asset-types.md",
  "docs/reference/supported-formats.md",
  "docs/reference/tasks.md",
  "docs/reference/workflows.md",
  "docs/reference/workflow-schema.md",
  "docs/guides/author-workflows.md",
  "docs/guides/claude-code-vs-akm-workflows.md",
  "docs/guides/run-workflows.md",
  "docs/guides/scheduling.md",
  "docs/architecture/adapters.md",
  "docs/architecture/architecture.md",
  "docs/architecture/workflow-engine.md",
  "docs/architecture/comparisons/claude-code-vs-akm-workflows-full.md",
  "docs/architecture/internals/functional-contract-patterns.md",
  "docs/architecture/internals/health-advisories.md",
  "docs/architecture/internals/storage-locations.md",
  "schemas/akm-workflow.json",
  "src/assets/hints/cli-hints-full.md",
] as const;

describe("0.9.2 release surface", () => {
  test("section-scoped documentation checks ignore headings inside fenced examples", () => {
    const markdown = [
      "## Real section",
      "real body",
      "```markdown",
      "## Fake backtick heading",
      "```",
      "~~~markdown",
      "## Fake tilde heading",
      "~~~",
      "## Next section",
      "outside body",
    ].join("\n");

    expect(markdownSectionText(markdown, /fake backtick/i)).toBeUndefined();
    expect(markdownSectionText(markdown, /fake tilde/i)).toBeUndefined();
    expect(markdownSectionText(markdown, /real section/i)).toContain("## Fake backtick heading");
    expect(markdownSectionText(markdown, /real section/i)).not.toContain("outside body");
  });

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
          /\[[^\]]+\]\(https:\/\/github\.com\/itlackey\/akm\/blob\/[^/]+\/docs\/reference\/tasks\.md(?:#[^)]+)?\)/i,
        ],
        [
          "links the packaged 0.9.2 migration guide",
          /\[[^\]]+\]\(https:\/\/github\.com\/itlackey\/akm\/blob\/[^/]+\/docs\/migration\/v0\.9\.1-to-v0\.9\.2\.md(?:#[^)]+)?\)/i,
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

  test("keeps shipped hints, asset taxonomy, and the Markdown schema honest about peer sources", () => {
    const failures = [
      ...missing("src/assets/hints/cli-hints-full.md", [
        [
          "workflows are peer .md and .yml sources",
          /(?:peer|both)[^.\n]{0,240}\.md[^.\n]{0,240}\.yml|(?:peer|both)[^.\n]{0,240}\.yml[^.\n]{0,240}\.md/i,
        ],
        ["tasks use v3", /(?:task v3|tasks?[^.\n]{0,200}version:\s*3)/i],
      ]),
      ...missing("docs/reference/asset-types.md", [
        [
          "workflow assets include .md and .yml",
          /workflows?[^.\n]{0,240}\.md[^.\n]{0,240}\.yml|workflows?[^.\n]{0,240}\.yml[^.\n]{0,240}\.md/i,
        ],
      ]),
    ];

    const hints = read("src/assets/hints/cli-hints-full.md");
    for (const [label, pattern] of [
      ["calls workflows unified Markdown", /unified markdown (?:workflows?|assets?)/i],
      [
        "claims workflows are Markdown-only",
        /markdown-only[^.\n]*workflows?|workflows?[^.\n]*markdown-only|workflows live[^\n]{0,200}markdown assets(?![^\n]*\.yml)/i,
      ],
      ["advertises retired akm agent --workflow", /akm agent[^\n]*--workflow/i],
      ["advertises legacy task timeoutMs", /\btimeoutMs\b/],
    ] satisfies Requirement[]) {
      if (pattern.test(hints)) failures.push(`src/assets/hints/cli-hints-full.md: ${label}`);
    }

    const assetTypes = read("docs/reference/asset-types.md");
    if (
      /workflows\/[^\n]*\(\.md\)(?![^\n]*\.yml)|workflows?[^.\n]{0,160}\.md[^.\n]{0,80}(?:only|sole)/i.test(assetTypes)
    ) {
      failures.push("docs/reference/asset-types.md: describes an md-only workflow surface");
    }

    const workflowSchema = JSON.parse(read("schemas/akm-workflow.json")) as { description?: string };
    const schemaDescription = workflowSchema.description ?? "";
    if (
      !/(?:this )?frontmatter schema[^.]{0,160}(?:applies to|describes|validates)[^.]{0,120}(?:the )?(?:Markdown|\.md)[^.]{0,40}(?:workflow )?source/i.test(
        schemaDescription,
      )
    ) {
      failures.push("schemas/akm-workflow.json: description scopes this frontmatter schema to the Markdown source");
    }
    if (!/(?:not|never)[^.]{0,160}(?:sole|only)[^.]{0,120}workflow source/i.test(schemaDescription)) {
      failures.push("schemas/akm-workflow.json: description says Markdown is not the sole workflow source");
    }

    expect(failures).toEqual([]);
  });

  test("documents the exact task-v3 grammar, supported targets, refusals, and fail-closed v2 migration", () => {
    const failures = [
      ...missingInSection("docs/reference/tasks.md", /files?|schema/i, [
        ["the only task extension is .yml", /\.yml.*(?:only|recognized)|only.*\.yml/is],
        [
          ".yaml is a rejected near miss",
          /\.yaml.*(?:never|not).*(?:index|schedul|run)|(?:never|not).*(?:index|schedul|run).*\.yaml/is,
        ],
        ["version 3 is mandatory", /version:\s*3/],
        ["links the shipped task schema", /\[[^\]]*schema[^\]]*\]\(\.\.\/\.\.\/schemas\/akm-task\.json(?:#[^)]+)?\)/i],
      ]),
      ...missingInSection("docs/reference/tasks.md", /executable|targets?|uses.*run/i, [
        ["uses xor run", /exactly one of [`*]*uses[`*]* (?:or|and) [`*]*run|uses.*run.*mutual/is],
        ["built-in command target", /akm\/command/],
        [
          "akm/command requires exactly one with.ref xor with.content",
          /akm\/command[\s\S]{0,800}exactly one[\s\S]{0,300}with\.ref[\s\S]{0,300}with\.content|akm\/command[\s\S]{0,800}with\.ref[\s\S]{0,300}with\.content[\s\S]{0,300}(?:mutually exclusive|xor)/i,
        ],
        [
          "akm/command with.arguments is one optional portable string",
          /with\.arguments[^.\n]{0,240}(?:optional)[^.\n]{0,240}(?:portable)[^.\n]{0,120}(?:single |one )?string|with\.arguments[^.\n]{0,240}(?:optional)[^.\n]{0,240}(?:single |one )?portable string/i,
        ],
        ["command workflow and script refs", /commands\/.*workflows\/.*scripts\//is],
        [
          "revision-qualified GitHub action syntax is recognized but not acquired",
          /revision-qualified[\s\S]{0,300}owner\/repo(?:\[\/path\]|\/path)?@(?:ref|revision)[\s\S]{0,500}recognized[\s\S]{0,300}(?:remote action acquisition|unsupported in 0\.9\.2)|owner\/repo(?:\[\/path\]|\/path)?@(?:ref|revision)[\s\S]{0,300}revision-qualified[\s\S]{0,500}recognized[\s\S]{0,300}(?:remote action acquisition|unsupported in 0\.9\.2)/i,
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
      ]),
      ...missingInSection("docs/reference/tasks.md", /schedul|triggers?/i, [
        [
          "akm.schedule xor on",
          /exactly one.*(?:akm\.schedule).*(?:`on`|\bon\b)|(?:akm\.schedule).*(?:`on`|\bon\b).*exactly one/is,
        ],
      ]),
      ...missingInSection("docs/reference/tasks.md", /migrat.*v2|v2.*v3|upgrade/i, [
        [
          "normal execution rejects v2",
          /(?:normal )?execution.*(?:reject|does not accept).*v2|v2.*(?:reject|does not accept).*(?:normal )?execution/is,
        ],
        ["migration preview", /akm migrate apply --dry-run/],
        ["migration apply", /akm migrate apply(?:`|\s|$)/m],
        ["ambiguous argv arrays are blocked", /argv array.*(?:block|manual)|(?:block|manual).*argv array/is],
      ]),
      ...missingInSection("docs/migration/v0.9.1-to-v0.9.2.md", /before.*(?:task )?v2|0\.9\.1.*task v2/i, [
        ["v2 before example", /(?:before|0\.9\.1)[\s\S]*version:\s*2/i],
      ]),
      ...missingInSection("docs/migration/v0.9.1-to-v0.9.2.md", /after.*(?:task )?v3|0\.9\.2.*task v3/i, [
        ["v3 after example", /(?:after|0\.9\.2)[\s\S]*version:\s*3/i],
      ]),
      ...missingInSection("docs/migration/v0.9.1-to-v0.9.2.md", /procedure|preview.*apply|migrat.*safely/i, [
        ["preview and apply commands", /akm migrate apply --dry-run[\s\S]*akm migrate apply/i],
        ["validation completes before replacement", /validat[^.\n]{0,240}before[^.\n]{0,160}replac/i],
        [
          "backup is immediate before replacement",
          /(?:back(?:s|ed)? up|backup)[^.\n]{0,160}immediately before[^.\n]{0,160}replac/i,
        ],
        ["preserves schedule", /preserv[^.\n]{0,300}\bschedule\b/i],
        ["preserves enabled state", /preserv[^.\n]{0,300}\benabled\b/i],
        ["preserves params", /preserv[^.\n]{0,300}\bparams\b/i],
        ["preserves timeout", /preserv[^.\n]{0,300}\btimeout\b/i],
        ["preserves redaction", /preserv[^.\n]{0,300}\bredaction\b/i],
        ["preserves resolver overrides", /preserv[^.\n]{0,300}resolver overrides?/i],
        ["reports every file", /every (?:input )?file|each (?:input )?file/i],
        ["reports exact changed status", /`changed`/],
        ["reports exact skipped status", /`skipped`/],
        ["reports exact blocked status", /`blocked`/],
      ]),
      ...missingInSection("docs/migration/v0.9.1-to-v0.9.2.md", /blocked|manual review/i, [
        ["argv-array manual case", /argv array.*(?:block|manual)|(?:block|manual).*argv array/is],
      ]),
      ...missingInSection("docs/reference/cli.md", /^task$/i, [
        ["links the canonical task reference", /\[[^\]]+\]\(tasks\.md(?:#[^)]+)?\)/i],
        ["names task v3", /task v3/i],
      ]),
      ...missingInSection("docs/reference/supported-formats.md", /task/i, [
        ["task .yml-only v3 contract", /akm-task.*\.yml.*(?:version\s*3|v3)|(?:version\s*3|v3).*akm-task.*\.yml/is],
      ]),
      ...missingInSection("docs/architecture/adapters.md", /task/i, [
        ["adapter task-v3 contract", /akm-task.*(?:version:\s*3|task v3)|(?:version:\s*3|task v3).*akm-task/is],
      ]),
      ...missingInSection("docs/guides/scheduling.md", /task definitions.*scheduler state|task source/i, [
        ["links the task source reference", /\[[^\]]+\]\(\.\.\/reference\/tasks\.md(?:#[^)]+)?\)/i],
        ["names task v3", /task v3/i],
      ]),
    ];
    expect(failures).toEqual([]);
  });

  test("documents peer workflow sources, source IR v1, durable v4, and the explicit 0.9.3 boundary", () => {
    const failures = [
      ...missingInSection("docs/reference/workflow-schema.md", /source formats|shared IR/i, [
        [
          "peer .md and .yml sources",
          /(?:peer|both)[^\n]{0,160}\.md[^\n]{0,160}\.yml|(?:peer|both)[^\n]{0,160}\.yml[^\n]{0,160}\.md/i,
        ],
        [".yaml is not a workflow source", /\.yaml.*(?:not|unsupported|reject)|(?:not|unsupported|reject).*\.yaml/is],
        ["shared source IR v1", /source IR (?:version )?1|sourceIrVersion:?\s*1/i],
      ]),
      ...missingInSection("docs/reference/workflow-schema.md", /GitHub.*YAML.*subset/i, [
        ["GitHub YAML root vocabulary", /\bname\b.*\bon\b.*\bjobs\b/is],
        [
          "complete on and jobs source is one workflow asset",
          /(?:complete|valid)[^.\n]{0,160}(?:`on`|\bon\b)[^.\n]{0,160}(?:`jobs`|\bjobs\b)[^.\n]{0,240}(?:one|single)[^.\n]{0,80}workflow asset/i,
        ],
        [
          "complete workflow does not create a duplicate task asset",
          /(?:does not|never|no)[^.\n]{0,160}(?:duplicate|second)[^.\n]{0,80}task asset|task asset[^.\n]{0,160}(?:does not|never)[^.\n]{0,120}(?:duplicate|second)/i,
        ],
        ["local runner restriction", /runs-on:\s*\[self-hosted\]/i],
        ["schedule and manual triggers", /schedule.*workflow_dispatch/is],
        [
          "workflow_dispatch takes no inputs",
          /workflow_dispatch[^.\n]{0,200}(?:empty|no inputs|inputs are unsupported)/i,
        ],
        ["service events are refused", /service events?[^.\n]{0,300}(?:unsupported|reject)/i],
        [
          "rejected service events create no watcher",
          /service events?[^.\n]{0,300}(?:does not|never|no)[^.\n]{0,160}watcher|(?:does not|never|no)[^.\n]{0,160}watcher[^.\n]{0,300}service events?/i,
        ],
        [
          "rejected service events create no polling daemon",
          /service events?[^.\n]{0,300}(?:does not|never|no)[^.\n]{0,160}poll(?:ing)?(?: daemon)?|(?:does not|never|no)[^.\n]{0,160}poll(?:ing)?(?: daemon)?[^.\n]{0,300}service events?/i,
        ],
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
      ...missingInSection("docs/reference/workflows.md", /source formats|execution versions/i, [
        [
          "Markdown and GitHub-shaped YAML are peer formats",
          /Markdown.*GitHub[- ]shaped YAML.*peer|peer.*Markdown.*GitHub[- ]shaped YAML/is,
        ],
        ["new runs freeze durable v4", /new (?:run|start).*(?:IR|plan).*v4|v4.*new (?:run|start)/is],
        ["stored v3 runs resume unchanged", /v3.*resume.*(?:exact|unchanged|without.*(?:rewrite|normaliz|refreez))/is],
      ]),
      ...missingInSection("docs/reference/workflows.md", /0\.9\.3|unsupported.*boundary/i, [
        ["0.9.3 boundary names GitHub semantics", /0\.9\.3[\s\S]{0,1600}(?:full GitHub|expressions|contexts)/i],
        ["0.9.3 boundary names actions", /0\.9\.3[\s\S]{0,1600}actions?/i],
        ["0.9.3 boundary names service events", /0\.9\.3[\s\S]{0,1600}(?:service )?events?/i],
        ["0.9.3 boundary names runners", /0\.9\.3[\s\S]{0,1600}runners?/i],
      ]),
      ...missingInSection("docs/reference/supported-formats.md", /workflow/i, [
        ["both workflow extensions", /workflow.*\.md.*\.yml|workflow.*\.yml.*\.md/is],
      ]),
      ...missingInSection("docs/guides/author-workflows.md", /start from the template|source formats/i, [
        [
          "authors can choose Markdown or GitHub-shaped YAML",
          /Markdown.*GitHub[- ]shaped YAML|GitHub[- ]shaped YAML.*Markdown/is,
        ],
        [
          "YAML subset links to authoritative reference",
          /\[[^\]]+\]\(\.\.\/reference\/workflow-schema\.md(?:#[^)]+)?\)/i,
        ],
      ]),
      ...missingInSection("docs/guides/run-workflows.md", /start or continue a run|start.*run/i, [
        ["new starts use v4", /new (?:run|start).*(?:v4|version 4)|(?:v4|version 4).*new (?:run|start)/is],
      ]),
      ...missingInSection("docs/guides/run-workflows.md", /resume a blocked or failed run|resume/i, [
        ["v3 resume compatibility", /v3.*resume.*(?:exact|unchanged|compatibility)/is],
      ]),
      ...missingInSection("docs/guides/scheduling.md", /task definitions.*scheduler state|scheduled workflow/i, [
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

  test("keeps both maintained workflow comparisons on the peer-source and durable-v4 contract", () => {
    const comparisonDocs = [
      "docs/guides/claude-code-vs-akm-workflows.md",
      "docs/architecture/comparisons/claude-code-vs-akm-workflows-full.md",
    ] as const;
    const failures: string[] = [];

    for (const relative of comparisonDocs) {
      failures.push(
        ...missing(relative, [
          [
            "peer .md and .yml workflow sources",
            /(?:peer|both)[^.\n]{0,200}\.md[^.\n]{0,200}\.yml|(?:peer|both)[^.\n]{0,200}\.yml[^.\n]{0,200}\.md/i,
          ],
          ["shared source IR v1", /source IR (?:version )?1|sourceIrVersion:?\s*1/i],
          [
            "new starts freeze durable plan IR v4",
            /new (?:run|start)[^.\n]{0,240}(?:freeze|persist|store)[^.\n]{0,180}(?:durable )?(?:plan )?IR v4|(?:durable )?(?:plan )?IR v4[^.\n]{0,240}new (?:run|start)/i,
          ],
        ]),
      );

      const text = read(relative);
      for (const [label, pattern] of [
        ["claims workflows are Markdown-defined", /(?:AKM|akm) workflows?[\s\S]{0,160}Markdown-defined/i],
        [
          "claims a reusable workflow is one Markdown asset",
          /(?:workflow|format|artifact)[\s\S]{0,180}(?:one|single)[\s\S]{0,100}Markdown asset|(?:one|single)[\s\S]{0,100}Markdown asset[\s\S]{0,180}workflow/i,
        ],
        [
          "claims the workflow format is unified Markdown",
          /(?:unified|managed)[\s\S]{0,80}Markdown (?:format|asset)|workflow asset type[\s\S]{0,160}unified Markdown/i,
        ],
        [
          "claims durable definitions are Markdown-only",
          /durable[\s\S]{0,120}Markdown definition|Markdown-only[\s\S]{0,160}workflow|workflow[\s\S]{0,160}Markdown-only/i,
        ],
      ] satisfies Requirement[]) {
        if (pattern.test(text)) failures.push(relative + ": " + label);
      }
    }

    expect(failures).toEqual([]);
  });

  test("keeps the full comparison on the single native workflow surface and live six-command CLI", () => {
    const relative = "docs/architecture/comparisons/claude-code-vs-akm-workflows-full.md";
    const text = read(relative);
    const retiredCommands = read("src/cli/retired-commands.ts");
    const workflowCli = read("src/commands/workflow-cli.ts");

    expect(retiredCommands).toMatch(
      /"workflow brief"[\s\S]{0,300}removed[\s\S]{0,300}external-driver protocol is gone/i,
    );
    expect(retiredCommands).toMatch(
      /"workflow report"[\s\S]{0,300}removed[\s\S]{0,300}external-driver protocol is gone/i,
    );

    const subCommandsBody = workflowCli.match(
      /export const workflowCommand[\s\S]*?subCommands:\s*\{([\s\S]*?)\n\s*\},\n\s*\/\//,
    )?.[1];
    const publicCommands = [...(subCommandsBody ?? "").matchAll(/^\s*([a-z][a-z-]*):\s*workflow[A-Z]/gm)].map(
      (match) => match[1],
    );
    expect(publicCommands).toEqual(["status", "list", "create", "resume", "abandon", "run"]);

    const failures = missing(relative, [
      [
        "akm workflow run is the one stable native execution surface",
        /(?:one|single)[^.\n]{0,120}(?:stable )?native[^.\n]{0,120}(?:execution|orchestration)[^.\n]{0,80}surface[^.\n]{0,160}akm workflow run|akm workflow run[^.\n]{0,160}(?:one|single)[^.\n]{0,120}(?:stable )?native[^.\n]{0,120}(?:execution|orchestration)[^.\n]{0,80}surface/i,
      ],
      [
        "a second run against a live lease refuses",
        /second[\s\S]{0,160}\brun\b[\s\S]{0,160}live[- ]lease[\s\S]{0,160}refus/i,
      ],
      [
        "native completion evaluates the promoted artifact",
        /native[^.\n]{0,100}completion[^.\n]{0,160}promoted artifact/i,
      ],
      ["the native engine owns the step spine", /native engine[^.\n]{0,180}owns[^.\n]{0,120}step spine/i],
      [
        "peer source formats share source IR rather than one unified format",
        /peer[^.\n]{0,160}(?:source )?formats?[^.\n]{0,200}(?:shared|same)[^.\n]{0,160}source IR/i,
      ],
    ]);

    const cliSection = markdownSectionText(text, /CLI surface/i);
    if (!cliSection) {
      failures.push(`${relative}: CLI surface section`);
    } else {
      if (!/(?:exactly )?(?:six|6)[^.\n]{0,100}(?:public )?subcommands/i.test(cliSection)) {
        failures.push(`${relative}: exactly six public workflow subcommands`);
      }
      const documented = cliSection.match(/akm workflow ([a-z]+(?:\|[a-z]+)+)/)?.[1]?.split("|") ?? [];
      if (documented.join("|") !== publicCommands.join("|")) {
        failures.push(`${relative}: documented subcommand list matches workflowCommand.subCommands`);
      }
      if (/\beight\b[^.\n]{0,80}subcommands/i.test(cliSection)) {
        failures.push(`${relative}: stale eight-subcommand count`);
      }
    }

    for (const [label, pattern] of [
      ["mentions retired driver report calls", /driver\s+`?report`?\s+calls/i],
      ["claims external-driver completion", /external-driver completion/i],
      ["claims engine/driver execution", /\bengine\/driver\b/i],
      [
        "claims multiple akm execution surfaces",
        /\btwo (?:different )?(?:execution )?surfaces?\b|which execution surface is in play/i,
      ],
      [
        "claims the live driver protocol shipped",
        /driver\s+protocol[\s\S]{0,120}(?:shipped[\s\S]{0,80}live|live[\s\S]{0,80}shipped)/i,
      ],
      ["calls the peer source parser one unified format", /\b(?:the )?unified (?:Markdown )?(?:workflow )?format\b/i],
    ] satisfies Requirement[]) {
      if (pattern.test(text)) failures.push(`${relative}: ${label}`);
    }

    expect(failures).toEqual([]);
  });

  test("states durable-v4 immutability, its narrow live-value exceptions, and at-least-once dispatch truth", () => {
    const failures = [
      ...missingInSection("docs/architecture/workflow-engine.md", /frozen plans?|durable plan/i, [
        ["durable plan IR v4", /(?:durable|frozen).*(?:IR|plan).*v4|v4.*(?:durable|frozen).*(?:IR|plan)/is],
        ["new starts persist v4", /new (?:run|start).*(?:persist|freeze|create).*v4|v4.*new (?:run|start)/is],
        ["frozen source read set", /source read set|sourceReadSet/i],
        [
          "resolved request is frozen",
          /(?:frozen|immutable)[^.\n]{0,240}resolved request|resolved request[^.\n]{0,240}(?:frozen|immutable)/i,
        ],
        [
          "resolved target is frozen",
          /(?:frozen|immutable)[^.\n]{0,240}resolved target|resolved target[^.\n]{0,240}(?:frozen|immutable)/i,
        ],
        [
          "runner selection is frozen",
          /(?:frozen|immutable)[^.\n]{0,240}runner|runner[^.\n]{0,240}(?:frozen|immutable)/i,
        ],
        [
          "working directory is frozen",
          /(?:frozen|immutable)[^.\n]{0,240}(?:cwd|working director)|(?:cwd|working director)[^.\n]{0,240}(?:frozen|immutable)/i,
        ],
        [
          "executable is frozen",
          /(?:frozen|immutable)[^.\n]{0,240}executable|executable[^.\n]{0,240}(?:frozen|immutable)/i,
        ],
        [
          "git identity is frozen",
          /(?:frozen|immutable)[^.\n]{0,240}git identity|git identity[^.\n]{0,240}(?:frozen|immutable)/i,
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
      ]),
      ...missingInSection("docs/architecture/workflow-engine.md", /resume is journaled replay|resume/i, [
        [
          "v3 is an exact compatibility island",
          /v3.*(?:exact|byte[- ]stable|unchanged).*compatibility|compatibility island.*v3/is,
        ],
        [
          "resume does not re-read authored source",
          /resume[^.\n]{0,300}(?:does not|never)[^.\n]{0,160}(?:re-read|reread)[^.\n]{0,160}authored (?:workflow )?source|authored (?:workflow )?source[^.\n]{0,300}(?:not|never)[^.\n]{0,160}(?:re-read|reread)[^.\n]{0,160}resume/i,
        ],
        [
          "resume does not re-read config",
          /resume[^.\n]{0,300}(?:does not|never)[^.\n]{0,160}(?:re-read|reread)[^.\n]{0,160}(?:config|configuration)|(?:config|configuration)[^.\n]{0,300}(?:not|never)[^.\n]{0,160}(?:re-read|reread)[^.\n]{0,160}resume/i,
        ],
        [
          "resume does not re-read the index",
          /resume[^.\n]{0,300}(?:does not|never)[^.\n]{0,160}(?:re-read|reread)[^.\n]{0,160}(?:asset )?index|(?:asset )?index[^.\n]{0,300}(?:not|never)[^.\n]{0,160}(?:re-read|reread)[^.\n]{0,160}resume/i,
        ],
      ]),
      ...missingInSection("docs/architecture/workflow-engine.md", /durable attempts?|at-least-once/i, [
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
    ];
    expect(failures).toEqual([]);
  });

  test("prohibits whole-process environment inheritance for new v4 starts and preserves only stored-v3 compatibility", () => {
    const failures = [
      ...missingInSection("docs/reference/workflow-schema.md", /child's environment|environment.*allowlist/i, [
        [
          "new v4 starts reject inherit_env",
          /(?:new|v4)[^.\n]{0,240}(?:reject|forbid)[^.\n]{0,160}inherit_env|inherit_env[^.\n]{0,160}(?:reject|forbid)[^.\n]{0,240}(?:new|v4)/i,
        ],
        [
          "authors use named env bindings or pass_env",
          /named (?:environment|env) bindings?[^.\n]{0,200}pass_env|pass_env[^.\n]{0,200}named (?:environment|env) bindings?/i,
        ],
        [
          "inherit_env is stored-v3 compatibility only",
          /inherit_env[^.\n]{0,240}stored[^.\n]{0,120}v3|stored[^.\n]{0,120}v3[^.\n]{0,240}inherit_env/i,
        ],
      ]),
      ...missingInSection("docs/guides/author-workflows.md", /what the command can see|environment/i, [
        [
          "new starts reject inherit_env",
          /(?:new|v4)[^.\n]{0,240}(?:reject|forbid)[^.\n]{0,160}inherit_env|inherit_env[^.\n]{0,160}(?:reject|forbid)[^.\n]{0,240}(?:new|v4)/i,
        ],
        [
          "authors use env bindings and pass_env",
          /(?:env bindings?|env:)[^.\n]{0,220}pass_env|pass_env[^.\n]{0,220}(?:env bindings?|env:)/i,
        ],
      ]),
      ...missingInSection("docs/guides/run-workflows.md", /security.*workflow sources|executed code/i, [
        [
          "new v4 starts reject inherit_env",
          /(?:new|v4)[^.\n]{0,240}(?:reject|forbid)[^.\n]{0,160}inherit_env|inherit_env[^.\n]{0,160}(?:reject|forbid)[^.\n]{0,240}(?:new|v4)/i,
        ],
        [
          "stored v3 runs resume unchanged",
          /stored[^.\n]{0,120}v3[^.\n]{0,200}resume[^.\n]{0,120}(?:unchanged|exact)/i,
        ],
      ]),
      ...missingInSection("docs/architecture/testing/manual-testing-checklist.md", /exec \(shell\) units/i, [
        ["manual check expects new inherit_env refusal", /inherit_env:\s*true[\s\S]{0,500}(?:reject|refus|fail)/i],
        [
          "manual check uses named env or pass_env instead",
          /(?:named (?:environment|env) bindings?|env:)[\s\S]{0,400}pass_env|pass_env[\s\S]{0,400}(?:named (?:environment|env) bindings?|env:)/i,
        ],
      ]),
      ...missingInSection("docs/migration/v0.9.1-to-v0.9.2.md", /workflow compatibility/i, [
        ["migration calls inherit_env removal breaking", /inherit_env[\s\S]{0,400}(?:breaking|reject|forbid)/i],
        [
          "migration preserves stored v3 resume only",
          /stored[^.\n]{0,160}v3[^.\n]{0,240}resume[^.\n]{0,160}(?:unchanged|exact)/i,
        ],
        [
          "migration directs authors to named bindings or pass_env",
          /named (?:environment|env) bindings?[^.\n]{0,240}pass_env|pass_env[^.\n]{0,240}named (?:environment|env) bindings?/i,
        ],
      ]),
    ];

    const released = section(read("CHANGELOG.md"), "0.9.2") ?? "";
    for (const [label, pattern] of [
      ["CHANGELOG.md: v4 inherit_env breaking note", /inherit_env[\s\S]{0,400}(?:breaking|reject|forbid)/i],
      [
        "CHANGELOG.md: named binding/pass_env replacement",
        /named (?:environment|env) bindings?[\s\S]{0,240}pass_env|pass_env[\s\S]{0,240}named (?:environment|env) bindings?/i,
      ],
      [
        "CHANGELOG.md: stored v3 compatibility only",
        /stored[^.\n]{0,160}v3[^.\n]{0,240}resume[^.\n]{0,160}(?:unchanged|exact)/i,
      ],
    ] satisfies Requirement[]) {
      if (!pattern.test(released)) failures.push(label);
    }

    const currentGuidance = [
      "docs/reference/workflow-schema.md",
      "docs/guides/author-workflows.md",
      "docs/guides/run-workflows.md",
      "docs/architecture/testing/manual-testing-checklist.md",
    ] as const;
    const positiveInheritance =
      /inherit_env(?::\s*true)?[^.\n]{0,180}(?:escape hatch|hands? (?:the )?command|gives? (?:the )?command|opts? (?:all the way )?back|restores? full|whole environment)/i;
    for (const relative of currentGuidance) {
      if (positiveInheritance.test(read(relative))) failures.push(`${relative}: positively recommends inherit_env`);
    }

    expect(failures).toEqual([]);
  });

  test("pins the task-v3 target matrix and closed script interpreter table", () => {
    const failures = [
      ...missingInSection("docs/reference/tasks.md", /files?|schema/i, [
        [
          "canonical example uses a workflow when supplying with params",
          /uses:\s*workflows\/[^\n]+\nwith:\n(?:\s{2,}.+\n)+/i,
        ],
      ]),
      ...missingInSection("docs/reference/tasks.md", /executable|targets?|uses.*run/i, [
        [
          "direct command refs reject with",
          /commands\/[^.\n]{0,240}with[^.\n]{0,160}(?:reject|does not accept|unsupported)/i,
        ],
        ["script refs reject with", /scripts\/[^.\n]{0,240}with[^.\n]{0,160}(?:reject|does not accept|unsupported)/i],
        [
          "workflow refs alone consume with as params",
          /workflows\/[^.\n]{0,300}(?:only|alone)[^.\n]{0,160}with[^.\n]{0,160}params|with[^.\n]{0,160}params[^.\n]{0,300}workflows?[^.\n]{0,120}(?:only|alone)/i,
        ],
        [
          "nonempty workflow task env is rejected",
          /workflow[^.\n]{0,240}(?:non-?empty )?(?:task )?env[^.\n]{0,240}(?:reject|does not accept|cannot consume)/i,
        ],
        ["script .sh interpreter", /\.sh[^.\n]{0,80}(?:`?sh`?|POSIX shell)/i],
        [
          "script .ts and .js require Bun",
          /(?:\.ts[^.\n]{0,80}\.js|\.js[^.\n]{0,80}\.ts)[^.\n]{0,120}(?:require|needs?) Bun/i,
        ],
        ["script PowerShell interpreter", /\.ps1[^.\n]{0,100}(?:PowerShell|powershell)/i],
        [
          "script cmd interpreter",
          /(?:\.cmd[^.\n]{0,80}\.bat|\.bat[^.\n]{0,80}\.cmd)[^.\n]{0,100}(?:`?cmd`?|Command Prompt)/i,
        ],
        ["script Python interpreter", /\.py[^.\n]{0,80}(?:`?python`?|Python)/i],
        ["script Ruby interpreter", /\.rb[^.\n]{0,80}(?:`?ruby`?|Ruby)/i],
        ["script Go interpreter", /\.go[^.\n]{0,80}(?:go run|Go)/i],
        ["script Perl interpreter", /\.pl[^.\n]{0,80}(?:`?perl`?|Perl)/i],
        ["script PHP interpreter", /\.php[^.\n]{0,80}(?:`?php`?|PHP)/i],
        ["script Lua interpreter", /\.lua[^.\n]{0,80}(?:`?lua`?|Lua)/i],
        ["script R interpreter", /\.r[^.\n]{0,80}(?:Rscript|`?rscript`?)/i],
        ["script Swift interpreter", /\.swift[^.\n]{0,80}(?:`?swift`?|Swift)/i],
        [
          "script Kotlin interpreter",
          /(?:\.kt[^.\n]{0,80}\.kts|\.kts[^.\n]{0,80}\.kt)[^.\n]{0,100}(?:Kotlin|kotlin|kotlinc)/i,
        ],
      ]),
    ];
    expect(failures).toEqual([]);
  });

  test("keeps the storage inventory current with source IR, durable plans, attempts, and source peers", () => {
    const failures = [
      ...missingInSection("docs/architecture/internals/storage-locations.md", /table.*workflow_documents/i, [
        ["workflow source IR v1", /source IR (?:version )?1|sourceIrVersion:?\s*1/i],
        [
          "peer .md and .yml workflow sources",
          /(?:peer|both)[^.\n]{0,160}\.md[^.\n]{0,160}\.yml|(?:peer|both)[^.\n]{0,160}\.yml[^.\n]{0,160}\.md/i,
        ],
      ]),
      ...missingInSection("docs/architecture/internals/storage-locations.md", /table.*workflow_runs/i, [
        [
          "new starts persist plan IR v4",
          /new (?:run|start)[^.\n]{0,240}(?:persist|freeze|store)[^.\n]{0,160}(?:plan )?IR v4|(?:plan )?IR v4[^.\n]{0,240}new (?:run|start)/i,
        ],
        [
          "stored v3 plans resume unchanged",
          /stored[^.\n]{0,160}v3[^.\n]{0,240}resume[^.\n]{0,120}(?:unchanged|exact)/i,
        ],
      ]),
      ...missingInSection("docs/architecture/internals/storage-locations.md", /table.*workflow_run_units/i, [
        ["links the append-only attempt table", /workflow_run_unit_attempts[^.\n]{0,240}(?:append-only|v4)/i],
      ]),
      ...missing("docs/architecture/internals/storage-locations.md", [
        ["workflow_run_unit_attempts table", /#### Table: `workflow_run_unit_attempts`/],
        [
          "attempt table primary key",
          /workflow_run_unit_attempts[\s\S]{0,2600}PRIMARY KEY[^.\n]{0,160}run_id[^.\n]{0,160}unit_id[^.\n]{0,160}attempt/i,
        ],
      ]),
      ...missingInSection("docs/architecture/internals/storage-locations.md", /primary bundle content/i, [
        [
          "task sources are .yml task v3",
          /tasks\/[^.\n]{0,180}\.yml[^.\n]{0,180}(?:task )?v3|(?:task )?v3[^.\n]{0,180}tasks\/[^.\n]{0,180}\.yml/i,
        ],
        [
          "workflow sources are peer .md and .yml",
          /workflows\/[^.\n]{0,240}(?:peer|both)[^.\n]{0,160}\.md[^.\n]{0,160}\.yml|workflows\/[^.\n]{0,240}(?:peer|both)[^.\n]{0,160}\.yml[^.\n]{0,160}\.md/i,
        ],
      ]),
    ];
    expect(failures).toEqual([]);
  });

  test("documents health status and exit semantics for hard checks and advisories", () => {
    expect(
      missing("docs/architecture/internals/health-advisories.md", [
        [
          "deterministic hard and advisory warnings produce overall warn and exit 4",
          /deterministic[^.\n]{0,200}(?:hard[^.\n]{0,100}advisory|advisory[^.\n]{0,100}hard)[^.\n]{0,200}warn[^.\n]{0,160}(?:overall )?status[^.\n]{0,80}warn[^.\n]{0,160}exit(?: code)?\s*4/i,
        ],
        [
          "hard fail produces overall fail and exit 1",
          /hard[^.\n]{0,160}fail[^.\n]{0,160}(?:overall )?status[^.\n]{0,80}fail[^.\n]{0,160}exit(?: code)?\s*1/i,
        ],
        [
          "heuristic advisory warn does not change overall status",
          /(?:heuristic|non-deterministic)[^.\n]{0,120}advisory[^.\n]{0,180}warn[^.\n]{0,220}(?:does not|never)[^.\n]{0,160}(?:change|gate)[^.\n]{0,120}(?:overall )?status/i,
        ],
        [
          "heuristic advisory warn does not change exit code",
          /(?:heuristic|non-deterministic)[^.\n]{0,120}advisory[^.\n]{0,180}warn[^.\n]{0,220}(?:does not|never)[^.\n]{0,160}(?:change|gate)[^.\n]{0,120}exit(?: code)?/i,
        ],
      ]),
    ).toEqual([]);
  });

  test("documents safe command diagnostics and health checks without claiming value disclosure", () => {
    const failures = [
      ...missingInSection("docs/reference/cli.md", /^command run$/i, [
        ["command run dry-run", /akm command run[^\n]*--dry-run/i],
        ["command-dry-run shape", /command-dry-run/],
        ["safe provenance fields", /field.*layer.*kind.*via/is],
        ["safe lowering notice fields", /code.*severity.*adapter.*field.*message/is],
        [
          "dry-run still performs authorization and lowering",
          /--dry-run[\s\S]{0,1200}(?:authoriz|policy)[\s\S]{0,500}(?:lower|lowering)|--dry-run[\s\S]{0,1200}(?:lower|lowering)[\s\S]{0,500}(?:authoriz|policy)/i,
        ],
        ["dry-run does not dispatch", /--dry-run[\s\S]{0,1200}(?:does not|never)[^.\n]{0,200}dispatch/i],
        [
          "dry-run does not materialize credentials",
          /--dry-run[\s\S]{0,1200}(?:does not|never)[^.\n]{0,240}materializ[^.\n]{0,120}credentials?|--dry-run[\s\S]{0,1200}credentials?[^.\n]{0,120}(?:are not|never)[^.\n]{0,120}materializ/i,
        ],
        [
          "verbose diagnostics use stderr and preserve stdout",
          /--verbose[\s\S]{0,1000}stderr[\s\S]{0,500}stdout[^.\n]{0,160}(?:unchanged|preserv)|stdout[^.\n]{0,160}(?:unchanged|preserv)[\s\S]{0,500}--verbose[\s\S]{0,500}stderr/i,
        ],
        ["resolved values are excluded", /(?:never|does not|exclud(?:e|es|ed))[^.\n]{0,240}resolved values/i],
        ["prompt content is excluded", /(?:never|does not|exclud(?:e|es|ed))[^.\n]{0,240}prompt content/i],
        ["command content is excluded", /(?:never|does not|exclud(?:e|es|ed))[^.\n]{0,240}command content/i],
        ["environment values are excluded", /(?:never|does not|exclud(?:e|es|ed))[^.\n]{0,240}environment values/i],
        ["credential values are excluded", /(?:never|does not|exclud(?:e|es|ed))[^.\n]{0,240}credential values/i],
      ]),
      ...missingInSection(
        "docs/architecture/internals/health-advisories.md",
        /engine.*model.*advisories|akm health.*advisory/i,
        [
          [
            "selected-model-aliases warns when a known selected alias lacks the selected-engine mapping",
            /selected-model-aliases(?=[\s\S]{0,700}\bwarn)(?=[\s\S]{0,700}(?:known[^.\n]{0,120}selected alias|selected alias[^.\n]{0,120}known))(?=[\s\S]{0,700}missing[^.\n]{0,180}selected engine[^.\n]{0,120}mapping)/i,
          ],
          [
            "configured-engines covers every explicitly configured engine",
            /configured-engines(?=[\s\S]{0,600}(?:every|each))(?=[\s\S]{0,600}explicitly configured engines?)/i,
          ],
          [
            "health checks do not make network calls",
            /(?:no|without).*(?:network|provider call)|(?:network|provider call).*(?:never|not)/is,
          ],
          [
            "health evidence excludes endpoint values",
            /evidence[^.\n]{0,240}(?:never|does not|exclud(?:e|es|ed))[^.\n]{0,240}endpoint values?/i,
          ],
          [
            "health evidence excludes exact model IDs",
            /evidence[^.\n]{0,240}(?:never|does not|exclud(?:e|es|ed))[^.\n]{0,240}exact model IDs?/i,
          ],
          [
            "health evidence excludes credential values",
            /evidence[^.\n]{0,240}(?:never|does not|exclud(?:e|es|ed))[^.\n]{0,240}credential values?/i,
          ],
          [
            "health evidence excludes provider output",
            /evidence[^.\n]{0,240}(?:never|does not|exclud(?:e|es|ed))[^.\n]{0,240}provider output/i,
          ],
        ],
      ),
      ...missingInSection("docs/reference/data-and-telemetry.md", /dry runs?|diagnostic output/i, [
        [
          "command dry-run does not mutate authored source",
          /command[^.\n]{0,120}dry-run[^.\n]{0,300}(?:does not|never|no)[^.\n]{0,200}(?:mutat|writ)[^.\n]{0,120}(?:authored )?source/i,
        ],
        [
          "command dry-run does not mutate durable state",
          /command[^.\n]{0,120}dry-run[^.\n]{0,300}(?:does not|never|no)[^.\n]{0,200}(?:mutat|writ)[^.\n]{0,120}(?:durable )?state/i,
        ],
        [
          "command dry-run records no usage",
          /command[^.\n]{0,120}dry-run[^.\n]{0,300}(?:does not|never|no)[^.\n]{0,200}(?:record|emit|create|write)?[^.\n]{0,80}usage/i,
        ],
        [
          "command dry-run emits no events",
          /command[^.\n]{0,120}dry-run[^.\n]{0,300}(?:does not|never|no)[^.\n]{0,200}(?:record|emit|create|write)?[^.\n]{0,80}events?/i,
        ],
        [
          "command dry-run performs no accounting",
          /command[^.\n]{0,120}dry-run[^.\n]{0,300}(?:does not|never|no)[^.\n]{0,200}(?:record|perform|create|write)?[^.\n]{0,80}accounting/i,
        ],
      ]),
      ...missingInSection(
        "docs/architecture/internals/functional-contract-patterns.md",
        /resolved-request lowering and runner dispatch contract/i,
        [
          [
            "provenance is field metadata not resolved values",
            /provenance.*(?:field|layer|kind|via).*(?:not|never).*(?:value|content)|(?:not|never).*(?:value|content).*provenance/is,
          ],
          [
            "lowering notices are secret-free",
            /secret-free.*(?:lowering )?notices|(?:lowering )?notices.*secret-free/is,
          ],
        ],
      ),
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
      ["claims workflows have one Markdown-only format", /there is \*?\*?one\*?\*? format:\s*no separate YAML/i],
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
      {
        relative: "docs/architecture/specs/agent-command-engine-model-design.md",
        taskLink: /\[[^\]]+\]\(\.\.\/\.\.\/reference\/tasks\.md(?:#[^)]+)?\)/i,
        workflowLink:
          /\[[^\]]+\]\((?:\.\.\/\.\.\/reference\/workflow-schema\.md|\.\.\/workflow-engine\.md)(?:#[^)]+)?\)/i,
      },
      {
        relative: "docs/plans/0.9.2-agent-command-workflow-plan.md",
        taskLink: /\[[^\]]+\]\(\.\.\/reference\/tasks\.md(?:#[^)]+)?\)/i,
        workflowLink:
          /\[[^\]]+\]\((?:\.\.\/reference\/workflow-schema\.md|\.\.\/architecture\/workflow-engine\.md)(?:#[^)]+)?\)/i,
      },
    ] as const;
    const failures: string[] = [];
    for (const { relative, taskLink, workflowLink } of historical) {
      const banner = read(relative).split("\n").slice(0, 60).join("\n");
      if (!/(?:historical|superseded|implementation-complete)/i.test(banner)) {
        failures.push(`${relative}: historical/supersession banner`);
      }
      if (!taskLink.test(banner)) {
        failures.push(`${relative}: current task reference link`);
      }
      if (!workflowLink.test(banner)) {
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
        ["links the long-form guide", /\[[^\]]+\]\(\.\.\/v0\.9\.1-to-v0\.9\.2\.md(?:#[^)]+)?\)/i],
      ]),
    ).toEqual([]);
  });

  test("the release script inspects every required npm tar member", () => {
    const releaseCheck = read("tests/release-check.sh");
    for (const member of [
      "package/dist/assets/models.json",
      "package/schemas/akm-task.json",
      "package/docs/reference/tasks.md",
      "package/docs/migration/v0.9.1-to-v0.9.2.md",
      "package/docs/migration/release-notes/0.9.2.md",
      "package/docs/reference/workflow-schema.md",
    ]) {
      expect(releaseCheck).toContain(member);
    }
  });
});
