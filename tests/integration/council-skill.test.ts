// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Offline tests for the multi-model-review skill runner
 * (.claude/skills/multi-model-review/scripts/council.ts).
 *
 * A Bun.serve mock stands in for the OpenAI-compatible providers, and the
 * runner is exercised as a subprocess exactly the way an agent invokes it.
 * Nothing here talks to a real endpoint and no key material is real. Covered:
 *
 *   - first-run config seeding and --show key-source reporting
 *   - parallel fan-out where one failing panelist never kills the run
 *   - role lens -> system message wiring and per-panelist tuning forwarding
 *   - reasoning-channel fallback for thinking models
 *   - the one-shot unsupported_parameter adaptation (max_tokens ->
 *     max_completion_tokens) driven by the provider's structured 400
 *   - missing-key handling (env-only resolution, no request sent)
 *   - per-panelist timeout enforcement
 *   - --check probe budget, --only filtering, --configure validation,
 *     --list-models, --json output, and prompt intake edge cases
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "../../.claude/skills/multi-model-review/scripts/council.ts");
const KEY_ENV = "COUNCIL_TEST_KEY_A";
const KEY_VALUE = "council-test-key-a";
const MISSING_KEY_ENV = "COUNCIL_TEST_KEY_MISSING";

interface SeenRequest {
  model: string;
  auth: string | null;
  body: Record<string, unknown>;
}

