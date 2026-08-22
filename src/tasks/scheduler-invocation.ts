// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bundleRefToString, parseBundleRef } from "../core/asset/asset-ref";
import { resolveStashDir } from "../core/common";
import { ConfigError } from "../core/errors";
import { getCacheDir, getConfigDir, getDataDir, getTaskContextDir } from "../core/paths";
import { normaliseTaskConceptId } from "./task-id";

export const SCHEDULED_TASK_CONTEXT_KEYS = [
  "AKM_BUNDLE_DIR",
  "AKM_CONFIG_DIR",
  "AKM_DATA_DIR",
  "AKM_CACHE_DIR",
  "AKM_STATE_DIR",
] as const;

type ScheduledTaskContextKey = (typeof SCHEDULED_TASK_CONTEXT_KEYS)[number];

/**
 * The AKM_* directory context currently in effect, as a plain env fragment.
 *
 * A scheduled run restores these into `process.env` from its
 * `--scheduler-context` descriptor precisely because such installs have
 * non-default directories. Paths that build a child environment from an
 * allowlist rather than inheriting (the agent spawn) must forward this
 * explicitly, or the child's `akm` sub-commands silently target the default
 * stash and DB.
 */
export function scheduledTaskContextEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SCHEDULED_TASK_CONTEXT_KEYS) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

export type ScheduledTaskContext = Record<ScheduledTaskContextKey, string>;

export interface ScheduledTaskContextDescriptor {
  version: 1;
  environment: ScheduledTaskContext & { PATH: string };
}

export interface ScheduledTaskInvocation {
  argv: string[];
}

export interface ParsedScheduledBindingInvocation {
  binding: string[];
  contextPath: string;
  invocation: string[];
  target?: string;
}

export const SCHEDULER_CONTEXT_ARG = "--scheduler-context";

