// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure task-v3 runtime projection.
 *
 * This is the only bridge from authored task-v3 source into executable work.
 * It performs all source/config/asset reads before the task runner reserves a
 * durable attempt and returns immutable snapshots. In particular, script work
 * contains frozen bytes and their digest, never a path that can be reread when
 * a delayed or resumed dispatch begins.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type PrepareCommandInvocationOptions,
  type PreparedCommandInvocation,
  prepareCommandInvocation,
} from "../commands/command/command-execution";
import { type BundleRef, makeBundleRef, parseBundleRef } from "../core/asset/asset-ref";
import type { AkmConfig } from "../core/config/config-types";
import { ConfigError, UsageError } from "../core/errors";
import { DURATION_UNITS, parseDuration } from "../core/time";
import { isPortableExecutionAgentSelector, type UnresolvedExecutionDefaults } from "../execution/source";
import { requireAuthorizedExecutionPlan } from "../integrations/agent/execution-cascade";
import { lowerResolvedExecutionRequest } from "../integrations/agent/execution-lowering";
import { resolveAssetPath } from "../sources/resolve";
import { detectSecretShapedParams } from "../workflows/exec/param-secrets";
import { compileWorkflowSource } from "../workflows/source-ir/compile";
import { WorkflowSourceProjectionError, workflowSourceIrToDocument } from "../workflows/source-ir/document";
import { isInferredSecretName } from "./log-redaction";
import type { TaskV3Environment, TaskV3HostShell, TaskV3SourceDocument } from "./source-v3";

export type TaskV3ScriptInterpreter =
  | "sh"
  | "bun"
  | "powershell"
  | "cmd"
  | "python"
  | "ruby"
  | "go"
  | "perl"
  | "php"
  | "lua"
  | "rscript"
  | "swift"
  | "kotlin";

export interface TaskV3PreparedBase {
  readonly taskId: string;
  readonly taskRef: string;
  readonly enabled: boolean;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs?: number | null;
  readonly redact: readonly string[];
}

export interface PreparedTaskV3Command extends TaskV3PreparedBase {
  readonly kind: "command";
  readonly invocation: PreparedCommandInvocation;
}

export interface PreparedTaskV3Workflow extends TaskV3PreparedBase {
  readonly kind: "workflow";
  readonly ref: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly maxSteps?: number;
  readonly maxRetries?: number;
}

export interface PreparedTaskV3Shell extends TaskV3PreparedBase {
  readonly kind: "shell";
  readonly command: string;
  readonly shell: TaskV3HostShell;
  readonly cwd: string;
}

export interface PreparedTaskV3Script extends TaskV3PreparedBase {
  readonly kind: "script";
  readonly sourceRef: string;
  readonly interpreter: TaskV3ScriptInterpreter;
  readonly extension: string;
  /** Immutable base64 encoding of the exact source bytes. */
  readonly bytesBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly cwd: string;
}

export type PreparedTaskV3Execution =
  | PreparedTaskV3Command
  | PreparedTaskV3Workflow
  | PreparedTaskV3Shell
  | PreparedTaskV3Script;

export interface PrepareTaskV3ExecutionContext {
  readonly taskId: string;
  readonly taskRef: string;
  readonly bundleName: string;
  readonly bundleRoot: string;
  readonly config: AkmConfig;
  readonly prepareCommand?: typeof prepareCommandInvocation;
  readonly commandSourceLoader?: PrepareCommandInvocationOptions["sourceLoader"];
  readonly resolveAsset?: (input: {
    readonly bundle: string;
    readonly type: "workflow" | "script";
    readonly name: string;
    readonly ref: string;
  }) => Promise<string | Readonly<{ file: string; bundleRoot: string }>>;
  readonly readFile?: (file: string) => Uint8Array;
}

const SCRIPT_INTERPRETERS: Readonly<Record<string, TaskV3ScriptInterpreter>> = Object.freeze({
  ".sh": "sh",
  ".ts": "bun",
  ".js": "bun",
  ".ps1": "powershell",
  ".cmd": "cmd",
  ".bat": "cmd",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".pl": "perl",
  ".php": "php",
  ".lua": "lua",
  ".r": "rscript",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
});

function own(value: object | undefined, key: PropertyKey): boolean {
  return value !== undefined && Object.hasOwn(value, key);
}

function environmentSnapshot(environment: TaskV3Environment | undefined): Readonly<Record<string, string>> {
  const out = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(environment ?? {}).sort()) {
    const raw = environment?.[key];
    if (raw === undefined) continue;
    const value = String(raw);
    if (isInferredSecretName(key) || detectSecretShapedParams({ [key]: value }).length > 0) {
      throw new UsageError(
        `Task v3 env.${key} is a secret-shaped literal env value. Store credentials in a secret/env binding rather than durable task source.`,
        "INVALID_FLAG_VALUE",
      );
    }
    Object.defineProperty(out, key, { value, enumerable: true, configurable: false, writable: false });
  }
  return Object.freeze(out);
}

