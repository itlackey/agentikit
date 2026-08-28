// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isAlias, isMap, isScalar, isSeq, LineCounter, type Pair, type ParsedNode, parseDocument } from "yaml";
import { utf8Bytes, WORKFLOW_MAX_SOURCE_BYTES } from "../resource-limits";
import { WorkflowSourceFailure } from "./result";
import {
  WORKFLOW_SOURCE_HOST_SHELLS,
  type WorkflowSourceEnvironmentValue,
  type WorkflowSourceIrV1,
  type WorkflowSourceJob,
  type WorkflowSourceScalar,
  type WorkflowSourceSpan,
  type WorkflowSourceStep,
  type WorkflowSourceTrigger,
} from "./schema";
import {
  canonicalizeWorkflowCron,
  canonicalizeWorkflowRun,
  canonicalizeWorkflowWorkingDirectory,
  classifyWorkflowStepUses,
  validateWorkflowBuiltinCommand,
  type WorkflowSourceCommandMode,
  WorkflowSourceSemanticError,
} from "./semantics";
import {
  classifyWorkflowSourceUses,
  type WorkflowSourceTriggerClassifier,
  type WorkflowSourceTriggerPlan,
  type WorkflowSourceUsesClassifier,
  type WorkflowSourceUsesTarget,
} from "./uses";

const ROOT_KEYS = ["name", "on", "jobs"] as const;
const TRIGGER_KEYS = ["schedule", "workflow_dispatch"] as const;
const SCHEDULE_KEYS = ["cron"] as const;
const JOB_KEYS = ["name", "needs", "runs-on", "steps"] as const;
const STEP_KEYS = ["id", "name", "uses", "run", "with", "env", "shell", "working-directory"] as const;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const HOST_SHELLS = new Set<string>(WORKFLOW_SOURCE_HOST_SHELLS);
const SOURCE_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const INPUT_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_YAML_DEPTH = 32;
const MAX_YAML_NODES = 20_000;
const MAX_STEPS_PER_JOB = 256;

type YamlPair = Pair<ParsedNode, ParsedNode | null>;

export interface GithubWorkflowSourceOptions {
  path: string;
  workspaceRoot?: string;
  /** Canonical workflow uses: classifier; injectable only for bounded compiler tests/consumers. */
  classifyUses?: WorkflowSourceUsesClassifier;
  /** Canonical workflow YAML trigger classifier; injectable only for bounded compiler tests/consumers. */
  classifyTriggers?: WorkflowSourceTriggerClassifier;
}

/** A bounded, non-expanding ownership probe. Validation belongs to compilation. */
export function looksLikeGithubWorkflowSource(source: string): boolean {
  if (utf8Bytes(source) > WORKFLOW_MAX_SOURCE_BYTES) return false;
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(source, { strict: true, uniqueKeys: true, version: "1.2" });
  } catch {
    return false;
  }
  if (!isMap(doc.contents)) return false;
  const keys = new Set<string>();
  for (const pair of doc.contents.items) {
    if (isScalar(pair.key) && typeof pair.key.value === "string") keys.add(pair.key.value);
  }
  return keys.has("on") && keys.has("jobs");
}

