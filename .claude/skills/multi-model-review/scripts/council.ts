#!/usr/bin/env bun
// Multi-model council: fan one prompt out to several OpenAI-compatible
// endpoints in parallel, one distinct review role per panelist.
//
// Zero dependencies. Runs under Bun >= 1.0 (`bun council.ts`) or Node.js >= 24
// (`node council.ts` -- built-in type stripping, no build step).
//
// @run bun council.ts
//
//   council.ts --list-roles                        available review roles
//   council.ts --list-models [--provider NAME]     authoritative model IDs from each API
//   council.ts --show                              current panel and which keys resolve
//   council.ts --configure                         replace the panel from a JSON spec on stdin
//   council.ts --check [--json]                    liveness probe, ~8 tokens per panelist
//   council.ts --prompt-file PATH [--only a,b] [--json]   ask the panel
//
// Config lives in $COUNCIL_HOME (default ~/.config/akm-council), seeded from
// the bundled config.example.json on first run. Keys are environment variables
// only, named by each provider's `api_key_env`: they are never stored in
// config, never passed as argv, and never printed.
//
// Design adapted from swingsystems/claude-council (MIT).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ------------------------------------------------------------------ config

interface ProviderConfig {
  base_url: string;
  api_key_env: string;
  [extra: string]: unknown;
}

interface PanelistConfig {
  name: string;
  provider: string;
  model: string;
  role?: string;
  lens?: string;
  lens_label?: string;
  enabled?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  timeout?: number;
  extra_body?: Record<string, unknown>;
}

interface CouncilConfig {
  timeout_seconds?: number;
  providers?: Record<string, ProviderConfig>;
  panelists?: PanelistConfig[];
  [extra: string]: unknown;
}

interface RoleConfig {
  label: string;
  lens: string;
}

interface RolesFile {
  roles: Record<string, RoleConfig>;
}

interface AskResult {
  name: string;
  ok: boolean;
  error?: string;
  model?: string;
  label?: string;
  text?: string;
  reasoning?: string;
  elapsed?: number;
  tokens?: number | null;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = path.resolve(SCRIPT_DIR, "..");

function councilHome(): string {
  const explicit = process.env.COUNCIL_HOME;
  if (explicit && explicit.trim() !== "") return explicit;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "akm-council");
}

const HOME_DIR = councilHome();
const CONFIG_PATH = path.join(HOME_DIR, "config.json");
const ROLES_PATH = path.join(HOME_DIR, "roles.json");

const USAGE = `Usage:
  council.ts --list-roles                        available review roles
  council.ts --list-models [--provider NAME]     authoritative model IDs from each API
  council.ts --show                              current panel and which keys resolve
  council.ts --configure                         replace the panel from a JSON spec on stdin
  council.ts --check [--json]                    liveness probe, ~8 tokens per panelist
  council.ts --prompt-file PATH [--only a,b] [--json]   ask the panel
  council.ts --prompt TEXT                       ask with an inline prompt (prefer --prompt-file)

Config: ${CONFIG_PATH}   (override the directory with $COUNCIL_HOME)`;

function die(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorName(err: unknown): string {
  if (typeof err === "object" && err !== null && "name" in err) return String((err as { name: unknown }).name);
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function ensureHome(): void {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    const example = path.join(BUNDLED_DIR, "config.example.json");
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, CONFIG_PATH);
      console.error(`Created ${CONFIG_PATH} from defaults. Export the provider key env vars, then run --check.`);
    }
  }
}

