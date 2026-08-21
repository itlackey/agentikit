// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  analyzeExecutionBoundary,
  collectProductionExecutionBoundaryReferences,
  EXECUTION_BOUNDARY_ALLOWLIST,
  type ExecutionBoundaryTarget,
  evaluateExecutionBoundaryPolicy,
} from "../../../scripts/lint-execution-boundary";
import { resolveEngine } from "../../../src/integrations/agent/engine-resolution";
import type { AgentProfile } from "../../../src/integrations/agent/profiles";
import type { RunnerSpec } from "../../../src/integrations/agent/runner";
import * as runnerDispatchModule from "../../../src/integrations/agent/runner-dispatch";
import { executeRunner } from "../../../src/integrations/agent/runner-dispatch";
import { makeSandboxDir } from "../../_helpers/sandbox";

const profile: AgentProfile = {
  name: "runner-test-agent",
  bin: "runner-test-agent",
  args: [],
  stdio: "captured",
  envPassthrough: ["PATH"],
  parseOutput: "text",
};

const result = (stdout: string) => ({ ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1 });
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

const fixtureTargets: readonly ExecutionBoundaryTarget[] = [
  {
    operation: "runner.execute",
    file: "src/integrations/agent/runner-dispatch.ts",
    exportName: "executeRunner",
  },
  { operation: "runner.agent", file: "src/integrations/agent/spawn.ts", exportName: "runAgent" },
  {
    operation: "runner.sdk",
    file: "src/integrations/harnesses/opencode-sdk/sdk-runner.ts",
    exportName: "runOpencodeSdk",
  },
  { operation: "runner.builder", file: "src/integrations/agent/builders.ts", exportName: "getCommandBuilder" },
  { operation: "llm.chat", file: "src/llm/client.ts", exportName: "chatCompletion" },
  {
    operation: "engine.resolve",
    file: "src/integrations/agent/engine-resolution.ts",
    exportName: "resolveEngine",
  },
  {
    operation: "engine.lookup-credential",
    file: "src/integrations/agent/engine-resolution.ts",
    exportName: "lookupCredentialFromEnv",
  },
];

function writeFixture(root: string, relative: string, source: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
}

function collectTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && absolute.endsWith(".ts")) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

