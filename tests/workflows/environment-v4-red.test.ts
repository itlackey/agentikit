// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests-first contract for durable-v4 symbolic workflow environments.
 *
 * Environment ASSET VALUES are the narrow live-value exception to the frozen
 * plan rule. The plan owns qualified refs, exact owner/path identity, exact
 * key names, and secret-token topology; final dispatch may read current values
 * through only those frozen descriptors. It must never persist a value or a
 * value-derived hash.
 *
 * The implementation module is deliberately loaded through a non-literal
 * dynamic-import path. This RED commit therefore remains type-checkable while
 * each contract reports its own missing-implementation failure.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlanV4 } from "../../src/workflows/ir/schema-v4";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

const ENVIRONMENT_V4_MODULE: string = "../../src/workflows/ir/environment-v4";
const sandboxes: SandboxedDir[] = [];

type EnvironmentV4Module = {
  freezeWorkflowEnvironment: (
    refs: readonly string[],
    options: {
      resolveRef: (ref: string) => {
        ref: string;
        bundle: string;
        adapter: string;
        root: string;
        path: string;
      };
      collector?: unknown;
    },
  ) => unknown[];
  materializeFrozenWorkflowEnvironment: (
    descriptors: readonly unknown[],
    options?: {
      readEnvFile?: (descriptor: unknown) => string | Uint8Array;
      readSecret?: (input: { name: string; descriptor: unknown }) => string | Uint8Array | undefined;
      readPassThrough?: (name: string) => string | undefined;
    },
  ) => {
    values: Record<string, string>;
    sensitiveValues: string[];
    audits: unknown[];
  };
};

async function environmentV4(): Promise<EnvironmentV4Module> {
  return (await import(ENVIRONMENT_V4_MODULE)) as EnvironmentV4Module;
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0).reverse()) sandbox.cleanup();
});

function sandbox(prefix: string): string {
  const made = makeSandboxDir(prefix);
  sandboxes.push(made);
  return made.dir;
}

function write(root: string, relative: string, bytes: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function secretToken(name: string): string {
  return `\${secret:${name}}`;
}

function owner(root: string, file: string) {
  const realRoot = fs.realpathSync(root);
  const stat = fs.statSync(realRoot, { bigint: true });
  return {
    bundle: "alpha",
    adapter: "akm",
    requestedRoot: path.resolve(root),
    realRoot,
    rootPhysicalIdentity: stat.ino === 0n ? `path:${realRoot}` : `inode:${stat.dev}:${stat.ino}`,
    requestedPath: path.resolve(file),
    realPath: fs.realpathSync(file),
    relativePath: "env/prod.env",
  };
}

function envRefDescriptor(root: string, file: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: "env-ref",
    ref: "alpha//env/prod",
    owner: owner(root, file),
    keys: ["API_TOKEN", "LOG_LEVEL"],
    secretNames: ["deploy-token"],
    precedence: 0,
    ...overrides,
  };
}

function cwdIdentity(root: string) {
  return {
    requestedRoot: root,
    realRoot: root,
    rootDevice: "7",
    rootInode: "100",
    requestedCwd: root,
    realCwd: root,
    cwdDevice: "7",
    cwdInode: "100",
  };
}

function v4ShellPlan(environment: unknown[]) {
  const root = "/workspace";
  const exec = { command: ["/bin/sh", "-lc", "printf safe"], timeoutMs: 30_000 };
  const directory = cwdIdentity(root);
  const contentHash = sha256(`akm.workflow.shell.v1\0${canonicalJson({ exec, environment, cwdIdentity: directory })}`);
  const workflowBytes = "symbolic environment workflow\n";
  return {
    irVersion: 4,
    title: "symbolic environment",
    sourceReadSet: [
      {
        identity: {
          ref: "alpha//workflows/environment",
          bundle: "alpha",
          adapter: "akm",
          file: "workflows/environment.md",
          hash: sha256(workflowBytes),
        },
        containmentPhysicalIdentity: "inode:7:100",
        physicalIdentity: "inode:7:200",
        size: Buffer.byteLength(workflowBytes),
      },
    ],
    execution: { maxConcurrency: 1 },
    steps: [
      {
        stepId: "run",
        title: "run",
        sequenceIndex: 0,
        root: {
          kind: "unit",
          id: "run",
          instructions: "Run with the frozen symbolic environment.",
          templating: "verbatim",
          frozenTarget: { kind: "shell", contentHash, exec, cwdIdentity: directory },
          environment,
          onError: "fail",
          isolation: "none",
        },
        gate: { kind: "gate", id: "run.gate", stepId: "run", criteria: [], maxLoops: 1, frozenJudge: null },
      },
    ],
  };
}