function loadJson(filePath: string, what: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) die(`Missing ${what}: ${filePath}`);
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    die(`Cannot read ${what} (${filePath}): ${errorText(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    die(`Malformed ${what} (${filePath}): ${errorText(err)}`);
  }
  const record = asRecord(parsed);
  if (!record) die(`Malformed ${what} (${filePath}): expected a JSON object`);
  return record;
}

function saveJson(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function loadConfig(): CouncilConfig {
  return loadJson(CONFIG_PATH, "config") as CouncilConfig;
}

function loadRoles(): RolesFile {
  const filePath = fs.existsSync(ROLES_PATH) ? ROLES_PATH : path.join(BUNDLED_DIR, "roles.json");
  const parsed = loadJson(filePath, "roles");
  if (!asRecord(parsed.roles)) die(`Malformed roles (${filePath}): missing "roles" object`);
  return parsed as unknown as RolesFile;
}

// ------------------------------------------------------------- panel wiring

function providerOf(cfg: CouncilConfig, panelist: PanelistConfig): ProviderConfig {
  const provider = cfg.providers?.[panelist.provider];
  if (!provider) throw new Error(`panelist '${panelist.name}' names unknown provider '${panelist.provider}'`);
  return provider;
}

/** Env only, by design: keys are never stored in config or passed as argv. */
function resolveKey(provider: ProviderConfig): string | undefined {
  const value = process.env[provider.api_key_env];
  return value && value.trim() !== "" ? value : undefined;
}

/** Where the key came from -- for --show. Never returns the key itself. */
function keySource(provider: ProviderConfig): string {
  return resolveKey(provider) ? "env" : "NONE";
}

/** Return the review lens. An inline `lens` on the panelist wins over the role. */
function resolveLens(roles: RolesFile, panelist: PanelistConfig): { label: string; lens: string } {
  if (panelist.lens) return { label: panelist.lens_label ?? "custom", lens: panelist.lens };
  const key = panelist.role ?? "generalist";
  const role = roles.roles[key];
  if (!role) throw new Error(`panelist '${panelist.name}' names unknown role '${key}'`);
  return { label: role.label, lens: role.lens };
}

// -------------------------------------------------------------------- http

interface HttpFailure {
  status: number;
  body: string;
}

type HttpOutcome = { data: Record<string, unknown> } | { failure: HttpFailure };

async function requestJson(
  url: string,
  apiKey: string,
  timeoutSec: number,
  payload?: Record<string, unknown>,
): Promise<HttpOutcome> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  let body: string | undefined;
  if (payload !== undefined) {
    body = JSON.stringify(payload);
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, {
    method: payload === undefined ? "GET" : "POST",
    headers,
    body,
    signal: AbortSignal.timeout(Math.max(1000, Math.round(timeoutSec * 1000))),
  });
  const text = await response.text();
  if (!response.ok) return { failure: { status: response.status, body: text } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { failure: { status: response.status, body: `non-JSON response: ${text.slice(0, 200)}` } };
  }
  const record = asRecord(parsed);
  if (!record) return { failure: { status: response.status, body: `non-object response: ${text.slice(0, 200)}` } };
  return { data: record };
}

/**
 * POST a chat completion, adapting once to provider parameter quirks.
 *
 * Providers disagree about parameter names and which values are allowed:
 * some reject `max_tokens` in favour of `max_completion_tokens`, and some
 * reject a non-default `temperature` outright. Rather than making the user
 * hand-tune per-model config, adapt once from the provider's own structured
 * 400 error and retry. A second failure is real and propagates.
 */
async function postChat(
  url: string,
  apiKey: string,
  payload: Record<string, unknown>,
  timeoutSec: number,
): Promise<HttpOutcome> {
  const first = await requestJson(url, apiKey, timeoutSec, payload);
  if ("data" in first || first.failure.status !== 400) return first;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(first.failure.body);
  } catch {
    return first;
  }
  const err = asRecord(asRecord(parsedBody)?.error);
  if (!err) return first;
  const code = err.code;
  const param = typeof err.param === "string" ? err.param : "";
  const message = typeof err.message === "string" ? err.message : "";
  if (code !== "unsupported_parameter" && code !== "unsupported_value") return first;
  if (param === "" || !(param in payload)) return first;

  const retry: Record<string, unknown> = { ...payload };
  if (param === "max_tokens" && message.includes("max_completion_tokens")) {
    retry.max_completion_tokens = retry.max_tokens;
    delete retry.max_tokens;
  } else {
    delete retry[param]; // value not allowed: fall back to the provider default
  }
  return requestJson(url, apiKey, timeoutSec, retry);
}

/** Query one panelist. Never throws -- failures come back as a result object. */
async function ask(
  cfg: CouncilConfig,
  roles: RolesFile,
  panelist: PanelistConfig,
  prompt: string,
  timeoutSec: number,
  maxTokensOverride?: number,
): Promise<AskResult> {
  const name = panelist.name;
  const started = Date.now();
  let provider: ProviderConfig;
  let label: string;
  let lens: string;
  try {
    provider = providerOf(cfg, panelist);
    ({ label, lens } = resolveLens(roles, panelist));
  } catch (err) {
    return { name, ok: false, error: errorText(err) };
  }

  const key = resolveKey(provider);
  if (!key) {
    return {
      name,
      ok: false,
      error:
        `no key: export ${provider.api_key_env}, or inject it for one run with ` +
        `\`akm secret run secrets/<name> ${provider.api_key_env} -- <command>\``,
    };
  }

  const payload: Record<string, unknown> = {
    model: panelist.model,
    messages: [
      { role: "system", content: lens },
      { role: "user", content: prompt },
    ],
    temperature: panelist.temperature ?? 0.2,
    max_tokens: maxTokensOverride ?? panelist.max_tokens ?? 4096,
    stream: false,
  };
  if (panelist.top_p !== undefined) payload.top_p = panelist.top_p;
  for (const [k, v] of Object.entries(panelist.extra_body ?? {})) {
    if (k === "model" || k === "messages" || k === "stream") {
      return {
        name,
        ok: false,
        error: `extra_body may not override '${k}' -- it would break the request. Remove it from config.json.`,
      };
    }
    payload[k] = v;
  }

  const effectiveTimeout = panelist.timeout ?? timeoutSec;
  const url = `${provider.base_url.replace(/\/+$/, "")}/chat/completions`;
  let outcome: HttpOutcome;
  try {
    outcome = await postChat(url, key, payload, effectiveTimeout);
  } catch (err) {
    const kind = errorName(err);
    if (kind === "TimeoutError" || kind === "AbortError") {
      return {
        name,
        ok: false,
        error: `timed out after ${effectiveTimeout}s -- raise timeout_seconds, or set a per-panelist "timeout"`,
      };
    }
    return { name, ok: false, error: `${kind || "Error"}: ${errorText(err)}` };
  }

  if ("failure" in outcome) {
    const { status, body } = outcome.failure;
    let hint = "";
    if (status === 404 && body.trim() === "") {
      hint =
        `  (empty 404 on a ${prompt.length}-char prompt usually means the payload exceeded ` +
        `this model's limit, not a bad model id -- verify with --list-models, then shrink the prompt)`;
    } else if (status === 429 || status === 529) {
      hint = "  (provider overloaded or rate-limited -- transient, retry)";
    }
    return { name, ok: false, error: `HTTP ${status}: ${body.slice(0, 400)}${hint}` };
  }

  const choices = outcome.data.choices;
  const message = Array.isArray(choices) ? asRecord(asRecord(choices[0])?.message) : undefined;
  if (!message) {
    return { name, ok: false, error: `unexpected response shape: ${JSON.stringify(outcome.data).slice(0, 400)}` };
  }

  let text = typeof message.content === "string" ? message.content.trim() : "";
  const rawReasoning = message.reasoning ?? message.reasoning_content;
  const reasoning = typeof rawReasoning === "string" ? rawReasoning.trim() : "";
  if (text === "" && reasoning !== "") text = reasoning; // some thinking models answer only in the reasoning channel

  const usage = asRecord(outcome.data.usage);
  const tokens = usage && typeof usage.total_tokens === "number" ? usage.total_tokens : null;
  return {
    name,
    ok: true,
    model: panelist.model,
    label,
    text,
    reasoning: reasoning === text ? "" : reasoning,
    elapsed: Math.round((Date.now() - started) / 100) / 10,
    tokens,
  };
}