export function parseGithubWorkflowSource(source: string, options: GithubWorkflowSourceOptions): WorkflowSourceIrV1 {
  const documentSource = wholeSourceSpan(source, options.path);
  if (utf8Bytes(source) > WORKFLOW_MAX_SOURCE_BYTES) {
    throw new WorkflowSourceFailure("source-size-limit", "Workflow source exceeds the 1 MiB limit.", documentSource);
  }
  const lineCounter = new LineCounter();
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(source, {
      lineCounter,
      strict: true,
      uniqueKeys: true,
      version: "1.2",
    });
  } catch {
    throw new WorkflowSourceFailure("invalid-yaml", "Workflow YAML could not be parsed.", documentSource);
  }
  if (doc.errors.length > 0) {
    const problem = doc.errors[0];
    if (!problem) throw new WorkflowSourceFailure("invalid-yaml", "Invalid YAML.", documentSource);
    const offset = Array.isArray(problem.pos) ? problem.pos[0] : 0;
    const errorSource = spanAtOffset(options.path, lineCounter, offset);
    const code = /Map keys must be unique/i.test(problem.message) ? "duplicate-key" : "invalid-yaml";
    throw new WorkflowSourceFailure(code, cleanYamlMessage(problem.message), errorSource);
  }
  const firstWarning = doc.warnings[0];
  if (firstWarning && /tag/i.test(firstWarning.message)) {
    throw new WorkflowSourceFailure("yaml-custom-tag", cleanYamlMessage(firstWarning.message), documentSource);
  }
  const rootNode = doc.contents;
  if (!isMap(rootNode)) {
    throw new WorkflowSourceFailure(
      "mapping-root-required",
      "GitHub workflow YAML root must be a mapping.",
      documentSource,
    );
  }
  const parsedRoot = rootNode as unknown as ParsedNode;
  const reader = new StrictYamlReader(options.path, lineCounter);
  reader.rejectAliases(parsedRoot);
  reader.checkTree(parsedRoot);
  const root = reader.fields(parsedRoot, ROOT_KEYS, "workflow");
  const name = reader.requiredString(root, "name", "workflow");
  const triggers = parseTriggers(reader, parsedRoot, reader.required(root, "on", "workflow"), options);
  const jobs = parseJobs(reader, reader.required(root, "jobs", "workflow"), options);
  return {
    sourceIrVersion: 1,
    name,
    triggers,
    jobs,
    source: documentSource,
  };
}

class StrictYamlReader {
  private nodes = 0;

  constructor(
    private readonly filePath: string,
    private readonly lineCounter: LineCounter,
  ) {}

  span(node: ParsedNode | null | undefined): WorkflowSourceSpan {
    const range = node?.range;
    if (!range) return { path: this.filePath, start: 1, end: 1 };
    const start = this.lineCounter.linePos(range[0]).line;
    const end = this.lineCounter.linePos(Math.max(range[0], range[1] - 1)).line;
    return { path: this.filePath, start, end: Math.max(start, end) };
  }