describe("RunnerSpec dispatch authority", () => {
  test("runner-dispatch runtime exports stay complete for actual-module consumers", () => {
    expect(Object.keys(runnerDispatchModule).sort()).toEqual([
      "acquireRunnerDispatchLease",
      "assertRunnerDispatchLease",
      "collectDispatchSensitiveValues",
      "disposeDispatchResources",
      "disposeRunnerDispatchLease",
      "executeRunner",
      "redactWithRunnerDispatchLease",
    ]);
  });

  test("routes sdk and agent specs through their one low-level switch", async () => {
    const sdk: RunnerSpec = { kind: "sdk", profile };
    const agent: RunnerSpec = { kind: "agent", profile };
    const seams = {
      runAgent: async () => result("spawn"),
      runSdk: async () => result("sdk"),
    };
    expect((await executeRunner(sdk, "hello", {}, seams)).stdout).toBe("sdk");
    expect((await executeRunner(agent, "hello", {}, seams)).stdout).toBe("spawn");
  });

  test("engine lowering, not profile fields, selects SDK versus spawn", () => {
    const config = {
      engines: {
        agent: { kind: "agent" as const, platform: "opencode" },
        sdk: { kind: "agent" as const, platform: "opencode-sdk", llmEngine: "llm" },
        llm: { kind: "llm" as const, endpoint: "https://example.test/v1/chat/completions", model: "test" },
      },
      defaults: { engine: "agent", llmEngine: "llm" },
    };
    expect(resolveEngine("agent", config).kind).toBe("agent");
    expect(resolveEngine("sdk", config).kind).toBe("sdk");
  });

  test("production low-level references match only exact authorities, exemptions, and named temporary debt", () => {
    const policy = evaluateExecutionBoundaryPolicy(
      collectProductionExecutionBoundaryReferences(repoRoot),
      EXECUTION_BOUNDARY_ALLOWLIST,
    );
    expect(policy.unauthorized).toEqual([]);
    expect(policy.countErrors).toEqual([]);
  }, 20_000);

  test("structured-runner preflight leases are retained for disposal and raw lease authority stays lowering-only", () => {
    const rawLeaseExports = new Set([
      "acquireRunnerDispatchLease",
      "assertRunnerDispatchLease",
      "disposeRunnerDispatchLease",
      "redactWithRunnerDispatchLease",
      "RunnerDispatchLease",
    ]);
    const discarded: string[] = [];
    const missingFinallyDisposal: string[] = [];
    const unauthorizedRawImports: string[] = [];

    for (const file of collectTypeScriptFiles(path.join(repoRoot, "src"))) {
      const relative = path.relative(repoRoot, file).replaceAll(path.sep, "/");
      const source = fs.readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      let hasPreflightCall = false;
      let hasFinallyDisposal = false;

      const isInsideFinally = (node: ts.Node): boolean => {
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
          if (ts.isBlock(parent) && ts.isTryStatement(parent.parent) && parent.parent.finallyBlock === parent) {
            return true;
          }
        }
        return false;
      };

      const visit = (node: ts.Node): void => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text.endsWith("/runner-dispatch") &&
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings)
        ) {
          for (const specifier of node.importClause.namedBindings.elements) {
            const imported = specifier.propertyName?.text ?? specifier.name.text;
            if (rawLeaseExports.has(imported) && relative !== "src/integrations/agent/execution-lowering.ts") {
              unauthorizedRawImports.push(
                `${relative}:${sourceFile.getLineAndCharacterOfPosition(specifier.pos).line + 1}`,
              );
            }
          }
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          if (node.expression.text === "disposeLoweredExecutionDispatchLease" && isInsideFinally(node)) {
            hasFinallyDisposal = true;
          }
          if (node.expression.text === "preflightStructuredLlmRunner") {
            hasPreflightCall = true;
            let retained = false;
            for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
              if (ts.isVariableDeclaration(parent) && parent.initializer) {
                retained = true;
                break;
              }
              if (
                ts.isBinaryExpression(parent) &&
                parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                parent.right.getStart(sourceFile) <= node.getStart(sourceFile)
              ) {
                retained = true;
                break;
              }
              if (ts.isReturnStatement(parent) || ts.isExpressionStatement(parent)) break;
            }
            if (!retained) {
              discarded.push(
                `${relative}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`,
              );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      if (hasPreflightCall && !hasFinallyDisposal) missingFinallyDisposal.push(relative);
    }

    expect(discarded).toEqual([]);
    expect(missingFinallyDisposal).toEqual([]);
    expect(unauthorizedRawImports).toEqual([]);
  });

  test("production structured dispatch inventory is exact and multi-call sinks carry a bound lease", () => {
    const oneShotLeafAllowlist = new Set([
      "src/commands/command/command-execution.ts:dispatchPreparedCommandInvocation:dispatchLoweredExecutionRequest",
      "src/commands/remember.ts:<anonymous>:callStructured",
      "src/workflows/exec/unit-dispatch.ts:dispatchFrozenWorkflowExecution:dispatchLoweredExecutionRequest",
    ]);
    const authorityAllowlist = new Set(["src/llm/structured-call.ts:<anonymous>:dispatchLoweredExecutionRequest"]);
    const expected = new Set([
      ...oneShotLeafAllowlist,
      ...authorityAllowlist,
      "src/commands/improve/consolidate.ts:callChunkLlm:callStructured",
      "src/commands/improve/distill.ts:runDistillLlmCall:callStructured",
      "src/commands/improve/distill/promote-memory.ts:resolveKnowledgePromotionContent:callStructured",
      "src/commands/improve/distill/quality-gate.ts:runQualityJudge:callStructured",
      "src/commands/improve/extract.ts:defaultSessionSummaryGenerator:callStructured",
      "src/commands/improve/extract.ts:runSessionExtractionLlmCall:callStructured",
      "src/commands/improve/memory/memory-contradiction-detect.ts:detectAndWriteContradictions:callStructured",
      "src/commands/improve/reflect.ts:call:callStructured",
      "src/commands/improve/reflect.ts:runReflectRefineIterations:dispatchLoweredExecutionRequest",
      "src/commands/proposal/drain.ts:dispatchJudgment:dispatchLoweredExecutionRequest",
      "src/commands/proposal/propose.ts:dispatchProposalPrompt:dispatchLoweredExecutionRequest",
      "src/commands/sources/schema-repair.ts:runSchemaRepairPass:callStructured",
      "src/llm/graph-extract.ts:callGraphLlm:callStructured",
      "src/llm/graph-extract.ts:extractGraphFromBody:callStructured",
      "src/llm/memory-infer.ts:compressMemoryToDerivedMemory:callStructured",
      "src/llm/metadata-enhance.ts:enhanceMetadata:callStructured",
    ]);
    const expectedBoundLease: ReadonlyMap<string, string> = new Map([
      ["src/commands/improve/consolidate.ts:callChunkLlm:callStructured", "lease"],
      ["src/commands/improve/distill.ts:runDistillLlmCall:callStructured", "lease"],
      ["src/commands/improve/distill/promote-memory.ts:resolveKnowledgePromotionContent:callStructured", "ctx.lease"],
      ["src/commands/improve/distill/quality-gate.ts:runQualityJudge:callStructured", "options.lease"],
      ["src/commands/improve/extract.ts:defaultSessionSummaryGenerator:callStructured", "lease"],
      ["src/commands/improve/extract.ts:runSessionExtractionLlmCall:callStructured", "lease"],
      [
        "src/commands/improve/memory/memory-contradiction-detect.ts:detectAndWriteContradictions:callStructured",
        "dispatchLease",
      ],
      ["src/commands/improve/reflect.ts:call:callStructured", "opts.lease"],
      ["src/commands/improve/reflect.ts:runReflectRefineIterations:dispatchLoweredExecutionRequest", "lease"],
      ["src/commands/proposal/drain.ts:dispatchJudgment:dispatchLoweredExecutionRequest", "lease"],
      ["src/commands/proposal/propose.ts:dispatchProposalPrompt:dispatchLoweredExecutionRequest", "lease"],
      ["src/commands/sources/schema-repair.ts:runSchemaRepairPass:callStructured", "dispatchLease"],
      ["src/llm/graph-extract.ts:callGraphLlm:callStructured", "lease"],
      ["src/llm/graph-extract.ts:extractGraphFromBody:callStructured", "options.lease"],
      ["src/llm/memory-infer.ts:compressMemoryToDerivedMemory:callStructured", "lease"],
      ["src/llm/metadata-enhance.ts:enhanceMetadata:callStructured", "lease"],
    ]);
    const found = new Set<string>();
    const unbound: string[] = [];
    const wrongLease: string[] = [];

    for (const file of collectTypeScriptFiles(path.join(repoRoot, "src"))) {
      const relative = path.relative(repoRoot, file).replaceAll(path.sep, "/");
      const source = fs.readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const initializers = new Map<string, ts.Expression>();

      const enclosingName = (node: ts.Node): string => {
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
          if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
          if (ts.isMethodDeclaration(parent) && parent.name && ts.isIdentifier(parent.name)) return parent.name.text;
          if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
            const declaration = parent.parent;
            if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name))
              return declaration.name.text;
            return "<anonymous>";
          }
        }
        return "<module>";
      };
      const collectLeaseReferences = (node: ts.Node): string[] => {
        const references: string[] = [];
        const visit = (child: ts.Node): void => {
          if (ts.isPropertyAssignment(child) && child.name.getText(sourceFile) === "lease") {
            references.push(child.initializer.getText(sourceFile));
            return;
          }
          if (ts.isShorthandPropertyAssignment(child) && child.name.text === "lease") {
            references.push(child.name.text);
            return;
          }
          ts.forEachChild(child, visit);
        };
        visit(node);
        return references;
      };
      const scan = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          initializers.set(node.name.text, node.initializer);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          (node.expression.text === "callStructured" || node.expression.text === "dispatchLoweredExecutionRequest") &&
          !(relative === "src/llm/structured-call.ts" && node.expression.text === "callStructured")
        ) {
          const key = `${relative}:${enclosingName(node)}:${node.expression.text}`;
          found.add(key);
          if (!oneShotLeafAllowlist.has(key) && !authorityAllowlist.has(key)) {
            const optionsArg = node.arguments.at(-1);
            const leaseReferences =
              optionsArg === undefined
                ? []
                : ts.isIdentifier(optionsArg) && initializers.has(optionsArg.text)
                  ? collectLeaseReferences(initializers.get(optionsArg.text) as ts.Expression)
                  : collectLeaseReferences(optionsArg);
            if (leaseReferences.length === 0) unbound.push(key);
            const expectedLease = expectedBoundLease.get(key);
            if (expectedLease === undefined || !leaseReferences.includes(expectedLease)) {
              wrongLease.push(`${key}:${leaseReferences.join(",") || "<none>"}`);
            }
          }
        }
        ts.forEachChild(node, scan);
      };
      scan(sourceFile);
    }

    expect(found).toEqual(expected);
    expect(unbound).toEqual([]);
    expect(wrongLease).toEqual([]);
    expect(new Set(expectedBoundLease.keys())).toEqual(
      new Set([...expected].filter((key) => !oneShotLeafAllowlist.has(key) && !authorityAllowlist.has(key))),
    );
  });

  test("multi-call operation scopes classify before acquisition, mutate after it, and dispose lexically", () => {
    const invariants = [
      {
        file: "src/commands/improve/memory/memory-contradiction-detect.ts",
        classify: "candidatePairs",
        acquire: "preflightStructuredLlmRunner",
        mutate: "writeContradictedByEdge",
      },
      {
        file: "src/commands/sources/schema-repair.ts",
        classify: "eligibleRepairs",
        acquire: "preflightStructuredLlmRunner",
        mutate: "createProposal",
      },
      {
        file: "src/commands/improve/consolidate.ts",
        classify: "dispatchingChunks",
        acquire: "preflightStructuredLlmRunner",
        mutate: "judgeConsolidationChunks({",
      },
      {
        file: "src/commands/improve/distill.ts",
        classify: "promotionPlan",
        acquire: "preflightStructuredLlmRunner",
        mutate: "promoteMemoryToKnowledge",
      },
      {
        file: "src/commands/improve/reflect.ts",
        classify: "qualityJudgeRunner",
        acquire: "acquireLoweredExecutionDispatchLease",
        mutate: "emitReflectInvoked",
      },
    ] as const;

    for (const invariant of invariants) {
      const source = fs.readFileSync(path.join(repoRoot, invariant.file), "utf8");
      const classifyAt = source.indexOf(invariant.classify);
      const acquireAt = source.indexOf(invariant.acquire, classifyAt + 1);
      const mutateAt = source.indexOf(invariant.mutate, acquireAt + 1);
      expect(classifyAt, invariant.file).toBeGreaterThanOrEqual(0);
      expect(acquireAt, invariant.file).toBeGreaterThan(classifyAt);
      expect(mutateAt, invariant.file).toBeGreaterThan(acquireAt);
      expect(source.slice(acquireAt)).toMatch(/finally\s*\{[\s\S]*disposeLoweredExecutionDispatchLease/);
    }
  });

  test("symbol-origin guard catches aliases, namespaces, barrels, wrappers, call/apply/bind, and default injection", () => {
    const sandbox = makeSandboxDir("execution-boundary-symbols");
    try {
      const files = [
        writeFixture(
          sandbox.dir,
          "src/integrations/agent/runner-dispatch.ts",
          "export async function executeRunner(..._args: unknown[]) {}\n",
        ),
        writeFixture(
          sandbox.dir,
          "src/integrations/agent/spawn.ts",
          "export async function runAgent(..._args: unknown[]) {}\n",
        ),
        writeFixture(
          sandbox.dir,
          "src/integrations/harnesses/opencode-sdk/sdk-runner.ts",
          "export async function runOpencodeSdk(..._args: unknown[]) {}\n",
        ),
        writeFixture(
          sandbox.dir,
          "src/integrations/agent/builders.ts",
          "export function getCommandBuilder() { return { build() {} }; }\n",
        ),
        writeFixture(
          sandbox.dir,
          "src/integrations/agent/engine-resolution.ts",
          [
            "export function resolveEngine(..._args: unknown[]) { return {}; }",
            "export function lookupCredentialFromEnv(..._args: unknown[]) { return undefined; }",
          ].join("\n"),
        ),
        writeFixture(
          sandbox.dir,
          "src/llm/client.ts",
          "export async function chatCompletion(..._args: unknown[]) { return ''; }\n",
        ),
        writeFixture(
          sandbox.dir,
          "src/barrel.ts",
          "export { executeRunner as hiddenRunner } from './integrations/agent/runner-dispatch';\n",
        ),
        writeFixture(
          sandbox.dir,
          "src/consumer.ts",
          [
            "import { executeRunner as invoke } from './integrations/agent/runner-dispatch';",
            "import * as client from './llm/client';",
            "import { hiddenRunner } from './barrel';",
            "import { getCommandBuilder } from './integrations/agent/builders';",
            "import { resolveEngine } from './integrations/agent/engine-resolution';",
            "import { lookupCredentialFromEnv as lookupCredential } from './integrations/agent/engine-resolution';",
            "const assigned = (invoke as typeof invoke)!;",
            "assigned.call(null);",
            "const disguised = await Promise.resolve((0, invoke satisfies typeof invoke)!);",
            "disguised();",
            "hiddenRunner.apply(null, []);",
            "((callback) => callback.bind(null))(invoke);",
            "const fallback = ({ chat: undefined } as { chat?: typeof client.chatCompletion }).chat ?? client['chatCompletion'];",
            "fallback();",
            "getCommandBuilder().build();",
            "const wrapped = () => resolveEngine;",
            "wrapped()();",
            "const wrappedCredentialLookup = () => lookupCredential;",
            "wrappedCredentialLookup()();",
            "const { runAgent: fromRequire } = require('./integrations/agent/spawn');",
            "fromRequire();",
            "const sdk = await import('./integrations/harnesses/opencode-sdk/sdk-runner');",
            "sdk.runOpencodeSdk();",
          ].join("\n"),
        ),
        writeFixture(
          sandbox.dir,
          "src/shadow.ts",
          [
            "import type { chatCompletion as ChatCompletionType } from './llm/client';",
            "type Chat = typeof ChatCompletionType;",
            "function executeRunner() {}",
            "const chatCompletion: Chat = async () => '';",
            "executeRunner();",
            "chatCompletion();",
          ].join("\n"),
        ),
        writeFixture(
          sandbox.dir,
          "src/dynamic-consumer.ts",
          [
            "import { createRequire } from 'node:module';",
            "import legacyRunner = require('./integrations/agent/runner-dispatch');",
            "require('./integrations/agent/runner-dispatch').executeRunner();",
            "(await import('./llm/client')).chatCompletion();",
            "const load = require;",
            "load('./integrations/agent/engine-resolution').resolveEngine();",
            "let postNamespace: unknown;",
            "postNamespace = load('./integrations/agent/runner-dispatch');",
            "(postNamespace as typeof legacyRunner).executeRunner();",
            "let assignedRunner: unknown;",
            "({ executeRunner: assignedRunner } = load('./integrations/agent/runner-dispatch'));",
            "(assignedRunner as (...args: unknown[]) => unknown)();",
            "((namespace) => namespace.runAgent())(load('./integrations/agent/spawn'));",
            "load('./integrations/harnesses/opencode-sdk/sdk-runner').runOpencodeSdk.call(null);",
            "const builderKey = 'getCommandBuilder';",
            "load('./integrations/agent/builders')[builderKey]().build();",
            "legacyRunner.executeRunner();",
            "module.require('./integrations/agent/engine-resolution').lookupCredentialFromEnv();",
            "const nodeLoad = createRequire(import.meta.url);",
            "nodeLoad('./llm/client').chatCompletion.apply(null, []);",
            "const { runAgent: assignedAgent } = nodeLoad('./integrations/agent/spawn');",
            "assignedAgent();",
            "let lateLoad: typeof require;",
            "lateLoad = require;",
            "lateLoad('./integrations/agent/engine-resolution').resolveEngine.bind(null)();",
            "((loader) => loader('./integrations/agent/runner-dispatch').executeRunner())(require);",
            "const engineNamespace = load('./integrations/agent/engine-resolution');",
            "const engineAlias = engineNamespace;",
            "engineAlias.resolveEngine();",
            "const identity = (value: unknown): unknown => value;",
            "identity(require('./integrations/agent/runner-dispatch')).executeRunner();",
            "const identityNamespace = identity(await import('./llm/client'));",
            "(identityNamespace as { chatCompletion(): unknown }).chatCompletion();",
            "const runnerModule = './integrations/agent/runner-dispatch';",
            "require(runnerModule).executeRunner();",
            "(({ executeRunner: throughIife }) => throughIife())(require('./integrations/agent/runner-dispatch'));",
            "const transitiveIdentity = (value: unknown): unknown => identity(value);",
            "transitiveIdentity(require(runnerModule)).executeRunner();",
            "const namespaceLoader = () => import(runnerModule);",
            "(await namespaceLoader()).executeRunner();",
            "import(runnerModule).then((promiseNamespace) => promiseNamespace.executeRunner);",
            "import(runnerModule, { with: {} }).then((attributedNamespace) => attributedNamespace.executeRunner);",
            "require.call(null, runnerModule).executeRunner();",
            "require.apply(null, [runnerModule]).executeRunner();",
          ].join("\n"),
        ),
        writeFixture(
          sandbox.dir,
          "src/dynamic-shadow.ts",
          [
            "export {};",
            "function require(_specifier: string) { return { executeRunner() {}, resolveEngine() {} }; }",
            "const module = { require } as const;",
            "const createRequire = () => require;",
            "require('./integrations/agent/runner-dispatch').executeRunner();",
            "module.require('./integrations/agent/engine-resolution').resolveEngine();",
            "createRequire()('./integrations/agent/runner-dispatch').executeRunner();",
          ].join("\n"),
        ),
        writeFixture(
          sandbox.dir,
          "src/node-module-nontarget.ts",
          [
            "import { isBuiltin } from 'node:module';",
            "const falseLoader = isBuiltin('node:fs');",
            "(falseLoader as unknown as typeof require)('./integrations/agent/runner-dispatch').executeRunner();",
          ].join("\n"),
        ),
        writeFixture(
          sandbox.dir,
          "src/value-star-barrel.ts",
          "export * from './integrations/agent/runner-dispatch';\n",
        ),
        writeFixture(
          sandbox.dir,
          "src/value-namespace-barrel.ts",
          "export * as runnerNamespace from './integrations/agent/runner-dispatch';\n",
        ),
        writeFixture(
          sandbox.dir,
          "src/type-only-barrel.ts",
          [
            "export type { executeRunner } from './integrations/agent/runner-dispatch';",
            "export type { executeRunner as RenamedRunnerType } from './integrations/agent/runner-dispatch';",
            "export { type executeRunner as InlineRunnerType } from './integrations/agent/runner-dispatch';",
          ].join("\n"),
        ),
        writeFixture(
          sandbox.dir,
          "src/type-only-star-barrel.ts",
          "export type * from './integrations/agent/runner-dispatch';\n",
        ),
        writeFixture(
          sandbox.dir,
          "src/reviewer-positive.ts",
          [
            "const runnerModule = './integrations/agent/runner-dispatch';",
            "import(runnerModule).then(({ executeRunner }) => executeRunner());",
            "import(runnerModule).then(({ executeRunner: renamedRunner }) => renamedRunner());",
            "import(runnerModule).then(function ({ executeRunner: functionRunner }) { functionRunner(); });",
            "const [arrayLoad] = [require];",
            "arrayLoad(runnerModule).executeRunner();",
            "let assignedArrayLoad: typeof require;",
            "[assignedArrayLoad] = [require];",
            "assignedArrayLoad(runnerModule).executeRunner();",
            "const [...restLoads] = [require];",
            "restLoads[0]!(runnerModule).executeRunner();",
            "(function (loader) { loader(runnerModule).executeRunner(); })(require);",
            "((loader) => loader(runnerModule).executeRunner())(require);",
            "(function (loader = require) { loader(runnerModule).executeRunner(); })();",
            "((loader = require) => loader(runnerModule).executeRunner())();",
            "(function ({ loader = require } = {}) { loader(runnerModule).executeRunner(); })();",
            "(({ loader = require } = {}) => loader(runnerModule).executeRunner())();",
            "Promise.resolve(require(runnerModule)).then(({ executeRunner: promisedRunner }) => promisedRunner());",
            "require('./value-star-barrel').executeRunner();",
            "require('./value-namespace-barrel').runnerNamespace.executeRunner();",
            "const throughStar = require('./value-star-barrel');",
            "throughStar.executeRunner();",
            "import(runnerModule).then((namespace) => namespace).then(({ executeRunner: chainedRunner }) => chainedRunner());",
            "import(runnerModule)",
            "  .then((namespace) => namespace)",
            "  .catch(() => undefined)",
            "  .finally(() => undefined)",
            "  .then(({ executeRunner: afterCatchFinally }) => afterCatchFinally());",
            "const spreadNamespace = { ...require(runnerModule) };",
            "spreadNamespace.executeRunner();",
            "function callWith(loader: typeof require) { loader(runnerModule).executeRunner(); }",
            "callWith(require);",
            "function callWithRest(...loaders: (typeof require)[]) { loaders[0]!(runnerModule).executeRunner(); }",
            "callWithRest(require);",
            "import(runnerModule).then((namespace) => ({ ...namespace })).then(({ executeRunner: spreadChained }) => spreadChained());",
            "const wrappedLoad = (specifier: string) => require(specifier);",
            "wrappedLoad(runnerModule).executeRunner();",
            "import('./value-namespace-barrel').then(({ runnerNamespace: { executeRunner: nestedRunner } }) => nestedRunner());",
          ].join("\n"),
        ),
        writeFixture(
          sandbox.dir,
          "src/reviewer-negative.ts",
          [
            "export {};",
            "type RunnerType = typeof import('./type-only-barrel').executeRunner;",
            "require('./type-only-barrel').executeRunner();",
            "require('./type-only-star-barrel').executeRunner();",
            "function localRequireArray(require: (_specifier: string) => { executeRunner(): void }) {",
            "  const [loader] = [require];",
            "  loader('./integrations/agent/runner-dispatch').executeRunner();",
            "}",
            "function localRequireDefault(",
            "  require = (_specifier: string) => ({ executeRunner() {} }),",
            ") {",
            "  ((loader = require) => loader('./integrations/agent/runner-dispatch').executeRunner())();",
            "}",
            "const localLoader = (_specifier: string) => ({ executeRunner() {} });",
            "const [control] = [localLoader];",
            "control('./integrations/agent/runner-dispatch').executeRunner();",
            "function mixedRest(...loaders: Array<typeof require | typeof localLoader>) {",
            "  loaders[0]!('./integrations/agent/runner-dispatch').executeRunner();",
            "}",
            "mixedRest(localLoader, require);",
            "const Promise = { resolve: (value: unknown) => ({ then: (callback: (input: unknown) => unknown) => callback(value) }) };",
            "Promise.resolve(localLoader('./integrations/agent/runner-dispatch')).then((namespace: any) => namespace.executeRunner());",
            "void localRequireArray;",
            "void localRequireDefault;",
          ].join("\n"),
        ),
      ];
      const references = analyzeExecutionBoundary({
        rootDir: sandbox.dir,
        fileNames: files,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          strict: true,
        },
        targets: fixtureTargets,
      });

      const operations = new Set(references.map((reference) => reference.operation));
      expect(operations).toEqual(
        new Set([
          "runner.execute",
          "runner.agent",
          "runner.sdk",
          "runner.builder",
          "llm.chat",
          "engine.resolve",
          "engine.lookup-credential",
        ]),
      );
      expect(references.some((reference) => reference.file === "src/barrel.ts")).toBe(true);
      expect(references.some((reference) => reference.text.includes("chatCompletion"))).toBe(true);
      expect(references.filter((reference) => reference.file === "src/shadow.ts")).toEqual([]);
      const dynamic = references.filter((reference) => reference.file === "src/dynamic-consumer.ts");
      expect(new Set(dynamic.map((reference) => reference.operation))).toEqual(
        new Set([
          "runner.execute",
          "runner.agent",
          "runner.sdk",
          "runner.builder",
          "llm.chat",
          "engine.resolve",
          "engine.lookup-credential",
        ]),
      );
      expect(dynamic.some((reference) => reference.text.includes("assignedRunner"))).toBe(true);
      expect(dynamic.some((reference) => reference.text.includes("builderKey"))).toBe(true);
      expect(dynamic.some((reference) => reference.text.includes("lookupCredentialFromEnv"))).toBe(true);
      expect(dynamic.some((reference) => reference.text.includes("identity(require"))).toBe(true);
      expect(dynamic.some((reference) => reference.text.includes("identityNamespace"))).toBe(true);
      expect(dynamic.some((reference) => reference.text.includes("runnerModule"))).toBe(true);
      expect(dynamic.some((reference) => reference.text.includes("throughIife"))).toBe(true);
      expect(dynamic.some((reference) => reference.text.includes("transitiveIdentity"))).toBe(true);
      expect(dynamic.some((reference) => reference.text.includes("namespaceLoader"))).toBe(true);
      expect(dynamic.some((reference) => reference.text.includes("promiseNamespace"))).toBe(true);
      expect(dynamic.some((reference) => reference.text.includes("attributedNamespace"))).toBe(true);
      expect(dynamic.some((reference) => reference.text.includes("require.call"))).toBe(true);
      expect(dynamic.some((reference) => reference.text.includes("require.apply"))).toBe(true);
      expect(references.filter((reference) => reference.file === "src/dynamic-shadow.ts")).toEqual([]);
      expect(references.filter((reference) => reference.file === "src/node-module-nontarget.ts")).toEqual([]);
      const reviewerPositive = references.filter((reference) => reference.file === "src/reviewer-positive.ts");
      expect(reviewerPositive.map((reference) => reference.line)).toEqual([
        2, 3, 4, 6, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 28, 30, 31, 33, 35, 37, 38,
      ]);
      expect(references.filter((reference) => reference.file === "src/value-star-barrel.ts")).toHaveLength(1);
      expect(references.filter((reference) => reference.file === "src/value-namespace-barrel.ts")).toHaveLength(1);
      expect(references.filter((reference) => reference.file === "src/barrel.ts")).toHaveLength(1);
      expect(references.filter((reference) => reference.file === "src/type-only-barrel.ts")).toEqual([]);
      expect(references.filter((reference) => reference.file === "src/type-only-star-barrel.ts")).toEqual([]);
      expect(references.filter((reference) => reference.file === "src/reviewer-negative.ts")).toEqual([]);
    } finally {
      sandbox.cleanup();
    }
  });
});