function selectPanel(cfg: CouncilConfig, only: string | undefined): PanelistConfig[] {
  const all = Array.isArray(cfg.panelists) ? cfg.panelists : [];
  let panel = all.filter((p) => p.enabled !== false);
  if (only !== undefined) {
    const wanted = new Set(
      only
        .split(",")
        .map((n) => n.trim().toLowerCase())
        .filter((n) => n !== ""),
    );
    panel = panel.filter((p) => wanted.has(p.name.toLowerCase()));
    const present = new Set(panel.map((p) => p.name.toLowerCase()));
    const missing = [...wanted].filter((n) => !present.has(n)).sort();
    if (missing.length > 0) die(`Unknown or disabled panelist(s): ${missing.join(", ")}`);
  }
  if (panel.length === 0) die("No enabled panelists. Run --configure.");
  return panel;
}

// ---------------------------------------------------------------- commands

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function cmdListRoles(roles: RolesFile): number {
  for (const [key, role] of Object.entries(roles.roles)) {
    console.log(`\n${key}  [${role.label}]`);
    console.log(`  ${role.lens.slice(0, 160)}...`);
  }
  return 0;
}

async function cmdListModels(cfg: CouncilConfig, onlyProvider: string | undefined, timeoutSec: number): Promise<number> {
  let providers = cfg.providers ?? {};
  if (onlyProvider !== undefined) {
    const chosen = providers[onlyProvider];
    if (!chosen) die(`Unknown provider '${onlyProvider}'. Known: ${Object.keys(providers).sort().join(", ")}`);
    providers = { [onlyProvider]: chosen };
  }

  for (const [pname, provider] of Object.entries(providers)) {
    console.log(`\n=== ${pname}  ${provider.base_url} ===`);
    const key = resolveKey(provider);
    if (!key) {
      console.log(`  SKIP: no key (export ${provider.api_key_env})`);
      continue;
    }
    let outcome: HttpOutcome;
    try {
      outcome = await requestJson(`${provider.base_url.replace(/\/+$/, "")}/models`, key, timeoutSec);
    } catch (err) {
      console.log(`  ERROR ${errorName(err) || "Error"}: ${errorText(err)}`);
      continue;
    }
    if ("failure" in outcome) {
      console.log(`  ERROR HTTP ${outcome.failure.status}: ${outcome.failure.body.slice(0, 200)}`);
      continue;
    }
    const data = outcome.data.data;
    const ids = (Array.isArray(data) ? data : [])
      .map((entry) => {
        const id = asRecord(entry)?.id;
        return typeof id === "string" ? id : "?";
      })
      .sort();
    console.log(`  ${ids.length} models`);
    for (const id of ids) console.log(`    ${id}`);
  }
  return 0;
}