  rejectAliases(root: ParsedNode): void {
    const pending: Array<{ node: ParsedNode; depth: number }> = [{ node: root, depth: 0 }];
    let nodes = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) break;
      nodes++;
      if (nodes > MAX_YAML_NODES) this.fail("yaml-node-limit", "YAML exceeds the node limit.", current.node);
      if (current.depth > MAX_YAML_DEPTH) {
        this.fail("yaml-depth-limit", "YAML exceeds the depth limit.", current.node);
      }
      if (isAlias(current.node)) this.fail("yaml-alias", "YAML aliases are not supported.", current.node);
      if (isSeq(current.node)) {
        for (const item of current.node.items) {
          if (item) pending.push({ node: item, depth: current.depth + 1 });
        }
      } else if (isMap(current.node)) {
        for (const pair of current.node.items) {
          if (pair.key) pending.push({ node: pair.key, depth: current.depth + 1 });
          if (pair.value) pending.push({ node: pair.value, depth: current.depth + 1 });
        }
      }
    }
  }

  checkTree(node: ParsedNode, depth = 0): void {
    this.nodes++;
    if (this.nodes > MAX_YAML_NODES) this.fail("yaml-node-limit", "YAML exceeds the node limit.", node);
    if (depth > MAX_YAML_DEPTH) this.fail("yaml-depth-limit", "YAML exceeds the depth limit.", node);
    if (isAlias(node)) this.fail("yaml-alias", "YAML aliases are not supported.", node);
    if ("anchor" in node && typeof node.anchor === "string" && node.anchor !== "") {
      this.fail("yaml-anchor", "YAML anchors are not supported.", node);
    }
    if (node.tag !== undefined) this.fail("yaml-custom-tag", "Explicit YAML tags are not supported.", node);
    if (isScalar(node)) {
      if (typeof node.value === "string" && node.value.includes("${{")) {
        this.fail("unsupported-github-expression", "GitHub expressions and contexts are not supported.", node);
      }
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items) if (item) this.checkTree(item, depth + 1);
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        if (pair.key) this.checkTree(pair.key, depth + 1);
        if (pair.value) this.checkTree(pair.value, depth + 1);
      }
    }
  }

  fields(node: ParsedNode | null, allowed: readonly string[], context: string): Map<string, YamlPair> {
    if (!isMap(node)) this.fail("mapping-required", `${context} must be a mapping.`, node);
    const accepted = new Set<string>(allowed);
    const out = new Map<string, YamlPair>();
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.value.trim() === "") {
        this.fail("string-key-required", `${context} keys must be non-empty strings.`, pair.key);
      }
      const key = pair.key.value;
      if (UNSAFE_KEYS.has(key))
        this.fail("unsafe-key", `${context} contains unsafe key ${JSON.stringify(key)}.`, pair.key);
      if (!accepted.has(key))
        this.fail("unknown-key", `${context} contains unknown key ${JSON.stringify(key)}.`, pair.key);
      out.set(key, pair as YamlPair);
    }
    return out;
  }

  arbitraryFields(node: ParsedNode | null, context: string): Map<string, YamlPair> {
    if (!isMap(node)) this.fail("mapping-required", `${context} must be a mapping.`, node);
    const out = new Map<string, YamlPair>();
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.value.trim() === "") {
        this.fail("string-key-required", `${context} keys must be non-empty strings.`, pair.key);
      }
      const key = pair.key.value;
      if (UNSAFE_KEYS.has(key))
        this.fail("unsafe-key", `${context} contains unsafe key ${JSON.stringify(key)}.`, pair.key);
      out.set(key, pair as YamlPair);
    }
    return out;
  }

  plain(node: ParsedNode | null, context: string): unknown {
    if (node === null) return null;
    if (isScalar(node)) return node.value;
    if (isSeq(node)) {
      return node.items.map((item) => {
        if (!item) this.fail("sparse-yaml-sequence", `${context} may not contain empty entries.`, node);
        return this.plain(item, context);
      });
    }
    if (isMap(node)) {
      const out: Record<string, unknown> = {};
      for (const [key, pair] of this.arbitraryFields(node, context)) {
        out[key] = this.plain(pair.value, `${context}.${key}`);
      }
      return out;
    }
    this.fail("invalid-yaml-node", `${context} contains an unsupported YAML node.`, node);
  }

  lineAt(root: ParsedNode, structuralPath: readonly (string | number)[]): number | undefined {
    let current: ParsedNode | null = root;
    for (const [index, segment] of structuralPath.entries()) {
      if (typeof segment === "string" && isMap(current)) {
        const pair: YamlPair | undefined = current.items.find(
          (candidate) => isScalar(candidate.key) && candidate.key.value === segment,
        ) as YamlPair | undefined;
        if (!pair) return undefined;
        if (pair.value === null) {
          return index === structuralPath.length - 1 ? this.span(pair.key).start : undefined;
        }
        current = pair.value;
        continue;
      }
      if (typeof segment === "number" && isSeq(current)) {
        current = current.items[segment] ?? null;
        if (current === null) return undefined;
        continue;
      }
      return undefined;
    }
    return this.span(current).start;
  }

  required(fields: Map<string, YamlPair>, key: string, context: string): ParsedNode | null {
    const pair = fields.get(key);
    if (!pair) this.fail("missing-key", `${context} is missing required key ${JSON.stringify(key)}.`, undefined);
    return pair.value;
  }

  requiredString(fields: Map<string, YamlPair>, key: string, context: string): string {
    return this.string(this.required(fields, key, context), `${context}.${key}`);
  }

  optionalString(fields: Map<string, YamlPair>, key: string, context: string): string | undefined {
    const pair = fields.get(key);
    return pair ? this.string(pair.value, `${context}.${key}`) : undefined;
  }

  string(node: ParsedNode | null, context: string): string {
    if (!isScalar(node) || typeof node.value !== "string" || node.value.trim() === "") {
      this.fail("string-required", `${context} must be a non-empty string.`, node);
    }
    return node.value;
  }

  scalar(node: ParsedNode | null, context: string, allowNull: boolean): WorkflowSourceScalar {
    if (node === null || (isScalar(node) && node.value === null)) {
      if (allowNull) return null;
      this.fail("scalar-required", `${context} may not be null.`, node);
    }
    if (!isScalar(node)) this.fail("scalar-required", `${context} must be a scalar.`, node);
    const value = node.value;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      this.fail("scalar-required", `${context} must be a string, number, or boolean.`, node);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      this.fail("scalar-required", `${context} must be a finite number.`, node);
    }
    return value;
  }

  sequence(node: ParsedNode | null, context: string, max: number, allowEmpty = false): ParsedNode[] {
    if (!isSeq(node) || (!allowEmpty && node.items.length === 0)) {
      this.fail("sequence-required", `${context} must be ${allowEmpty ? "an" : "a non-empty"} list.`, node);
    }
    if (node.items.length > max) this.fail("step-count-limit", `${context} exceeds ${max} entries.`, node);
    return node.items.map((item) => {
      if (!item) this.fail("sparse-yaml-sequence", `${context} may not contain empty entries.`, node);
      return item;
    });
  }

  fail(code: string, message: string, node: ParsedNode | null | undefined): never {
    throw new WorkflowSourceFailure(code, message, this.span(node));
  }
}