function normalizeTimeout(value: string | number | null | undefined): number | null | undefined {
  if (value === undefined || value === null || typeof value === "number") return value;
  const parsed = parseDuration(value, DURATION_UNITS);
  if (parsed === null) throw new UsageError(`Invalid task timeout ${JSON.stringify(value)}.`, "INVALID_FLAG_VALUE");
  return parsed;
}

function qualifyOwnedRef(
  ref: string,
  context: PrepareTaskV3ExecutionContext,
): { parsed: BundleRef; qualified: string } {
  const parsed = parseBundleRef(ref);
  const bundle = parsed.bundle ?? context.bundleName;
  return { parsed, qualified: makeBundleRef(bundle, parsed.conceptId) };
}

function currentExecutionValues(
  document: TaskV3SourceDocument,
  context: PrepareTaskV3ExecutionContext,
  environment: Readonly<Record<string, string>>,
): UnresolvedExecutionDefaults {
  const akm = document.akm;
  const agent = akm?.agent;
  return Object.freeze({
    ...(own(akm, "agent")
      ? {
          agent:
            typeof agent === "string" && isPortableExecutionAgentSelector(agent)
              ? qualifyOwnedRef(agent, context).qualified
              : agent,
        }
      : {}),
    ...(own(akm, "engine") ? { engine: akm?.engine } : {}),
    ...(own(akm, "model") ? { model: akm?.model } : {}),
    ...(own(akm, "inference") ? { inference: akm?.inference } : {}),
    ...(own(akm, "outputSchema") ? { outputSchema: akm?.outputSchema } : {}),
    ...(own(akm, "tools") ? { tools: akm?.tools } : {}),
    ...(own(akm, "timeout") ? { timeout: akm?.timeout } : {}),
    workspace: context.bundleRoot,
    environment,
  }) as UnresolvedExecutionDefaults;
}

function base(
  document: TaskV3SourceDocument,
  context: PrepareTaskV3ExecutionContext,
  environment: Readonly<Record<string, string>>,
): TaskV3PreparedBase {
  const timeoutMs = normalizeTimeout(document.akm?.timeout);
  return Object.freeze({
    taskId: context.taskId,
    taskRef: context.taskRef,
    enabled: document.akm?.enabled !== false,
    environment,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    redact: Object.freeze([...(document.akm?.redact ?? [])]),
  });
}

async function resolvedOwnedAsset(
  qualified: string,
  type: "workflow" | "script",
  context: PrepareTaskV3ExecutionContext,
): Promise<Readonly<{ file: string; bundleRoot: string }>> {
  const parsed = parseBundleRef(qualified);
  const prefix = `${type}s/`;
  const name = parsed.conceptId.slice(prefix.length);
  if (context.resolveAsset) {
    const resolved = await context.resolveAsset({ bundle: parsed.bundle as string, type, name, ref: qualified });
    return typeof resolved === "string"
      ? Object.freeze({ file: resolved, bundleRoot: context.bundleRoot })
      : Object.freeze({ file: resolved.file, bundleRoot: resolved.bundleRoot });
  }
  return Object.freeze({
    file: await resolveAssetPath(context.bundleRoot, type, name),
    bundleRoot: context.bundleRoot,
  });
}