describe("durable workflow v4 environment schema", () => {
  test("distinguishes literal, pass-through, and env-ref entries without overloading secret", () => {
    const root = sandbox("akm-env-v4-schema");
    const file = write(root, "env/prod.env", `LOG_LEVEL=info\nAPI_TOKEN=${secretToken("deploy-token")}\n`);
    const environment = [
      { kind: "literal", name: "REGION", value: "us-east-1" },
      { kind: "pass-through", name: "CARGO_HOME" },
      envRefDescriptor(root, file),
    ];

    const decoded = decodeWorkflowPlanV4(v4ShellPlan(environment));
    const unit = decoded.steps[0]?.root;
    expect(unit?.kind).toBe("unit");
    if (!unit || unit.kind !== "unit") return;
    expect(unit.environment as readonly unknown[]).toEqual(environment);
    expect(
      (unit.environment as unknown as ReadonlyArray<{ kind: string }>).some((entry) => entry.kind === "secret"),
    ).toBe(false);
  });

  test("requires a qualified ref, exact canonical owner, sorted unique keys/token names, and canonical precedence", () => {
    const root = sandbox("akm-env-v4-strict");
    const file = write(root, "env/prod.env", `LOG_LEVEL=info\nAPI_TOKEN=${secretToken("deploy-token")}\n`);
    const valid = envRefDescriptor(root, file);

    for (const invalid of [
      { ...valid, ref: "env/prod" },
      { ...valid, keys: ["LOG_LEVEL", "API_TOKEN"] },
      { ...valid, keys: ["API_TOKEN", "API_TOKEN"] },
      { ...valid, secretNames: ["z-token", "a-token"] },
      { ...valid, secretNames: ["deploy-token", "deploy-token"] },
      { ...valid, precedence: -1 },
      { ...valid, owner: { ...valid.owner, bundle: "omega" } },
      { ...valid, valueHash: sha256("must never become schema") },
    ]) {
      expect(() => decodeWorkflowPlanV4(v4ShellPlan([invalid]))).toThrow(
        /environment|env-ref|qualified|owner|bundle|key|secret|sort|precedence|unknown|hash/i,
      );
    }
  });

  test("rejects the obsolete secret-kind overload in favor of an explicit pass-through binding", () => {
    const oldOverload = [{ kind: "secret", name: "API_TOKEN", environmentVariable: "DEPLOY_TOKEN" }];
    expect(() => decodeWorkflowPlanV4(v4ShellPlan(oldOverload))).toThrow(/secret|obsolete|pass-through|environment/i);
  });
});