function parseTriggers(
  reader: StrictYamlReader,
  root: ParsedNode,
  node: ParsedNode | null,
  options: GithubWorkflowSourceOptions,
): WorkflowSourceTrigger[] {
  const fields = reader.arbitraryFields(node, "workflow.on");
  for (const [key, pair] of fields) {
    if (!(TRIGGER_KEYS as readonly string[]).includes(key)) {
      reader.fail(
        "unsupported-service-event",
        `GitHub service event ${JSON.stringify(key)} is unsupported for local execution.`,
        pair.key,
      );
    }
  }
  if (fields.size === 0)
    reader.fail("trigger-required", "workflow.on must declare schedule or workflow_dispatch.", node);
  const triggers: WorkflowSourceTrigger[] = [];
  const schedule = fields.get("schedule");
  if (schedule) {
    const records = reader.sequence(schedule.value, "workflow.on.schedule", 64);
    for (const [ordinal, record] of records.entries()) {
      const scheduleFields = reader.fields(record, SCHEDULE_KEYS, `workflow.on.schedule[${ordinal}]`);
      const cronNode = reader.required(scheduleFields, "cron", `workflow.on.schedule[${ordinal}]`);
      const cron = validateCron(reader, reader.string(cronNode, `workflow.on.schedule[${ordinal}].cron`), cronNode);
      triggers.push({ kind: "schedule", cron, ordinal, source: reader.span(cronNode) });
    }
  }
  const manual = fields.get("workflow_dispatch");
  if (manual) {
    const nullValue = manual.value === null || (isScalar(manual.value) && manual.value.value === null);
    if (!nullValue) {
      if (!isMap(manual.value)) {
        reader.fail(
          "workflow-dispatch-inputs-unsupported",
          "workflow_dispatch must be null or an empty mapping; inputs are unsupported.",
          manual.value,
        );
      }
      if (manual.value.items.length > 0) {
        reader.fail(
          "workflow-dispatch-inputs-unsupported",
          "workflow_dispatch inputs are not supported for local execution.",
          manual.value.items[0]?.key,
        );
      }
    }
    triggers.push({ kind: "workflow_dispatch", source: reader.span(manual.key) });
  }
  if (options.classifyTriggers) {
    verifyOwnerTriggerPlan(reader, root, node, triggers, options);
  }
  return triggers;
}

