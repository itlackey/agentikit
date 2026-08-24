// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const ENV_OPTIONS_WITH_OPERAND = new Set(["--argv0", "--chdir", "--unset"]);
const ENV_OPTIONS_WITH_OPTIONAL_VALUE = new Set(["--block-signal", "--default-signal", "--ignore-signal"]);
const ENV_OPTIONS_WITHOUT_OPERAND = new Set(["--debug", "--ignore-environment", "--list-signal-handling"]);
const AKM_GLOBAL_BOOLEAN_OPTIONS = new Set([
  "--quiet",
  "-q",
  "--verbose",
  "--no-quiet",
  "--no-verbose",
  "--quiet=false",
  "--verbose=false",
]);
const AKM_GLOBAL_VALUE_OPTIONS = new Set(["--format", "--output", "--detail", "--shape"]);

/** Normalize the complete permissive 0.8 task shape for direct v3 conversion. */
export function normalizeLegacyTask(data: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { version: 2 };
  for (const key of ["schedule", "workflow", "prompt", "command", "name", "description", "when_to_use"] as const) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (key === "command" && Array.isArray(value)) {
      normalized[key] = value.filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      normalized[key] = String(value).trim();
    } else {
      normalized[key] = value;
    }
  }

  normalized.enabled = data.enabled === undefined ? true : data.enabled === true;

  if (typeof data.tags === "string") {
    normalized.tags = data.tags
      .split(/[\s,]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  } else if (Array.isArray(data.tags)) {
    normalized.tags = data.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
  }

  const hasWorkflow = "workflow" in data && data.workflow !== "" && data.workflow != null;
  const hasPrompt = "prompt" in data && data.prompt !== "" && data.prompt != null;

  if (hasWorkflow && data.params && typeof data.params === "object" && !Array.isArray(data.params)) {
    normalized.params = data.params;
  } else if (hasWorkflow && typeof data.params === "string" && data.params.trim()) {
    try {
      const params = JSON.parse(data.params);
      normalized.params = params && typeof params === "object" && !Array.isArray(params) ? params : data.params;
    } catch {
      normalized.params = data.params;
    }
  }

  if (hasPrompt && data.profile !== undefined && data.profile !== null) {
    const profile = legacyString(data.profile);
    if (profile === undefined) throw new Error('Key "profile" must be a string.');
    if (profile) normalized.engine = profile;
  }

  if (!hasWorkflow && "timeoutMs" in data) {
    const timeout = data.timeoutMs;
    if (timeout === null || timeout === "null" || timeout === 0 || (typeof timeout === "number" && timeout < 0)) {
      normalized.timeoutMs = null;
    } else if (typeof timeout === "number" && timeout > 0) {
      normalized.timeoutMs = timeout;
    }
  }

  const command = normalized.command;
  if (typeof command === "string" || Array.isArray(command)) {
    const wasArray = Array.isArray(command);
    const parts = wasArray ? command.filter((part): part is string => typeof part === "string") : command.split(/\s+/);
    const migrated = normalizeLegacyCommand(parts.filter(Boolean));
    normalized.command = wasArray ? migrated : migrated.join(" ");
    if (isObsoleteBackupCommand(migrated)) normalized.enabled = false;
  }

  return normalized;
}

function legacyString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** Rewrite only retired syntax sent to a PATH-selected current AKM binary. */
function normalizeLegacyCommand(command: string[]): string[] {
  const akmIndex = findBareAkmExecutableIndex(command);
  if (akmIndex === undefined) return command;
  const improveIndex = findImproveSubcommandIndex(command, akmIndex);
  if (improveIndex === undefined) return command;

  const normalized = command.slice(0, improveIndex + 1);
  for (let index = improveIndex + 1; index < command.length; index += 1) {
    const part = command[index]!;
    if (part === "--auto-accept") {
      if (command[index + 1] && !command[index + 1]!.startsWith("-")) index += 1;
      continue;
    }
    if (part === "--no-auto-accept" || part.startsWith("--auto-accept=")) continue;
    if (part === "--profile") normalized.push("--strategy");
    else if (part.startsWith("--profile=")) normalized.push(`--strategy=${part.slice("--profile=".length)}`);
    else normalized.push(part);
  }
  return normalized;
}