const seen: SeenRequest[] = [];
let inFlight = 0;
let maxInFlight = 0;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function chat(content: string, extra?: Record<string, unknown>): Response {
  return json({
    choices: [{ message: { content, ...(extra ?? {}) } }],
    usage: { total_tokens: 42 },
  });
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let tmpRoot = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");

      if (url.pathname === "/v1/models" && req.method === "GET") {
        if (auth !== `Bearer ${KEY_VALUE}`) return json({ error: "bad key" }, 401);
        return json({ data: [{ id: "vendor/model-b" }, { id: "vendor/model-a" }] });
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        const model = String(body.model);
        seen.push({ model, auth, body });
        if (auth !== `Bearer ${KEY_VALUE}`) return json({ error: "bad key" }, 403);

        if (model === "vendor/echo") {
          const messages = body.messages as Array<{ role: string; content: string }>;
          return chat(
            JSON.stringify({
              system: messages[0]?.content,
              user: messages[1]?.content,
              temperature: body.temperature,
              max_tokens: body.max_tokens,
              top_p: body.top_p,
              reasoning_effort: body.reasoning_effort,
            }),
          );
        }
        if (model === "vendor/reasoner") {
          return chat("", { reasoning_content: "reasoning-only answer" });
        }
        if (model === "vendor/broken") {
          return new Response("internal exploded", { status: 500 });
        }
        if (model === "vendor/legacy") {
          if (body.max_tokens !== undefined) {
            return json(
              {
                error: {
                  param: "max_tokens",
                  code: "unsupported_parameter",
                  message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
                },
              },
              400,
            );
          }
          if (body.max_completion_tokens !== undefined) return chat("adapted ok");
          return new Response("neither token parameter present", { status: 500 });
        }
        if (model === "vendor/slow") {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Bun.sleep(150);
          inFlight -= 1;
          return chat("slow ok");
        }
        if (model === "vendor/hang") {
          await Bun.sleep(3000);
          return chat("should never arrive");
        }
        return new Response("", { status: 404 });
      }

      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}/v1`;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-skill-test-"));
});

afterAll(() => {
  server.stop(true);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let homeCounter = 0;

function freshHome(): string {
  homeCounter += 1;
  const dir = path.join(tmpRoot, `home-${homeCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(home: string, panelists: Array<Record<string, unknown>>): string {
  const configPath = path.join(home, "config.json");
  const config = {
    timeout_seconds: 30,
    providers: {
      mock: { base_url: baseUrl, api_key_env: KEY_ENV },
      nokey: { base_url: baseUrl, api_key_env: MISSING_KEY_ENV },
    },
    panelists,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

async function runCouncil(
  args: string[],
  opts: { home: string; env?: Record<string, string>; stdin?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      COUNCIL_HOME: opts.home,
      ...(opts.env ?? {}),
    },
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("multi-model-review skill runner", () => {
  test("seeds config from the bundled example on first run and reports key sources", async () => {
    const home = freshHome();
    const res = await runCouncil(["--show"], { home });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Created");
    expect(fs.existsSync(path.join(home, "config.json"))).toBe(true);
    // The seeded example names real vendors; no key env vars are set, so every
    // row must report NONE and nothing may be contacted (--show is offline).
    expect(res.stdout).toContain("PANELIST");
    expect(res.stdout).toContain("NONE");
  });

  test("--list-roles lists the nine bundled roles", async () => {
    const home = freshHome();
    const res = await runCouncil(["--list-roles"], { home });
    expect(res.exitCode).toBe(0);
    for (const role of [
      "correctness",
      "architecture",
      "security",
      "regression",
      "performance",
      "simplicity",
      "data-integrity",
      "product",
      "generalist",
    ]) {
      expect(res.stdout).toContain(`${role}  [`);
    }
  });

  test("fans out in parallel, wires the role lens, and isolates per-panelist failures", async () => {
    const home = freshHome();
    writeConfig(home, [
      { name: "echo", provider: "mock", model: "vendor/echo", role: "correctness", enabled: true },
      { name: "reasoner", provider: "mock", model: "vendor/reasoner", role: "security", enabled: true },
      { name: "broken", provider: "mock", model: "vendor/broken", role: "performance", enabled: true },
      { name: "keyless", provider: "nokey", model: "vendor/echo", role: "generalist", enabled: true },
      { name: "benched", provider: "mock", model: "vendor/echo", role: "product", enabled: false },
    ]);
    const res = await runCouncil(["--prompt", "Council test prompt"], { home, env: { [KEY_ENV]: KEY_VALUE } });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("PANELIST: echo  [correctness]");
    // The echo model reflects the request, proving the role lens became the
    // system message and the user prompt arrived intact with the defaults.
    expect(res.stdout).toContain("reviewing for correctness");
    expect(res.stdout).toContain('"user":"Council test prompt"');
    expect(res.stdout).toContain('"temperature":0.2');
    expect(res.stdout).toContain('"max_tokens":4096');
    // Thinking models that answer only in the reasoning channel still count.
    expect(res.stdout).toContain("reasoning-only answer");
    // Failures are reported, never fatal.
    expect(res.stdout).toContain("UNAVAILABLE (2)");
    expect(res.stdout).toContain("broken: HTTP 500");
    expect(res.stdout).toContain(`keyless: no key: export ${MISSING_KEY_ENV}`);
    expect(res.stdout).not.toContain("benched");
    expect(res.stdout).toContain("--- 2/4 panelists responded ---");
    // The keyless panelist must fail locally without a request going out.
    const keylessRequests = seen.filter((r) => r.auth === null);
    expect(keylessRequests.length).toBe(0);
  });

  test("--json emits structured results for tooling", async () => {
    const home = freshHome();
    writeConfig(home, [
      { name: "echo", provider: "mock", model: "vendor/echo", role: "correctness", enabled: true },
      { name: "broken", provider: "mock", model: "vendor/broken", role: "performance", enabled: true },
    ]);
    const res = await runCouncil(["--prompt", "structured please", "--json"], {
      home,
      env: { [KEY_ENV]: KEY_VALUE },
    });
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { results: Array<Record<string, unknown>> };
    expect(parsed.results.length).toBe(2);
    const echo = parsed.results.find((r) => r.name === "echo");
    const broken = parsed.results.find((r) => r.name === "broken");
    expect(echo?.ok).toBe(true);
    expect(echo?.model).toBe("vendor/echo");
    expect(echo?.label).toBe("correctness");
    expect(echo?.tokens).toBe(42);
    expect(typeof echo?.elapsed).toBe("number");
    expect(broken?.ok).toBe(false);
    expect(String(broken?.error)).toContain("HTTP 500");
  });

  test("adapts max_tokens -> max_completion_tokens once from the provider's structured 400", async () => {
    const home = freshHome();
    writeConfig(home, [
      { name: "legacy", provider: "mock", model: "vendor/legacy", role: "generalist", enabled: true },
    ]);
    seen.length = 0;
    const res = await runCouncil(["--prompt", "adapt me"], { home, env: { [KEY_ENV]: KEY_VALUE } });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("adapted ok");
    const attempts = seen.filter((r) => r.model === "vendor/legacy");
    expect(attempts.length).toBe(2);
    expect(attempts[0]?.body.max_tokens).toBe(4096);
    expect(attempts[1]?.body.max_tokens).toBeUndefined();
    expect(attempts[1]?.body.max_completion_tokens).toBe(4096);
  });

  test("forwards per-panelist tuning and passes extra_body through verbatim", async () => {
    const home = freshHome();
    writeConfig(home, [
      {
        name: "tuned",
        provider: "mock",
        model: "vendor/echo",
        role: "performance",
        enabled: true,
        temperature: 0.9,
        top_p: 0.5,
        max_tokens: 128,
        extra_body: { reasoning_effort: "low" },
      },
    ]);
    seen.length = 0;
    const res = await runCouncil(["--prompt", "tuning check"], { home, env: { [KEY_ENV]: KEY_VALUE } });
    expect(res.exitCode).toBe(0);
    const request = seen.find((r) => r.model === "vendor/echo");
    expect(request?.body.temperature).toBe(0.9);
    expect(request?.body.top_p).toBe(0.5);
    expect(request?.body.max_tokens).toBe(128);
    expect(request?.body.reasoning_effort).toBe("low");
  });

  test("rejects extra_body keys that would break the request, without sending it", async () => {
    const home = freshHome();
    writeConfig(home, [
      {
        name: "hijack",
        provider: "mock",
        model: "vendor/echo",
        role: "generalist",
        enabled: true,
        extra_body: { messages: [] },
      },
    ]);
    seen.length = 0;
    const res = await runCouncil(["--prompt", "should not send"], { home, env: { [KEY_ENV]: KEY_VALUE } });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("extra_body may not override 'messages'");
    expect(seen.length).toBe(0);
  });

  test("enforces the per-panelist timeout and reports it as a panelist failure", async () => {
    const home = freshHome();
    writeConfig(home, [
      { name: "hang", provider: "mock", model: "vendor/hang", role: "generalist", enabled: true, timeout: 1 },
    ]);
    const res = await runCouncil(["--prompt", "will time out"], { home, env: { [KEY_ENV]: KEY_VALUE } });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("hang: timed out after 1s");
  });

  test("runs the panel concurrently, not serially", async () => {
    const home = freshHome();
    writeConfig(home, [
      { name: "slow-a", provider: "mock", model: "vendor/slow", role: "correctness", enabled: true },
      { name: "slow-b", provider: "mock", model: "vendor/slow", role: "security", enabled: true },
      { name: "slow-c", provider: "mock", model: "vendor/slow", role: "performance", enabled: true },
    ]);
    inFlight = 0;
    maxInFlight = 0;
    const res = await runCouncil(["--prompt", "overlap check"], { home, env: { [KEY_ENV]: KEY_VALUE } });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--- 3/3 panelists responded ---");
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  test("--check probes every panelist with a tiny token budget", async () => {
    const home = freshHome();
    writeConfig(home, [
      { name: "echo", provider: "mock", model: "vendor/echo", role: "correctness", enabled: true },
      { name: "broken", provider: "mock", model: "vendor/broken", role: "performance", enabled: true },
    ]);
    seen.length = 0;
    const res = await runCouncil(["--check"], { home, env: { [KEY_ENV]: KEY_VALUE } });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("PASS  echo");
    expect(res.stdout).toContain("FAIL  broken");
    expect(res.stdout).toContain("1/2 reachable");
    const probe = seen.find((r) => r.model === "vendor/echo");
    expect(probe?.body.max_tokens).toBe(8);
    const messages = probe?.body.messages as Array<{ content: string }> | undefined;
    expect(messages?.[1]?.content).toBe("Reply with: ok");
  });

  test("--only narrows the panel and rejects unknown names", async () => {
    const home = freshHome();
    writeConfig(home, [
      { name: "echo", provider: "mock", model: "vendor/echo", role: "correctness", enabled: true },
      { name: "reasoner", provider: "mock", model: "vendor/reasoner", role: "security", enabled: true },
    ]);
    const narrowed = await runCouncil(["--prompt", "subset", "--only", "echo"], {
      home,
      env: { [KEY_ENV]: KEY_VALUE },
    });
    expect(narrowed.exitCode).toBe(0);
    expect(narrowed.stdout).toContain("PANELIST: echo");
    expect(narrowed.stdout).not.toContain("PANELIST: reasoner");
    expect(narrowed.stdout).toContain("--- 1/1 panelists responded ---");

    const unknown = await runCouncil(["--prompt", "subset", "--only", "bogus"], {
      home,
      env: { [KEY_ENV]: KEY_VALUE },
    });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Unknown or disabled panelist(s): bogus");
  });

  test("--configure validates the spec and refuses to write a broken panel", async () => {
    const home = freshHome();
    const configPath = writeConfig(home, [
      { name: "echo", provider: "mock", model: "vendor/echo", role: "correctness", enabled: true },
    ]);
    const before = fs.readFileSync(configPath, "utf8");

    const invalid = await runCouncil(["--configure"], {
      home,
      stdin: JSON.stringify({
        panelists: [
          { name: "a", provider: "nope", model: "m", role: "nope2" },
          { name: "a", provider: "mock", model: "m2" },
        ],
      }),
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("unknown provider 'nope'");
    expect(invalid.stderr).toContain("unknown role 'nope2'");
    expect(invalid.stderr).toContain("duplicate panelist name 'a'");
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);

    const valid = await runCouncil(["--configure"], {
      home,
      stdin: JSON.stringify({
        panelists: [{ name: "kimi", provider: "mock", model: "vendor/echo", role: "security", enabled: true }],
      }),
    });
    expect(valid.exitCode).toBe(0);
    expect(valid.stdout).toContain("Wrote 1 panelists");
    const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const panelists = written.panelists as Array<Record<string, unknown>>;
    expect(panelists.length).toBe(1);
    expect(panelists[0]?.name).toBe("kimi");
    // Everything except the panel survives a reconfigure.
    expect(written.timeout_seconds).toBe(30);
    expect((written.providers as Record<string, unknown>).mock).toBeDefined();
  });

  test("--list-models prints each provider's catalog and skips providers without a key", async () => {
    const home = freshHome();
    writeConfig(home, [{ name: "echo", provider: "mock", model: "vendor/echo", role: "correctness", enabled: true }]);
    const res = await runCouncil(["--list-models"], { home, env: { [KEY_ENV]: KEY_VALUE } });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("=== mock");
    expect(res.stdout).toContain("2 models");
    expect(res.stdout.indexOf("vendor/model-a")).toBeLessThan(res.stdout.indexOf("vendor/model-b"));
    expect(res.stdout).toContain(`SKIP: no key (export ${MISSING_KEY_ENV})`);

    const unknown = await runCouncil(["--list-models", "--provider", "nope"], { home, env: { [KEY_ENV]: KEY_VALUE } });
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Unknown provider 'nope'");
  });

  test("reads the prompt from stdin when no flag is given, and refuses an empty prompt", async () => {
    const home = freshHome();
    writeConfig(home, [{ name: "echo", provider: "mock", model: "vendor/echo", role: "correctness", enabled: true }]);
    const piped = await runCouncil([], { home, env: { [KEY_ENV]: KEY_VALUE }, stdin: "stdin prompt body" });
    expect(piped.exitCode).toBe(0);
    expect(piped.stdout).toContain('"user":"stdin prompt body"');

    const empty = await runCouncil([], { home, env: { [KEY_ENV]: KEY_VALUE } });
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain("Empty prompt.");

    const badFlag = await runCouncil(["--nonsense"], { home });
    expect(badFlag.exitCode).toBe(2);
    expect(badFlag.stderr).toContain("Unknown argument: --nonsense");
  });
});