function verifyOwnerTriggerPlan(
  reader: StrictYamlReader,
  root: ParsedNode,
  onNode: ParsedNode | null,
  triggers: WorkflowSourceTrigger[],
  options: GithubWorkflowSourceOptions,
): void {
  const classifier = options.classifyTriggers;
  if (!classifier) return;
  let lastLine = reader.span(onNode).start;
  let plan: WorkflowSourceTriggerPlan;
  try {
    plan = classifier(
      { on: reader.plain(onNode, "workflow.on") },
      {
        filePath: options.path,
        lineAt: (structuralPath) => {
          const line = reader.lineAt(root, structuralPath);
          if (line !== undefined) lastLine = line;
          return line;
        },
      },
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new WorkflowSourceFailure("invalid-trigger", message, {
      path: options.path,
      start: lastLine,
      end: lastLine,
    });
  }
  const expectedSchedules = triggers.filter(
    (trigger): trigger is Extract<WorkflowSourceTrigger, { kind: "schedule" }> => trigger.kind === "schedule",
  );
  const expectedManual = triggers.some((trigger) => trigger.kind === "workflow_dispatch");
  const matches =
    plan !== null &&
    typeof plan === "object" &&
    plan.manual === expectedManual &&
    Array.isArray(plan.schedules) &&
    plan.schedules.length === expectedSchedules.length &&
    plan.schedules.every((binding, index) => {
      const expected = expectedSchedules[index];
      let canonicalBindingCron: string;
      try {
        canonicalBindingCron = canonicalizeWorkflowCron(binding.cron);
      } catch {
        return false;
      }
      return (
        expected !== undefined &&
        canonicalBindingCron === expected.cron &&
        binding.ordinal === expected.ordinal &&
        binding.source === `on.schedule[${expected.ordinal}].cron`
      );
    });
  if (!matches) {
    throw new WorkflowSourceFailure(
      "trigger-classifier-drift",
      "The workflow trigger parser disagrees with the canonical workflow YAML trigger classifier.",
      reader.span(onNode),
    );
  }
}

function validateCron(reader: StrictYamlReader, cron: string, node: ParsedNode | null): string {
  try {
    return canonicalizeWorkflowCron(cron);
  } catch (cause) {
    semanticReaderFail(reader, cause, node);
  }
}

/**
 * The ONE place a job-count or job-dependency policy is enforced (P4 §3.3,
 * docs/plans/specs/p4-deletions-closeout.md): AKM's YAML adapter accepts a
 * familiar GitHub-step-shaped `name:`/`on:`/`jobs:` document, but requires
 * exactly one job (brief §10) — it is an AKM workflow format executed by
 * AKM's native engine, not a GitHub Actions graph. Job ordering, dependency
 * validation and the 256-job bound all existed only to support MULTIPLE
 * jobs; they are gone with the machinery, not relocated.
 */
function parseJobs(
  reader: StrictYamlReader,
  node: ParsedNode | null,
  options: GithubWorkflowSourceOptions,
): WorkflowSourceJob[] {
  const fields = reader.arbitraryFields(node, "workflow.jobs");
  let first: [string, YamlPair] | undefined;
  let second: [string, YamlPair] | undefined;
  for (const entry of fields) {
    if (!first) first = entry;
    else if (!second) second = entry;
  }
  if (fields.size !== 1 || !first) {
    reader.fail(
      "multi-job-unsupported",
      `AKM workflow YAML requires exactly one job; this document declares ${fields.size}. AKM's YAML is an AKM workflow format executed by AKM's native engine, not GitHub Actions — split the jobs into separate workflows.`,
      second ? second[1].key : node,
    );
  }
  const [id, pair] = first;
  const job = parseJob(reader, id, pair, options);
  if (job.needs.length > 0) {
    reader.fail(
      "multi-job-unsupported",
      `Job ${job.id} declares needs, but an AKM workflow has exactly one job; remove needs.`,
      pair.key,
    );
  }
  return [job];
}

function parseJob(
  reader: StrictYamlReader,
  id: string,
  pair: YamlPair,
  options: GithubWorkflowSourceOptions,
): WorkflowSourceJob {
  const node = pair.value;
  if (!SOURCE_ID.test(id)) reader.fail("invalid-job-id", `Invalid job id ${JSON.stringify(id)}.`, node);
  const fields = reader.fields(node, JOB_KEYS, `workflow.jobs.${id}`);
  validateRunner(reader, reader.required(fields, "runs-on", `workflow.jobs.${id}`), id);
  const needs = parseNeeds(reader, fields.get("needs"), id);
  const stepNodes = reader.sequence(
    reader.required(fields, "steps", `workflow.jobs.${id}`),
    `workflow.jobs.${id}.steps`,
    MAX_STEPS_PER_JOB,
  );
  const stepIds = new Set<string>();
  const steps = stepNodes.map((step, index) => parseStep(reader, step, id, index, stepIds, options));
  const name = reader.optionalString(fields, "name", `workflow.jobs.${id}`);
  const keySource = reader.span(pair.key);
  const valueSource = reader.span(node);
  return {
    id,
    ...(name ? { name } : {}),
    needs,
    steps,
    extensions: { "github.com/actions-workflow": { runsOn: ["self-hosted"] } },
    source: { path: keySource.path, start: keySource.start, end: valueSource.end },
  };
}

function validateRunner(reader: StrictYamlReader, node: ParsedNode | null, jobId: string): void {
  if (!isSeq(node) || node.items.length !== 1 || !isScalar(node.items[0]) || node.items[0].value !== "self-hosted") {
    reader.fail(
      "unsupported-runner",
      `Job ${JSON.stringify(jobId)} must declare exactly runs-on: [self-hosted].`,
      node,
    );
  }
}

function parseNeeds(reader: StrictYamlReader, pair: YamlPair | undefined, jobId: string): string[] {
  if (!pair) return [];
  const values = isSeq(pair.value)
    ? reader
        .sequence(pair.value, `workflow.jobs.${jobId}.needs`, 256)
        .map((item) => reader.string(item, `workflow.jobs.${jobId}.needs`))
    : [reader.string(pair.value, `workflow.jobs.${jobId}.needs`)];
  for (const need of values)
    if (!SOURCE_ID.test(need)) reader.fail("invalid-job-id", `Invalid needs id ${need}.`, pair.value);
  // Duplicate-entry checking (code duplicate-job-dependency) deleted with the
  // rest of the multi-job dependency machinery (P4 §3.3): ANY non-empty
  // needs — duplicated or not — is multi-job-unsupported at the caller
  // (parseJobs), since a single-job workflow has nothing to depend on.
  return values.sort();
}

function parseStep(
  reader: StrictYamlReader,
  node: ParsedNode,
  jobId: string,
  index: number,
  stepIds: Set<string>,
  options: GithubWorkflowSourceOptions,
): WorkflowSourceStep {
  const context = `workflow.jobs.${jobId}.steps[${index}]`;
  const fields = reader.fields(node, STEP_KEYS, context);
  const id = reader.requiredString(fields, "id", context);
  if (!SOURCE_ID.test(id))
    reader.fail("invalid-step-id", `Invalid step id ${JSON.stringify(id)}.`, fields.get("id")?.value);
  if (stepIds.has(id))
    reader.fail("duplicate-step-id", `Job ${jobId} has duplicate step id ${id}.`, fields.get("id")?.value);
  stepIds.add(id);
  const usesPair = fields.get("uses");
  const runPair = fields.get("run");
  if ((usesPair === undefined) === (runPair === undefined)) {
    reader.fail("step-target-xor", `${context} must declare exactly one of uses or run.`, node);
  }
  const common = parseStepCommon(reader, fields, context);
  if (usesPair) return parseUsesStep(reader, usesPair, fields, options, { id, ...common, source: reader.span(node) });
  if (!runPair) reader.fail("step-target-xor", `${context} must declare exactly one of uses or run.`, node);
  return parseRunStep(reader, runPair, fields, options, { id, ...common, source: reader.span(node) });
}

function parseStepCommon(reader: StrictYamlReader, fields: Map<string, YamlPair>, context: string) {
  const name = reader.optionalString(fields, "name", context);
  const env = parseScalarMap(reader, fields.get("env"), `${context}.env`, ENV_KEY, false) as
    | Record<string, WorkflowSourceEnvironmentValue>
    | undefined;
  return { ...(name ? { name } : {}), ...(env ? { env } : {}) };
}

function parseUsesStep(
  reader: StrictYamlReader,
  usesPair: YamlPair,
  fields: Map<string, YamlPair>,
  options: GithubWorkflowSourceOptions,
  common: Pick<WorkflowSourceStep, "id" | "name" | "env" | "source">,
): WorkflowSourceStep {
  if (fields.has("shell") || fields.has("working-directory")) {
    reader.fail("uses-field-conflict", "shell and working-directory are legal only with run.", usesPair.value);
  }
  const uses = reader.string(usesPair.value, "step.uses");
  const target = classifyUses(reader, uses, usesPair.value, options.classifyUses ?? classifyWorkflowSourceUses);
  // A-N3 (P2b, docs/plans/specs/p2b-input-bindings.md §1.7), widened in P3a
  // (docs/plans/specs/p3a-plan-v5-child-freeze.md §4.2 step 7, row B-10) to
  // ALSO cover a workflows/<ref> target: a tasks/<ref> or workflows/<ref>
  // step's with: may bind any JSON value the composed target's declared
  // input/param needs (an object/array literal, or a {from: "..."}
  // reference) — decoding it through the scalar-only parseScalarMap would
  // reject the very shapes both A-N3 and A-N8 exist to accept before
  // decodeWorkflowSourceIrV1 (schema.ts) is ever reached. Every other target
  // keeps the byte-identical scalar-only grammar.
  const withValues =
    target.kind === "task" || target.kind === "workflow"
      ? parsePlainMap(reader, fields.get("with"), "step.with", INPUT_KEY)
      : parseScalarMap(reader, fields.get("with"), "step.with", INPUT_KEY, true);
  const commandMode =
    target.kind === "builtin-command"
      ? validateBuiltinCommand(
          reader,
          withValues as Record<string, WorkflowSourceScalar> | undefined,
          fields.get("with")?.value ?? usesPair.value,
        )
      : undefined;
  return {
    ...common,
    uses,
    ...(commandMode ? { commandMode } : {}),
    ...(withValues ? { with: withValues } : {}),
  };
}

function classifyUses(
  reader: StrictYamlReader,
  uses: string,
  node: ParsedNode | null,
  classifier: WorkflowSourceUsesClassifier,
): WorkflowSourceUsesTarget {
  try {
    return classifyWorkflowStepUses(uses, classifier);
  } catch (cause) {
    semanticReaderFail(reader, cause, node);
  }
}

function validateBuiltinCommand(
  reader: StrictYamlReader,
  values: Record<string, WorkflowSourceScalar> | undefined,
  node: ParsedNode | null | undefined,
): WorkflowSourceCommandMode {
  try {
    const action = validateWorkflowBuiltinCommand(values);
    if (action.kind === "stored") return "stored-ref";
    return action.arguments !== undefined || action.content.includes("$ARGUMENTS") ? "portable-template" : "literal";
  } catch (cause) {
    semanticReaderFail(reader, cause, node);
  }
}

function parseRunStep(
  reader: StrictYamlReader,
  runPair: YamlPair,
  fields: Map<string, YamlPair>,
  options: GithubWorkflowSourceOptions,
  common: Pick<WorkflowSourceStep, "id" | "name" | "env" | "source">,
): WorkflowSourceStep {
  if (fields.has("with")) reader.fail("run-field-conflict", "with is legal only with uses.", fields.get("with")?.value);
  let run: string;
  try {
    run = canonicalizeWorkflowRun(reader.string(runPair.value, "step.run"));
  } catch (cause) {
    semanticReaderFail(reader, cause, runPair.value);
  }
  const shell = fields.has("shell") ? reader.requiredString(fields, "shell", "step") : undefined;
  if (shell !== undefined && !HOST_SHELLS.has(shell))
    reader.fail("unsupported-shell", `Unsupported shell ${shell}.`, fields.get("shell")?.value);
  let workingDirectory = fields.has("working-directory")
    ? reader.requiredString(fields, "working-directory", "step")
    : undefined;
  if (workingDirectory !== undefined) {
    try {
      workingDirectory = canonicalizeWorkflowWorkingDirectory(workingDirectory, options.workspaceRoot);
    } catch (cause) {
      semanticReaderFail(reader, cause, fields.get("working-directory")?.value);
    }
  }
  return {
    ...common,
    run,
    ...(shell ? { shell: shell as WorkflowSourceStep["shell"] } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
  };
}

function parseScalarMap(
  reader: StrictYamlReader,
  pair: YamlPair | undefined,
  context: string,
  keyPattern: RegExp,
  allowNull: boolean,
): Record<string, WorkflowSourceScalar> | undefined {
  if (!pair) return undefined;
  const fields = reader.arbitraryFields(pair.value, context);
  const out: Record<string, WorkflowSourceScalar> = {};
  for (const [key, valuePair] of fields) {
    if (!keyPattern.test(key))
      reader.fail("invalid-mapping-key", `${context} has invalid key ${JSON.stringify(key)}.`, valuePair.key);
    out[key] = reader.scalar(valuePair.value, `${context}.${key}`, allowNull);
  }
  return out;
}

/**
 * Like {@link parseScalarMap} but accepts an arbitrary JSON value per key —
 * a task-composition with: binding may be the declared input's own shape (an
 * object/array literal, or a `{from: "..."}` reference), not just a scalar
 * (A-N3). Depth/node bounds are already enforced document-wide by
 * `checkTree`/`rejectAliases` before any field-level parsing runs, so this
 * adds no new bound. `decodeWorkflowSourceIrV1` (schema.ts) decides what a
 * declared input actually accepts.
 */
function parsePlainMap(
  reader: StrictYamlReader,
  pair: YamlPair | undefined,
  context: string,
  keyPattern: RegExp,
): Record<string, unknown> | undefined {
  if (!pair) return undefined;
  const fields = reader.arbitraryFields(pair.value, context);
  const out: Record<string, unknown> = {};
  for (const [key, valuePair] of fields) {
    if (!keyPattern.test(key))
      reader.fail("invalid-mapping-key", `${context} has invalid key ${JSON.stringify(key)}.`, valuePair.key);
    out[key] = reader.plain(valuePair.value, `${context}.${key}`);
  }
  return out;
}

function wholeSourceSpan(source: string, filePath: string): WorkflowSourceSpan {
  return { path: filePath, start: 1, end: Math.max(1, source.split(/\r?\n/).length) };
}

function spanAtOffset(filePath: string, counter: LineCounter, offset: number): WorkflowSourceSpan {
  const line = counter.linePos(Math.max(0, offset)).line;
  return { path: filePath, start: line, end: line };
}

function cleanYamlMessage(message: string): string {
  return message.replace(/\s+at line \d+, column \d+:[\s\S]*$/i, "").trim();
}

function semanticReaderFail(reader: StrictYamlReader, cause: unknown, node: ParsedNode | null | undefined): never {
  if (cause instanceof WorkflowSourceSemanticError) reader.fail(cause.code, cause.message, node);
  reader.fail("invalid-workflow-source", cause instanceof Error ? cause.message : String(cause), node);
}