function isObsoleteBackupCommand(command: readonly string[]): boolean {
  const akmIndex = findBareAkmExecutableIndex(command);
  if (akmIndex === undefined) return false;
  const args = command.slice(akmIndex + 1);
  return args.length === 2 && args[0] === "db" && args[1] === "backups";
}

function findImproveSubcommandIndex(command: readonly string[], akmIndex: number): number | undefined {
  let index = akmIndex + 1;
  while (index < command.length) {
    const part = command[index]!;
    if (part === "improve") return index;
    if (AKM_GLOBAL_BOOLEAN_OPTIONS.has(part)) {
      index += 1;
      continue;
    }
    if (AKM_GLOBAL_VALUE_OPTIONS.has(part)) {
      if (index + 1 >= command.length) return undefined;
      index += 2;
      continue;
    }
    if (
      [...AKM_GLOBAL_VALUE_OPTIONS].some((option) => part.startsWith(`${option}=`) && part.length > option.length + 1)
    ) {
      index += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function findBareAkmExecutableIndex(command: readonly string[]): number | undefined {
  if (command.length === 0) return undefined;
  const executableIndex = isEnvExecutable(command[0]) ? findEnvCommandIndex(command) : 0;
  if (executableIndex === undefined || !isBareAkm(command[executableIndex])) return undefined;
  return executableIndex;
}

function findEnvCommandIndex(command: readonly string[]): number | undefined {
  let index = 1;
  while (index < command.length) {
    const part = command[index]!;
    if (part === "--") {
      index += 1;
      break;
    }
    if (isEnvironmentAssignment(part)) break;
    if (!part.startsWith("-")) break;
    const operandCount = envOptionOperandCount(part);
    if (operandCount === undefined || index + operandCount >= command.length) return undefined;
    index += operandCount + 1;
  }
  while (index < command.length && isEnvironmentAssignment(command[index]!)) index += 1;
  return index < command.length ? index : undefined;
}

function envOptionOperandCount(option: string): 0 | 1 | undefined {
  if (option === "-") return 0;
  if (ENV_OPTIONS_WITHOUT_OPERAND.has(option) || ENV_OPTIONS_WITH_OPTIONAL_VALUE.has(option)) return 0;
  if ([...ENV_OPTIONS_WITH_OPTIONAL_VALUE].some((prefix) => option.startsWith(`${prefix}=`))) return 0;
  if (ENV_OPTIONS_WITH_OPERAND.has(option)) return 1;
  if (["--argv0=", "--chdir=", "--unset="].some((prefix) => option.startsWith(prefix))) return 0;
  if (!option.startsWith("-") || option.startsWith("--")) return undefined;

  const shortOptions = option.slice(1);
  for (let index = 0; index < shortOptions.length; index += 1) {
    const flag = shortOptions[index];
    if (flag === "i" || flag === "v") continue;
    if (flag === "S") return undefined;
    if (flag === "u" || flag === "C" || flag === "P" || flag === "a") {
      return index === shortOptions.length - 1 ? 1 : 0;
    }
    return undefined;
  }
  return shortOptions.length > 0 ? 0 : undefined;
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function isEnvExecutable(value: string | undefined): boolean {
  if (!value) return false;
  if (value === "env") return true;
  if (!isAbsolutePath(value)) return false;
  return /^env(?:\.exe)?$/i.test(value.split(/[\\/]/).at(-1) ?? "");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

function isBareAkm(value: string | undefined): boolean {
  return value !== undefined && /^akm(?:\.exe)?$/i.test(value);
}