/** Resolve the complete non-secret AKM directory context captured by schedulers. */
export function resolveScheduledTaskContext(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ScheduledTaskContext {
  return canonicalContext({
    AKM_BUNDLE_DIR: path.resolve(resolveStashDir(env)),
    AKM_CONFIG_DIR: path.resolve(getConfigDir(env, platform)),
    AKM_DATA_DIR: path.resolve(getDataDir(env, platform)),
    AKM_CACHE_DIR: path.resolve(getCacheDir(env)),
    // Capture the complete process directory context used by scheduled commands.
    AKM_STATE_DIR: path.resolve(resolveStateDir(env, platform)),
  });
}

/**
 * Build the one scheduler-generated argv shape consumed by all backends.
 *
 * `target` records the bundle a non-primary task lives in as a `--bundle
 * <bundle>` token so the scheduled `akm task run` resolves the task (and its
 * relative asset refs) from that bundle. It is emitted ONLY when supplied and
 * non-empty — callers pass it exclusively for a non-default bundle, so a
 * primary-bundle (or default) task omits the target pair.
 */
export function buildScheduledTaskInvocation(
  akmArgv: readonly string[],
  id: string,
  contextPath: string,
  target?: string,
): ScheduledTaskInvocation {
  const targetArgs = target !== undefined && target !== "" ? ["--bundle", target] : [];
  return buildScheduledBindingInvocation(akmArgv, contextPath, ["task", "run", id, ...targetArgs, "--scheduled"]);
}

/** Build an installed argv from one already-validated public scheduler tail. */
export function buildScheduledBindingInvocation(
  akmArgv: readonly string[],
  contextPath: string,
  invocation: readonly string[],
): ScheduledTaskInvocation {
  const parsed = parsePublicSchedulerInvocation(invocation);
  if (!parsed) throw invalidSchedulerInvocation();
  return {
    argv: [...akmArgv, SCHEDULER_CONTEXT_ARG, assertAbsolutePath(contextPath), ...parsed.invocation],
  };
}

export function schedulerContextDescriptor(
  context: ScheduledTaskContext = resolveScheduledTaskContext(),
  envPath: string = process.env.PATH ?? "",
): ScheduledTaskContextDescriptor {
  return {
    version: 1,
    environment: { ...canonicalContext(context), PATH: validatePathValue(envPath) },
  };
}

export function schedulerContextPath(descriptor: ScheduledTaskContextDescriptor): string {
  const bytes = serializeDescriptor(descriptor);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return path.join(getTaskContextDir(descriptor.environment), `${digest}.json`);
}

/** Write a content-addressed descriptor without ever replacing existing content. */
export function writeSchedulerContextDescriptor(
  descriptor: ScheduledTaskContextDescriptor = schedulerContextDescriptor(),
): string {
  const file = schedulerContextPath(descriptor);
  const bytes = serializeDescriptor(descriptor);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(path.dirname(file), 0o700);
  }
  if (lstatIfExists(file)) {
    if (serializeDescriptor(validateSchedulerContextDescriptor(file)) !== bytes) throw invalidSchedulerContext();
    return file;
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      fs.renameSync(temp, file);
    } catch (error) {
      if (!lstatIfExists(file) || serializeDescriptor(validateSchedulerContextDescriptor(file)) !== bytes) throw error;
    }
    restrictDescriptor(file);
    validateSchedulerContextDescriptor(file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return file;
}

export function loadSchedulerContextDescriptor(file: string, env: NodeJS.ProcessEnv = process.env): void {
  const descriptor = validateSchedulerContextDescriptor(file);
  for (const key of SCHEDULED_TASK_CONTEXT_KEYS) env[key] = descriptor.environment[key];
  env.PATH = descriptor.environment.PATH;
}

export function validateSchedulerContextDescriptor(file: string): ScheduledTaskContextDescriptor {
  const absolute = assertAbsolutePath(file);
  let linkStat: fs.Stats;
  try {
    linkStat = fs.lstatSync(absolute);
  } catch (error) {
    throw schedulerContextFileError(absolute, error instanceof Error ? error.message : String(error));
  }
  if (linkStat.isSymbolicLink()) throw schedulerContextFileError(absolute, "symbolic links are not allowed");
  if (!linkStat.isFile()) throw schedulerContextFileError(absolute, "path is not a regular file");

  let descriptorBytes: Buffer;
  let fd: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw schedulerContextFileError(absolute, "path is not a regular file");
    if (process.platform !== "win32") {
      if (typeof process.getuid !== "function") {
        throw schedulerContextFileError(absolute, "current uid is unavailable for ownership verification");
      }
      const uid = process.getuid();
      if (stat.uid !== uid)
        throw schedulerContextFileError(absolute, `file owner ${stat.uid} does not match uid ${uid}`);
      if ((stat.mode & 0o077) !== 0) {
        throw schedulerContextFileError(absolute, "group or other permissions must be disabled");
      }
    }
    descriptorBytes = fs.readFileSync(fd);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw schedulerContextFileError(absolute, error instanceof Error ? error.message : String(error));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  const filename = path.basename(absolute);
  const match = /^([a-f0-9]{64})\.json$/.exec(filename);
  const digest = createHash("sha256").update(descriptorBytes).digest("hex");
  if (!match || match[1] !== digest) {
    throw schedulerContextFileError(absolute, "content SHA-256 does not match the descriptor filename");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(descriptorBytes.toString("utf8"));
  } catch (error) {
    throw schedulerContextFileError(absolute, error instanceof Error ? error.message : String(error));
  }
  return canonicalDescriptor(parsed);
}

/** Load and remove the hidden descriptor argument before citty parses argv. */
export function consumeSchedulerContextArg(argv: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const separator = argv.indexOf("--");
  const index = argv.slice(0, separator === -1 ? argv.length : separator).indexOf(SCHEDULER_CONTEXT_ARG);
  if (index === -1) return argv;
  const file = argv[index + 1];
  if (!file) {
    throw new ConfigError(`${SCHEDULER_CONTEXT_ARG} requires an absolute descriptor path.`, "INVALID_CONFIG_FILE");
  }
  loadSchedulerContextDescriptor(file, env);
  return [...argv.slice(0, index), ...argv.slice(index + 2)];
}

export function parseScheduledTaskArgv(argv: readonly string[]):
  | {
      binding: string[];
      contextPath: string;
      target?: string;
    }
  | undefined {
  const parsed = parseScheduledBindingArgv(argv);
  if (!parsed || parsed.invocation[0] !== "task") return undefined;
  return {
    binding: parsed.binding,
    contextPath: parsed.contextPath,
    ...(parsed.target !== undefined ? { target: parsed.target } : {}),
  };
}

/** Parse either the public scheduled task or qualified workflow invocation. */
export function parseScheduledBindingArgv(argv: readonly string[]): ParsedScheduledBindingInvocation | undefined {
  const contextIndex = argv.indexOf(SCHEDULER_CONTEXT_ARG);
  if (contextIndex < 1 || argv.indexOf(SCHEDULER_CONTEXT_ARG, contextIndex + 1) !== -1) return undefined;
  const contextPath = argv[contextIndex + 1];
  if (!contextPath) return undefined;
  const publicInvocation = parsePublicSchedulerInvocation(argv.slice(contextIndex + 2));
  if (!publicInvocation) return undefined;
  return {
    binding: [...argv.slice(0, contextIndex)],
    contextPath: assertAbsolutePath(contextPath),
    invocation: publicInvocation.invocation,
    ...(publicInvocation.target !== undefined ? { target: publicInvocation.target } : {}),
  };
}

function parsePublicSchedulerInvocation(
  invocation: readonly string[],
): { invocation: string[]; target?: string } | undefined {
  if (invocation[0] === "task" && invocation[1] === "run" && invocation[2]) {
    if (invocation[2].includes("/")) {
      try {
        if (normaliseTaskConceptId(invocation[2]) !== invocation[2]) return undefined;
      } catch {
        return undefined;
      }
    }
    let index = 3;
    let target: string | undefined;
    if (invocation[index] === "--bundle") {
      target = invocation[index + 1];
      if (!target) return undefined;
      index += 2;
    }
    if (invocation[index] !== "--scheduled" || index !== invocation.length - 1) return undefined;
    return { invocation: [...invocation], ...(target !== undefined ? { target } : {}) };
  }
  if (invocation[0] !== "workflow" || invocation[1] !== "run" || invocation.length !== 3) return undefined;
  const ref = invocation[2];
  if (!ref) return undefined;
  try {
    const parsed = parseBundleRef(ref);
    if (!parsed.bundle || parsed.fragment !== undefined || bundleRefToString(parsed) !== ref) return undefined;
    return { invocation: [...invocation], target: parsed.bundle };
  } catch {
    return undefined;
  }
}

function canonicalContext(input: Record<string, unknown>): ScheduledTaskContext {
  const inputKeys = Object.keys(input);
  if (
    inputKeys.length !== SCHEDULED_TASK_CONTEXT_KEYS.length ||
    inputKeys.some((key) => !SCHEDULED_TASK_CONTEXT_KEYS.includes(key as ScheduledTaskContextKey))
  ) {
    throw invalidSchedulerContext();
  }

  const context = {} as ScheduledTaskContext;
  for (const key of SCHEDULED_TASK_CONTEXT_KEYS) {
    const value = input[key];
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      containsControlCharacter(value) ||
      (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value))
    ) {
      throw invalidSchedulerContext();
    }
    context[key] = value;
  }
  return context;
}