function cmdShow(cfg: CouncilConfig): number {
  console.log(`${pad("PANELIST", 12)} ${pad("PROVIDER", 10)} ${pad("ROLE", 16)} ${pad("KEY", 9)} MODEL`);
  for (const p of cfg.panelists ?? []) {
    let hasKey = "?";
    try {
      hasKey = keySource(providerOf(cfg, p));
    } catch {
      hasKey = "?";
    }
    const state = p.enabled === false ? "  (disabled)" : "";
    const role = p.lens ? "custom" : (p.role ?? "-");
    console.log(`${pad(p.name, 12)} ${pad(p.provider ?? "?", 10)} ${pad(role, 16)} ${pad(hasKey, 9)} ${p.model}${state}`);
  }
  return 0;
}

/** Pure: returns a list of problems, writes nothing, never exits. */
function validatePanelists(cfg: CouncilConfig, roles: RolesFile, panelists: unknown[]): string[] {
  const knownProviders = new Set(Object.keys(cfg.providers ?? {}));
  const knownRoles = new Set(Object.keys(roles.roles));
  const seenNames = new Set<string>();
  const errors: string[] = [];

  panelists.forEach((entry, i) => {
    const p = asRecord(entry);
    if (!p) {
      errors.push(`panelist[${i}]: must be a JSON object`);
      return;
    }
    for (const field of ["name", "provider", "model"]) {
      const value = p[field];
      if (typeof value !== "string" || value === "") errors.push(`panelist[${i}]: missing '${field}'`);
    }
    const name = typeof p.name === "string" && p.name !== "" ? p.name : `[${i}]`;
    if (seenNames.has(name)) errors.push(`duplicate panelist name '${name}'`);
    seenNames.add(name);
    const provider = p.provider;
    if (typeof provider === "string" && provider !== "" && !knownProviders.has(provider)) {
      errors.push(`${name}: unknown provider '${provider}' (known: ${[...knownProviders].sort().join(", ")})`);
    }
    const role = p.role;
    if (typeof role === "string" && role !== "" && !knownRoles.has(role) && !p.lens) {
      errors.push(`${name}: unknown role '${role}' (known: ${[...knownRoles].sort().join(", ")})`);
    }
  });
  return errors;
}