function scriptInterpreter(extension: string, ref: string): TaskV3ScriptInterpreter {
  const interpreter = SCRIPT_INTERPRETERS[extension];
  if (!interpreter) {
    throw new UsageError(
      `Task v3 script target ${JSON.stringify(ref)} has no closed runtime interpreter for extension ${JSON.stringify(extension)}.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return interpreter;
}

function validatePreparedCommand(
  invocation: PreparedCommandInvocation,
  context: PrepareTaskV3ExecutionContext,
): PreparedCommandInvocation {
  const request = requireAuthorizedExecutionPlan(invocation.plan);
  if (!request.engine.name) {
    throw new ConfigError(
      `Task ${JSON.stringify(context.taskRef)} has no resolved execution engine. Configure defaults.engine or akm.engine before running it.`,
      "INVALID_CONFIG_FILE",
    );
  }
  // Lowering is pure. Running it before the durable-attempt boundary proves
  // the selected target is transport-projectable; dispatch repeats the same
  // deterministic projection from this frozen request/config snapshot.
  lowerResolvedExecutionRequest(request, invocation.config);
  return invocation;
}

function validateWorkflowRuntimeSource(file: string, workspaceRoot: string): void {
  const source = fs.readFileSync(file, "utf8");
  const compiled = compileWorkflowSource(source, { path: file, workspaceRoot });
  if (!compiled.ok) {
    const detail = compiled.errors.map((error) => `${error.path}:${error.line}: ${error.message}`).join("; ");
    throw new UsageError(`Task workflow target is not projectable: ${detail}`, "INVALID_FLAG_VALUE");
  }
  try {
    workflowSourceIrToDocument(compiled.ir, { mode: "runtime" });
  } catch (cause) {
    if (cause instanceof WorkflowSourceProjectionError) {
      throw new UsageError(`Task workflow target is not projectable: ${cause.message}`, "INVALID_FLAG_VALUE");
    }
    throw cause;
  }
}

/** Project one canonical task-v3 source into immutable executable work. */
export async function prepareTaskV3Execution(
  document: TaskV3SourceDocument,
  context: PrepareTaskV3ExecutionContext,
): Promise<PreparedTaskV3Execution> {
  const environment = environmentSnapshot(document.env);
  const common = base(document, context, environment);
  if (document.target.kind === "run") {
    return Object.freeze({
      ...common,
      kind: "shell" as const,
      command: document.target.run,
      shell: document.target.shell ?? "sh",
      cwd: document.target.workingDirectory
        ? path.resolve(context.bundleRoot, document.target.workingDirectory)
        : context.bundleRoot,
    });
  }

  const target = document.target.uses;
  if (target.kind === "github-action") {
    throw new UsageError(
      `GitHub action ${JSON.stringify(target.ref)} is recognized but remote action acquisition is unsupported in 0.9.2.`,
      "INVALID_FLAG_VALUE",
    );
  }
  if (target.kind === "builtin-command") {
    const command = document.target.command;
    if (!command) throw new Error("invariant: parsed built-in command target has no command action");
    const action =
      command.kind === "stored"
        ? {
            ref: qualifyOwnedRef(command.ref, context).qualified,
            ...(command.arguments !== undefined ? { arguments: command.arguments } : {}),
          }
        : { content: command.content, ...(command.arguments !== undefined ? { arguments: command.arguments } : {}) };
    const invocation = validatePreparedCommand(
      await (context.prepareCommand ?? prepareCommandInvocation)({
        action,
        config: context.config,
        invocationKind: "task",
        current: currentExecutionValues(document, context, environment),
        ...(context.commandSourceLoader ? { sourceLoader: context.commandSourceLoader } : {}),
      }),
      context,
    );
    return Object.freeze({ ...common, kind: "command" as const, invocation });
  }

  const { qualified } = qualifyOwnedRef(target.ref, context);
  if (target.kind === "command") {
    if (document.target.with !== undefined) {
      throw new UsageError(
        "Task v3 command refs do not accept with; use akm/command with {ref, arguments} for portable arguments.",
        "INVALID_FLAG_VALUE",
      );
    }
    const invocation = validatePreparedCommand(
      await (context.prepareCommand ?? prepareCommandInvocation)({
        action: { ref: qualified },
        config: context.config,
        invocationKind: "task",
        current: currentExecutionValues(document, context, environment),
        ...(context.commandSourceLoader ? { sourceLoader: context.commandSourceLoader } : {}),
      }),
      context,
    );
    return Object.freeze({ ...common, kind: "command" as const, invocation });
  }
  if (target.kind === "workflow") {
    const resolved = await resolvedOwnedAsset(qualified, "workflow", context);
    validateWorkflowRuntimeSource(resolved.file, resolved.bundleRoot);
    return Object.freeze({
      ...common,
      kind: "workflow" as const,
      ref: qualified,
      params: Object.freeze({ ...(document.target.with ?? {}) }),
      ...(document.akm?.maxSteps !== undefined ? { maxSteps: document.akm.maxSteps } : {}),
      ...(document.akm?.maxRetries !== undefined ? { maxRetries: document.akm.maxRetries } : {}),
    });
  }
  if (document.target.with !== undefined) {
    throw new UsageError("Task v3 script refs do not accept with.", "INVALID_FLAG_VALUE");
  }
  const resolved = await resolvedOwnedAsset(qualified, "script", context);
  const file = resolved.file;
  const extension = path.extname(file).toLowerCase();
  const raw = (context.readFile ?? ((targetPath: string) => fs.readFileSync(targetPath)))(file);
  const bytes = Uint8Array.from(raw);
  return Object.freeze({
    ...common,
    kind: "script" as const,
    sourceRef: qualified,
    interpreter: scriptInterpreter(extension, qualified),
    extension,
    bytesBase64: Buffer.from(bytes).toString("base64"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    cwd: context.bundleRoot,
  });
}