describe("freezeWorkflowEnvironment", () => {
  test("freezes qualified owner/path identity, exact sorted names, token topology, and precedence only", async () => {
    const { freezeWorkflowEnvironment } = await environmentV4();
    const root = sandbox("akm-env-v4-freeze");
    const envValue = "db-password-must-never-enter-plan";
    const file = write(
      root,
      "env/prod.env",
      `LOG_LEVEL=info\nDATABASE_URL=postgres://user:${envValue}@db/prod\nAPI_TOKEN=Bearer ${secretToken("deploy-token")}\n`,
    );

    const descriptors = freezeWorkflowEnvironment(["env/prod"], {
      resolveRef: () => ({ ref: "alpha//env/prod", bundle: "alpha", adapter: "akm", root, path: file }),
    });
    const serialized = JSON.stringify(descriptors);

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      kind: "env-ref",
      ref: "alpha//env/prod",
      owner: {
        bundle: "alpha",
        adapter: "akm",
        requestedRoot: path.resolve(root),
        realRoot: fs.realpathSync(root),
        requestedPath: path.resolve(file),
        realPath: fs.realpathSync(file),
        relativePath: "env/prod.env",
      },
      keys: ["API_TOKEN", "DATABASE_URL", "LOG_LEVEL"],
      secretNames: ["deploy-token"],
      precedence: 0,
    });
    expect(serialized).not.toContain(envValue);
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain(sha256(envValue));
    expect(serialized).not.toContain(sha256(fs.readFileSync(file)));
  });

  test("retains authored ref order as explicit precedence while canonicalizing each descriptor", async () => {
    const { freezeWorkflowEnvironment } = await environmentV4();
    const outer = sandbox("akm-env-v4-precedence");
    const alpha = path.join(outer, "alpha");
    const omega = path.join(outer, "omega");
    fs.mkdirSync(alpha);
    fs.mkdirSync(omega);
    const alphaFile = write(alpha, "env/base.env", "SHARED=alpha\nALPHA_ONLY=yes\n");
    const omegaFile = write(omega, "env/prod.env", "SHARED=omega\nOMEGA_ONLY=yes\n");

    const byInput: Record<string, { ref: string; bundle: string; adapter: string; root: string; path: string }> = {
      "omega//env/prod": { ref: "omega//env/prod", bundle: "omega", adapter: "akm", root: omega, path: omegaFile },
      "alpha//env/base": { ref: "alpha//env/base", bundle: "alpha", adapter: "akm", root: alpha, path: alphaFile },
    };
    const descriptors = freezeWorkflowEnvironment(["omega//env/prod", "alpha//env/base"], {
      resolveRef: (ref) => {
        const resolved = byInput[ref];
        if (!resolved) throw new Error(`fixture has no env resolution for ${ref}`);
        return resolved;
      },
    }) as Array<{ ref: string; keys: string[]; precedence: number }>;

    expect(descriptors.map(({ ref, precedence }) => ({ ref, precedence }))).toEqual([
      { ref: "omega//env/prod", precedence: 0 },
      { ref: "alpha//env/base", precedence: 1 },
    ]);
    expect(descriptors[0]?.keys).toEqual(["OMEGA_ONLY", "SHARED"]);
    expect(descriptors[1]?.keys).toEqual(["ALPHA_ONLY", "SHARED"]);
  });

  test("rejects short authoritative refs, duplicate logical refs, and physical cross-owner aliases", async () => {
    const { freezeWorkflowEnvironment } = await environmentV4();
    const root = sandbox("akm-env-v4-owner-reject");
    const file = write(root, "env/prod.env", "SAFE=yes\n");

    expect(() =>
      freezeWorkflowEnvironment(["env/prod"], {
        resolveRef: () => ({ ref: "env/prod", bundle: "alpha", adapter: "akm", root, path: file }),
      }),
    ).toThrow(/qualified|bundle|canonical|ref/i);
    expect(() =>
      freezeWorkflowEnvironment(["env/prod", "env/prod"], {
        resolveRef: () => ({ ref: "alpha//env/prod", bundle: "alpha", adapter: "akm", root, path: file }),
      }),
    ).toThrow(/duplicate|ref|identity/i);
    expect(() =>
      freezeWorkflowEnvironment(["alpha//env/prod", "omega//env/prod"], {
        resolveRef: (ref) => ({
          ref,
          bundle: ref.startsWith("alpha") ? "alpha" : "omega",
          adapter: "akm",
          root,
          path: file,
        }),
      }),
    ).toThrow(/alias|owner|physical|same|identity/i);
  });
});

