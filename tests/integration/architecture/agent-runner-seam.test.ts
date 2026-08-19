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

describe("RunnerSpec dispatch authority", () => {
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
          ].join("\n"),
        ),
        writeFixture(
          sandbox.dir,
          "src/reviewer-negative.ts",
          [
            "export {};",
            "type RunnerType = typeof import('./type-only-barrel').executeRunner;",
            "require('./type-only-barrel').executeRunner();",
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
        2, 3, 4, 6, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 28, 30, 31, 33, 35,
      ]);
      expect(references.filter((reference) => reference.file === "src/value-star-barrel.ts")).toHaveLength(1);
      expect(references.filter((reference) => reference.file === "src/value-namespace-barrel.ts")).toHaveLength(1);
      expect(references.filter((reference) => reference.file === "src/barrel.ts")).toHaveLength(1);
      expect(references.filter((reference) => reference.file === "src/type-only-barrel.ts")).toEqual([]);
      expect(references.filter((reference) => reference.file === "src/reviewer-negative.ts")).toEqual([]);
    } finally {
      sandbox.cleanup();
    }
  });
});