/** Read {"panelists":[...]} from stdin and replace the panel. */
function cmdConfigure(cfg: CouncilConfig, roles: RolesFile): number {
  if (process.stdin.isTTY) die(`--configure reads a JSON spec on stdin. Pipe it:\n  echo '{"panelists":[...]}' | council.ts --configure`, 2);
  let spec: unknown;
  try {
    spec = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch (err) {
    die(`Malformed JSON on stdin: ${errorText(err)}`);
  }
  const panelists = asRecord(spec)?.panelists;
  if (!Array.isArray(panelists) || panelists.length === 0) {
    die('Expected {"panelists": [ ... ]} with at least one entry.');
  }

  const errors = validatePanelists(cfg, roles, panelists);
  if (errors.length > 0) {
    for (const e of errors) console.error(`  ${e}`);
    die(`${errors.length} problem(s); config not written.`);
  }

  if (panelists.length > 8) {
    console.error(`NOTE: ${panelists.length} panelists. Beyond ~5 the synthesis gets noisy and cost scales linearly.`);
  }

  cfg.panelists = panelists as unknown as PanelistConfig[];
  saveJson(CONFIG_PATH, cfg);
  console.log(`Wrote ${panelists.length} panelists to ${CONFIG_PATH}:`);
  for (const p of cfg.panelists) {
    console.log(`  ${pad(p.name, 12)} ${pad(p.lens ? "custom" : (p.role ?? "custom"), 16)} ${p.model}`);
  }
  return 0;
}

async function cmdCheck(
  cfg: CouncilConfig,
  roles: RolesFile,
  panel: PanelistConfig[],
  timeoutSec: number,
  json: boolean,
): Promise<number> {
  const results = await Promise.all(panel.map((p) => ask(cfg, roles, p, "Reply with: ok", timeoutSec, 8)));
  results.sort((a, b) => a.name.localeCompare(b.name));
  const failures = results.filter((r) => !r.ok).length;
  if (json) {
    console.log(JSON.stringify({ results }, null, 2));
    return failures > 0 ? 1 : 0;
  }
  for (const r of results) {
    if (r.ok) console.log(`  PASS  ${pad(r.name, 12)} ${r.model}  (${r.elapsed}s)`);
    else console.log(`  FAIL  ${pad(r.name, 12)} ${r.error}`);
  }
  console.log(`\n${results.length - failures}/${results.length} reachable`);
  return failures > 0 ? 1 : 0;
}

async function cmdReview(
  cfg: CouncilConfig,
  roles: RolesFile,
  panel: PanelistConfig[],
  prompt: string,
  timeoutSec: number,
  json: boolean,
): Promise<number> {
  const results = await Promise.all(panel.map((p) => ask(cfg, roles, p, prompt, timeoutSec)));
  const order = new Map(panel.map((p, i) => [p.name, i]));
  results.sort((a, b) => (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999));
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);

  if (json) {
    console.log(JSON.stringify({ results }, null, 2));
    return ok.length > 0 ? 0 : 1;
  }

  const rule = "=".repeat(72);
  for (const r of ok) {
    console.log(`\n${rule}\nPANELIST: ${r.name}  [${r.label}]`);
    console.log(`model: ${r.model}   elapsed: ${r.elapsed}s   tokens: ${r.tokens}\n${rule}`);
    console.log(r.text !== "" ? r.text : "(empty response)");
  }
  if (bad.length > 0) {
    console.log(`\n${rule}\nUNAVAILABLE (${bad.length})\n${rule}`);
    for (const r of bad) console.log(`  ${r.name}: ${r.error}`);
  }
  console.log(`\n--- ${ok.length}/${results.length} panelists responded ---`);
  return ok.length > 0 ? 0 : 1;
}