describe("materializeFrozenWorkflowEnvironment", () => {
  test("reads current values only through frozen descriptors and returns value-free keys-only audits", async () => {
    const { freezeWorkflowEnvironment, materializeFrozenWorkflowEnvironment } = await environmentV4();
    const root = sandbox("akm-env-v4-materialize");
    const file = write(root, "env/prod.env", `LOG_LEVEL=old\nAPI_TOKEN=${secretToken("deploy-token")}\n`);
    const descriptors = freezeWorkflowEnvironment(["env/prod"], {
      resolveRef: () => ({ ref: "alpha//env/prod", bundle: "alpha", adapter: "akm", root, path: file }),
    });

    const currentToken = "github_pat_current_value_only_01234567890123456789";
    fs.writeFileSync(file, `API_TOKEN=Bearer ${secretToken("deploy-token")}\nLOG_LEVEL=current\n`, { mode: 0o600 });
    const materialized = materializeFrozenWorkflowEnvironment(descriptors, {
      readSecret: ({ name }) => (name === "deploy-token" ? currentToken : undefined),
    });
    const auditJson = JSON.stringify(materialized.audits);

    expect(materialized.values).toEqual({ API_TOKEN: `Bearer ${currentToken}`, LOG_LEVEL: "current" });
    expect(new Set(materialized.sensitiveValues)).toEqual(new Set([`Bearer ${currentToken}`, "current", currentToken]));
    expect(auditJson).toContain("alpha//env/prod");
    expect(auditJson).toContain("API_TOKEN");
    expect(auditJson).toContain("LOG_LEVEL");
    expect(auditJson).toContain("deploy-token");
    expect(auditJson).not.toContain(currentToken);
    expect(auditJson).not.toContain("current");
    expect(JSON.stringify(descriptors)).not.toContain(currentToken);
  });

  test("applies literal, pass-through, and env-ref precedence deterministically without ambient inheritance", async () => {
    const { materializeFrozenWorkflowEnvironment } = await environmentV4();
    const fakeOwner = {
      bundle: "alpha",
      adapter: "akm",
      requestedRoot: "/frozen/root",
      realRoot: "/frozen/root",
      rootPhysicalIdentity: "inode:7:100",
      requestedPath: "/frozen/root/env/prod.env",
      realPath: "/frozen/root/env/prod.env",
      relativePath: "env/prod.env",
    };
    const descriptors = [
      { kind: "literal", name: "SHARED", value: "literal" },
      { kind: "pass-through", name: "SHARED" },
      {
        kind: "env-ref",
        ref: "alpha//env/prod",
        owner: fakeOwner,
        keys: ["ONLY_ENV", "SHARED"],
        secretNames: [],
        precedence: 2,
      },
    ];
    const reads: string[] = [];
    const materialized = materializeFrozenWorkflowEnvironment(descriptors, {
      readPassThrough: (name) => {
        reads.push(name);
        return "pass-through";
      },
      readEnvFile: () => "SHARED=env-ref\nONLY_ENV=present\n",
      readSecret: () => {
        throw new Error("no secret token was frozen");
      },
    });

    expect(reads).toEqual(["SHARED"]);
    expect(materialized.values).toEqual({ ONLY_ENV: "present", SHARED: "env-ref" });
    expect(materialized.values).not.toHaveProperty("HOME");
    expect(materialized.values).not.toHaveProperty("PATH");
  });

  test("fails closed on owner drift, a changed exact key set, or changed secret-token topology", async () => {
    const { freezeWorkflowEnvironment, materializeFrozenWorkflowEnvironment } = await environmentV4();
    const root = sandbox("akm-env-v4-revalidate");
    const file = write(root, "env/prod.env", `LOG_LEVEL=old\nAPI_TOKEN=${secretToken("deploy-token")}\n`);
    const descriptors = freezeWorkflowEnvironment(["env/prod"], {
      resolveRef: () => ({ ref: "alpha//env/prod", bundle: "alpha", adapter: "akm", root, path: file }),
    });

    fs.writeFileSync(file, `LOG_LEVEL=new\nAPI_TOKEN=${secretToken("different-token")}\nEXTRA=injected\n`, {
      mode: 0o600,
    });
    expect(() =>
      materializeFrozenWorkflowEnvironment(descriptors, {
        readSecret: () => "value",
      }),
    ).toThrow(/key|token|topology|descriptor|changed|revalid/i);

    fs.writeFileSync(file, `LOG_LEVEL=new\nAPI_TOKEN=${secretToken("deploy-token")}\n`, { mode: 0o600 });
    const moved = `${root}-moved`;
    fs.renameSync(root, moved);
    fs.symlinkSync(moved, root, "dir");
    expect(() => materializeFrozenWorkflowEnvironment(descriptors, { readSecret: () => "value" })).toThrow(
      /owner|root|physical|symlink|identity|changed/i,
    );
  });

  test("fails atomically on a missing env or secret and never returns a partial value map", async () => {
    const { materializeFrozenWorkflowEnvironment } = await environmentV4();
    const descriptors = [
      { kind: "literal", name: "SAFE", value: "already-seen" },
      {
        kind: "env-ref",
        ref: "alpha//env/prod",
        owner: {
          bundle: "alpha",
          adapter: "akm",
          requestedRoot: "/missing/root",
          realRoot: "/missing/root",
          rootPhysicalIdentity: "inode:7:100",
          requestedPath: "/missing/root/env/prod.env",
          realPath: "/missing/root/env/prod.env",
          relativePath: "env/prod.env",
        },
        keys: ["TOKEN"],
        secretNames: ["missing-token"],
        precedence: 1,
      },
    ];

    let result: unknown;
    expect(() => {
      result = materializeFrozenWorkflowEnvironment(descriptors, {
        readEnvFile: () => `TOKEN=${secretToken("missing-token")}\n`,
        readSecret: () => undefined,
      });
    }).toThrow(/missing|secret|nothing|materializ/i);
    expect(result).toBeUndefined();
  });
});