function canonicalDescriptor(input: unknown): ScheduledTaskContextDescriptor {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalidSchedulerContext();
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.version !== 1) throw invalidSchedulerContext();
  const rawEnvironment = record.environment;
  if (typeof rawEnvironment !== "object" || rawEnvironment === null || Array.isArray(rawEnvironment)) {
    throw invalidSchedulerContext();
  }
  const environment = rawEnvironment as Record<string, unknown>;
  if (Object.keys(environment).length !== SCHEDULED_TASK_CONTEXT_KEYS.length + 1) throw invalidSchedulerContext();
  const PATH = validatePathValue(environment.PATH);
  const { PATH: _, ...rawContext } = environment;
  return { version: 1, environment: { ...canonicalContext(rawContext), PATH } };
}

function serializeDescriptor(descriptor: ScheduledTaskContextDescriptor): string {
  return `${JSON.stringify(canonicalDescriptor(descriptor))}\n`;
}

function validatePathValue(value: unknown): string {
  if (typeof value !== "string" || containsControlCharacter(value)) throw invalidSchedulerContext();
  return value;
}

function assertAbsolutePath(value: string): string {
  if (containsControlCharacter(value) || (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value))) {
    throw invalidSchedulerContext();
  }
  return value;
}

function restrictDescriptor(file: string): void {
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function lstatIfExists(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function schedulerContextFileError(file: string, reason: string): ConfigError {
  return new ConfigError(`Invalid scheduler context descriptor "${file}": ${reason}.`, "INVALID_CONFIG_FILE");
}

function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function resolveStateDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const override = env.AKM_STATE_DIR?.trim();
  if (override) return override;

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) return path.join(localAppData, "akm", "state");
    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) return path.join(userProfile, "AppData", "Local", "akm", "state");
    const appData = env.APPDATA?.trim();
    if (appData) return path.join(appData, "..", "Local", "akm", "state");
    throw new ConfigError(
      "Unable to determine state directory. Set LOCALAPPDATA, USERPROFILE, or APPDATA.",
      "CONFIG_DIR_UNRESOLVABLE",
    );
  }

  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) return path.join(xdgStateHome, "akm");
  const home = env.HOME?.trim();
  return home ? path.join(home, ".local", "state", "akm") : path.join("/tmp", "akm-state");
}

function invalidSchedulerContext(): ConfigError {
  return new ConfigError(
    `Invalid scheduler context; expected exactly ${SCHEDULED_TASK_CONTEXT_KEYS.join(", ")} as absolute paths.`,
    "INVALID_CONFIG_FILE",
  );
}

function invalidSchedulerInvocation(): ConfigError {
  return new ConfigError(
    "Invalid scheduler invocation; expected public `task run <id> [--bundle <bundle>] --scheduled` or `workflow run <qualified-ref>` argv.",
    "INVALID_CONFIG_FILE",
  );
}