// -------------------------------------------------------------------- main

interface CliArgs {
  promptFile?: string;
  prompt?: string;
  only?: string;
  provider?: string;
  listModels: boolean;
  listRoles: boolean;
  configure: boolean;
  show: boolean;
  check: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    listModels: false,
    listRoles: false,
    configure: false,
    show: false,
    check: false,
    json: false,
  };
  const valueOf = (flag: string, index: number): string => {
    const value = argv[index];
    if (value === undefined) die(`${flag} needs a value.\n\n${USAGE}`, 2);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--prompt-file":
        args.promptFile = valueOf(flag, ++i);
        break;
      case "--prompt":
        args.prompt = valueOf(flag, ++i);
        break;
      case "--only":
        args.only = valueOf(flag, ++i);
        break;
      case "--provider":
        args.provider = valueOf(flag, ++i);
        break;
      case "--list-models":
        args.listModels = true;
        break;
      case "--list-roles":
        args.listRoles = true;
        break;
      case "--configure":
        args.configure = true;
        break;
      case "--show":
        args.show = true;
        break;
      case "--check":
        args.check = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        die(`Unknown argument: ${flag}\n\n${USAGE}`, 2);
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  ensureHome();
  const cfg = loadConfig();
  const roles = loadRoles();
  const timeoutSec =
    typeof cfg.timeout_seconds === "number" && cfg.timeout_seconds > 0 ? cfg.timeout_seconds : 180;

  if (args.listRoles) return cmdListRoles(roles);
  if (args.configure) return cmdConfigure(cfg, roles);
  if (args.listModels) return await cmdListModels(cfg, args.provider, timeoutSec);
  if (args.show) return cmdShow(cfg);

  const panel = selectPanel(cfg, args.only);
  if (args.check) return await cmdCheck(cfg, roles, panel, timeoutSec, args.json);

  let prompt: string;
  if (args.promptFile !== undefined) {
    try {
      prompt = fs.readFileSync(args.promptFile, "utf8");
    } catch (err) {
      die(`Cannot read prompt file: ${errorText(err)}`);
    }
  } else if (args.prompt !== undefined) {
    prompt = args.prompt;
  } else if (!process.stdin.isTTY) {
    prompt = fs.readFileSync(0, "utf8");
  } else {
    die(`No prompt. Pass --prompt-file PATH, --prompt TEXT, or pipe the prompt on stdin.\n\n${USAGE}`, 2);
  }
  if (prompt.trim() === "") die("Empty prompt.");
  return await cmdReview(cfg, roles, panel, prompt, timeoutSec, args.json);
}

try {
  process.exit(await main());
} catch (err) {
  die(errorText(err));
}
