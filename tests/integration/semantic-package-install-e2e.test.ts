// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Gated consumer-install proof for #798.
 *
 * This test intentionally performs normal npm lifecycle installs. It is only
 * enabled by the exact-SHA semantic gate; ordinary unit/integration runs skip
 * it. Release evidence must install the packed package normally and load the
 * exact packaged ONNX WebAssembly module through real inference. The runtime
 * deliberately has no native postinstall or archive downloader.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { gte } from "semver";
import { DEFAULT_LOCAL_MODEL, LocalEmbedder } from "../../src/llm/embedders/local";
import { withEnv } from "../_helpers/sandbox";

const ENABLED = process.env.AKM_SEMANTIC_TESTS === "1";
const ROOT = path.resolve(import.meta.dir, "../..");
const ORT_VERSION = "1.24.3";
const TRANSFORMERS_RUNTIME_SHA256 = "4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d";
const ORT_WASM_SHA256 = "be0e129949062ad50290ef94683fac8be5bb6156f709e030b7a5f1661a2f6c17";
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const RUNTIME_PACKAGE_MANIFEST_NAMES = {
  "onnxruntime-common": "onnxruntime-common",
  "onnxruntime-node": "onnxruntime-web",
  sharp: "sharp",
} as const;
type RuntimePackageName = keyof typeof RUNTIME_PACKAGE_MANIFEST_NAMES;

interface CommandResult {
  status: number;
  stderr: string;
  stdout: string;
}

interface NpmTree {
  dependencies?: Record<string, NpmTree>;
  name?: string;
  version?: string;
}

interface AuditReport {
  metadata?: {
    vulnerabilities?: Record<string, number>;
  };
  vulnerabilities?: Record<string, unknown>;
}

interface PhysicalInventory {
  paths: Map<string, Set<string>>;
  versions: Map<string, Set<string>>;
}

const state: {
  bunDir?: string;
  bunLauncher?: string;
  bunPackageDir?: string;
  externalDir?: string;
  externalPackageDir?: string;
  externalLauncher?: string;
  globalPrefix?: string;
  globalPackageDir?: string;
  globalLauncher?: string;
  installLogs?: string[];
  npmCache?: string;
  omittedDir?: string;
  omittedLauncher?: string;
  root?: string;
} = {};

function run(
  command: string,
  args: string[],
  options: { allowFailure?: boolean; cwd: string; env?: NodeJS.ProcessEnv },
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
  });
  const output = {
    status: result.status ?? -1,
    stderr: String(result.stderr ?? result.error?.message ?? ""),
    stdout: String(result.stdout ?? ""),
  };
  if (!options.allowFailure && output.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${output.status})\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
    );
  }
  return output;
}

function parsePackFilename(result: CommandResult, packedDir: string): string {
  if (result.stdout.trim()) {
    const payload = JSON.parse(result.stdout) as Array<{ filename?: unknown }>;
    const filename = payload[0]?.filename;
    if (payload.length !== 1 || typeof filename !== "string" || path.basename(filename) !== filename) {
      throw new Error(`npm pack returned an invalid payload: ${result.stdout}`);
    }
    return filename;
  }

  // Bun's node:child_process compatibility can discard npm's large `--json`
  // stdout while preserving its successful exit. The packed artifact remains
  // the authority: require exactly one basename-safe tarball in the private
  // destination instead of walking to another directory.
  const tarballs = fs.readdirSync(packedDir).filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1 || path.basename(tarballs[0] as string) !== tarballs[0]) {
    throw new Error(`npm pack returned no JSON and produced ${tarballs.length} tarballs: ${result.stderr}`);
  }
  return tarballs[0] as string;
}

function collectVersions(tree: NpmTree, out = new Map<string, Set<string>>()): Map<string, Set<string>> {
  for (const [name, dependency] of Object.entries(tree.dependencies ?? {})) {
    if (dependency.version) {
      const versions = out.get(name) ?? new Set<string>();
      versions.add(dependency.version);
      out.set(name, versions);
    }
    collectVersions(dependency, out);
  }
  return out;
}

function parseTree(command: string, args: string[], cwd: string): Map<string, Set<string>> {
  const result = run(command, args, { cwd });
  return collectVersions(JSON.parse(result.stdout) as NpmTree);
}

function expectOnePhysicalInstance(command: string, args: string[], cwd: string): void {
  const result = run(command, args, { cwd });
  const paths = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  expect(paths).toHaveLength(1);
}

function expectSafeInventory(inventory: Map<string, Set<string>>): void {
  expect(inventory.has("@huggingface/transformers")).toBe(false);
  expect([...new Set(inventory.get("onnxruntime-node"))]).toEqual([ORT_VERSION]);
  expect([...new Set(inventory.get("onnxruntime-common"))]).toEqual([ORT_VERSION]);
  expect(inventory.has("adm-zip")).toBe(false);
  expect([...new Set(inventory.get("sharp"))]).toEqual(["0.35.3"]);
  for (const version of inventory.get("sharp") ?? []) expect(gte(version, "0.35.0")).toBe(true);
}

function physicalInventory(rootNodeModules: string): PhysicalInventory {
  const paths = new Map<string, Set<string>>();
  const versions = new Map<string, Set<string>>();
  const visitedNodeModules = new Set<string>();

  const visitPackage = (slotName: string, packageDir: string): void => {
    let realPackageDir: string;
    let metadata: { name?: unknown; version?: unknown };
    try {
      realPackageDir = fs.realpathSync(packageDir);
      metadata = JSON.parse(fs.readFileSync(path.join(realPackageDir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
    } catch {
      return;
    }
    const identities = new Set([slotName]);
    if (typeof metadata.name === "string") identities.add(metadata.name);
    for (const identity of identities) {
      const packagePaths = paths.get(identity) ?? new Set<string>();
      packagePaths.add(realPackageDir);
      paths.set(identity, packagePaths);
      if (typeof metadata.version === "string") {
        const packageVersions = versions.get(identity) ?? new Set<string>();
        packageVersions.add(metadata.version);
        versions.set(identity, packageVersions);
      }
    }
    visitNodeModules(path.join(realPackageDir, "node_modules"));
  };

  const visitNodeModules = (nodeModules: string): void => {
    let realNodeModules: string;
    let entries: fs.Dirent[];
    try {
      realNodeModules = fs.realpathSync(nodeModules);
      if (visitedNodeModules.has(realNodeModules)) return;
      visitedNodeModules.add(realNodeModules);
      entries = fs.readdirSync(realNodeModules, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".bin") continue;
      const entryPath = path.join(realNodeModules, entry.name);
      if (entry.name.startsWith("@")) {
        let scopedEntries: fs.Dirent[];
        try {
          scopedEntries = fs.readdirSync(entryPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const scopedEntry of scopedEntries) {
          visitPackage(`${entry.name}/${scopedEntry.name}`, path.join(entryPath, scopedEntry.name));
        }
      } else {
        visitPackage(entry.name, entryPath);
      }
    }
  };

  visitNodeModules(rootNodeModules);
  return { paths, versions };
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function platformLauncher(dir: string): string {
  return process.platform === "win32" ? path.join(dir, "akm.cmd") : path.join(dir, "bin", "akm");
}

function globalPackageDir(prefix: string): string {
  return process.platform === "win32"
    ? path.join(prefix, "node_modules", "akm-cli")
    : path.join(prefix, "lib", "node_modules", "akm-cli");
}

function resolveConsumerRuntimePackage(packageDir: string, packageName: RuntimePackageName): string {
  const packageManifest = path.join(fs.realpathSync(packageDir), "package.json");
  const resolvedEntry = fs.realpathSync(createRequire(packageManifest).resolve(packageName));
  const expectedManifestName = RUNTIME_PACKAGE_MANIFEST_NAMES[packageName];
  let candidate = path.dirname(resolvedEntry);
  while (true) {
    const manifestPath = path.join(candidate, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: unknown };
      if (manifest.name === expectedManifestName) return fs.realpathSync(candidate);
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(
    `Resolved ${packageName} from ${packageManifest}, but no ${expectedManifestName} package root contains ${resolvedEntry}`,
  );
}

function seedConsumerManifest(directory: string, name: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name, private: true, version: "1.0.0" })}\n`,
  );
}

function localNpmInstallArgs(prefix: string, tarball: string, omitOptional = false): string[] {
  return [
    "install",
    "--prefix",
    prefix,
    ...(omitOptional ? ["--omit=optional"] : []),
    "--foreground-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  ];
}

function localLauncher(directory: string): string {
  return path.join(directory, "node_modules", ".bin", process.platform === "win32" ? "akm.cmd" : "akm");
}

function expectPathInside(candidate: string, root: string): void {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
  expect(relative).not.toBe("");
  expect(relative).not.toBe("..");
  expect(relative.startsWith(`..${path.sep}`)).toBe(false);
  expect(path.isAbsolute(relative)).toBe(false);
}

function isolatedPath(root: string, includeBun: boolean): string {
  const binDir = path.join(root, includeBun ? "bun-path" : "node-path");
  fs.mkdirSync(binDir, { recursive: true });
  const node = Bun.which("node");
  if (!node) throw new Error("The semantic package gate requires Node.js");
  fs.symlinkSync(node, path.join(binDir, process.platform === "win32" ? "node.exe" : "node"));
  const git = Bun.which("git");
  if (!git) throw new Error("The semantic package gate requires git");
  fs.symlinkSync(git, path.join(binDir, process.platform === "win32" ? "git.exe" : "git"));
  if (process.platform !== "win32") {
    const sh = Bun.which("sh");
    if (!sh) throw new Error("The semantic package gate requires a POSIX shell");
    fs.symlinkSync(sh, path.join(binDir, "sh"));
  }
  if (includeBun) {
    const bun = Bun.which("bun");
    if (!bun) throw new Error("The semantic package gate requires Bun");
    fs.symlinkSync(bun, path.join(binDir, process.platform === "win32" ? "bun.exe" : "bun"));
  }
  return binDir;
}

function seedRuntime(root: string): NodeJS.ProcessEnv {
  const stash = path.join(root, "stash");
  const config = path.join(root, "config");
  fs.mkdirSync(path.join(stash, "knowledge"), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(
    path.join(stash, "knowledge", "deploy.md"),
    "---\ndescription: Deploy applications to production safely\n---\n# Deploy\n\nRoll out applications to production with health checks and safe rollback.\n",
  );
  fs.writeFileSync(
    path.join(stash, "knowledge", "gardening.md"),
    "---\ndescription: Grow vegetables in a garden\n---\n# Gardening\n\nWater seedlings, prune tomatoes, and harvest vegetables.\n",
  );
  fs.writeFileSync(
    path.join(config, "config.json"),
    `${JSON.stringify({
      bundles: { stash: { path: stash, writable: true } },
      configVersion: "0.9.0",
      defaultBundle: "stash",
      semanticSearchMode: "auto",
    })}\n`,
  );
  return {
    ...process.env,
    AKM_BUNDLE_DIR: stash,
    AKM_CACHE_DIR: path.join(root, "cache"),
    AKM_CONFIG_DIR: config,
    AKM_DATA_DIR: path.join(root, "data"),
    AKM_STATE_DIR: path.join(root, "state"),
    HF_HOME: process.env.HF_HOME ?? path.join(state.root as string, "hf-cache"),
    HF_HUB_OFFLINE: "1",
    NODE_USE_ENV_PROXY: "1",
    // A successful round-trip with all HTTP(S) traffic sent to a closed local
    // port proves the runtime module and WASM bytes came from the installed
    // package, not Transformers' CDN fallback. The model itself is restored
    // into HF_HOME by the trusted semantic gate.
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    NO_COLOR: "1",
  };
}

function proveRealSemanticRoundTrip(launcher: string, runtimeName: "Bun" | "Node", pathValue: string): void {
  const runtimeRoot = path.join(state.root as string, `round-trip-${runtimeName.toLowerCase()}`);
  const env = { ...seedRuntime(runtimeRoot), PATH: pathValue };
  const indexed = run(launcher, ["index", "--full", "--format=json"], { cwd: runtimeRoot, env });
  const indexResult = JSON.parse(indexed.stdout) as {
    verification?: { embeddingCount?: number; ok?: boolean; semanticStatus?: string };
  };
  expect(indexResult.verification?.ok, `${runtimeName} index output: ${indexed.stdout}`).toBe(true);
  expect(["ready-js", "ready-vec"]).toContain(indexResult.verification?.semanticStatus ?? "");
  expect(indexResult.verification?.embeddingCount).toBe(2);

  // No query token occurs in either fixture, so a result requires vector
  // retrieval; lexical FTS alone has an empty candidate set.
  const searched = run(launcher, ["search", "shipping software to live servers", "--format=json", "--limit", "10"], {
    cwd: runtimeRoot,
    env,
  });
  const searchResult = JSON.parse(searched.stdout) as {
    hits?: Array<{ name?: string }>;
  };
  expect(
    searchResult.hits?.some((hit) => hit.name === "deploy"),
    `${runtimeName} search: ${searched.stdout}`,
  ).toBe(true);
}

beforeAll(async () => {
  if (!ENABLED) return;
  if (process.env.npm_config_ignore_scripts === "true" || process.env.NPM_CONFIG_IGNORE_SCRIPTS === "true") {
    throw new Error("The gated packed-consumer proof refuses to run with npm lifecycle scripts disabled");
  }
  const npm = Bun.which("npm");
  const bun = Bun.which("bun");
  const node = Bun.which("node");
  if (!npm || !bun || !node) throw new Error("The semantic package gate requires npm, Bun, and Node.js 24");
  const nodeVersion = run(node, ["--version"], { cwd: ROOT }).stdout.trim();
  if (!/^v24\./.test(nodeVersion)) {
    throw new Error(`The semantic package gate requires pinned Node.js 24; found ${nodeVersion || "unknown"}`);
  }

  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-semantic-package-gate-"));
  const modelCache = process.env.HF_HOME ?? path.join(state.root, "hf-cache");
  // Make the model cache complete before child launchers are forced offline.
  // This separates the permitted HuggingFace model download from the stronger
  // assertion that ONNX JS/WASM runtime code always loads from package files.
  await withEnv({ HF_HOME: modelCache }, async () => {
    await new LocalEmbedder().getPipeline(DEFAULT_LOCAL_MODEL);
  });
  const packedDir = path.join(state.root, "packed");
  state.npmCache = process.env.npm_config_cache ?? path.join(state.root, "npm-cache");
  const packageManagerEnv = {
    ...process.env,
    npm_config_cache: state.npmCache,
  };
  fs.mkdirSync(packedDir, { recursive: true });
  run(bun, ["run", "build"], { cwd: ROOT });
  const packed = run(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", packedDir], {
    cwd: ROOT,
    env: packageManagerEnv,
  });
  const tarball = path.join(packedDir, parsePackFilename(packed, packedDir));

  state.externalDir = path.join(state.root, "external-consumer");
  state.bunDir = path.join(state.root, "bun-consumer");
  const globalPrefix = path.join(state.root, "global-prefix");
  state.omittedDir = path.join(state.root, "optional-dependencies-omitted");
  state.globalPrefix = globalPrefix;
  seedConsumerManifest(state.externalDir, "akm-semantic-npm-consumer");
  seedConsumerManifest(state.bunDir, "akm-semantic-bun-consumer");
  fs.mkdirSync(globalPrefix, { recursive: true });
  seedConsumerManifest(state.omittedDir, "akm-semantic-omitted-consumer");
  const externalInstall = run(npm, localNpmInstallArgs(state.externalDir, tarball), {
    cwd: state.root,
    env: packageManagerEnv,
  });
  const globalInstall = run(
    npm,
    ["install", "--global", "--foreground-scripts", "--no-audit", "--no-fund", "--prefix", globalPrefix, tarball],
    { cwd: state.root, env: packageManagerEnv },
  );
  const bunInstall = run(
    bun,
    [
      "add",
      "--trust",
      "--exact",
      "--cache-dir",
      process.env.BUN_INSTALL_CACHE_DIR ?? path.join(state.root, "bun-cache"),
      tarball,
    ],
    { cwd: state.bunDir },
  );
  run(npm, localNpmInstallArgs(state.omittedDir, tarball, true), {
    cwd: state.root,
    env: packageManagerEnv,
  });
  state.installLogs = [
    externalInstall.stdout + externalInstall.stderr,
    globalInstall.stdout + globalInstall.stderr,
    bunInstall.stdout + bunInstall.stderr,
  ];
  state.externalPackageDir = path.join(state.externalDir, "node_modules", "akm-cli");
  state.externalLauncher = localLauncher(state.externalDir);
  state.bunPackageDir = path.join(state.bunDir, "node_modules", "akm-cli");
  state.bunLauncher = localLauncher(state.bunDir);
  state.globalPackageDir = globalPackageDir(globalPrefix);
  state.globalLauncher = platformLauncher(globalPrefix);
  state.omittedLauncher = localLauncher(state.omittedDir);
}, 15 * 60_000);

afterAll(() => {
  if (state.root) fs.rmSync(state.root, { recursive: true, force: true });
});

describe("semantic package consumer command construction", () => {
  test("local npm installs always name their isolated prefix", () => {
    expect(localNpmInstallArgs("/isolated/consumer", "/packed/akm.tgz")).toEqual([
      "install",
      "--prefix",
      "/isolated/consumer",
      "--foreground-scripts",
      "--no-audit",
      "--no-fund",
      "/packed/akm.tgz",
    ]);
    expect(localNpmInstallArgs("/isolated/omitted", "/packed/akm.tgz", true)).toContain("--omit=optional");
  });

  test("physical inventory records aliases and canonical package identities", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "akm-semantic-inventory-"));
    try {
      const packageDir = path.join(fixture, "node_modules", "disguised-runtime");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        `${JSON.stringify({ name: "@huggingface/transformers", version: "4.2.0" })}\n`,
      );
      const inventory = physicalInventory(path.join(fixture, "node_modules"));
      expect([...new Set(inventory.versions.get("disguised-runtime"))]).toEqual(["4.2.0"]);
      expect([...new Set(inventory.versions.get("@huggingface/transformers"))]).toEqual(["4.2.0"]);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("runtime packages resolve from the installed AKM manifest when npm hoists them", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "akm-semantic-resolution-"));
    try {
      const packageDir = path.join(fixture, "node_modules", "akm-cli");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "akm-cli" })}\n`);
      for (const packageName of Object.keys(RUNTIME_PACKAGE_MANIFEST_NAMES) as RuntimePackageName[]) {
        const runtimeDir = path.join(fixture, "node_modules", packageName);
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.writeFileSync(
          path.join(runtimeDir, "package.json"),
          `${JSON.stringify({
            name: RUNTIME_PACKAGE_MANIFEST_NAMES[packageName],
            main: "index.js",
            version: packageName === "sharp" ? "0.35.3" : ORT_VERSION,
          })}\n`,
        );
        fs.writeFileSync(path.join(runtimeDir, "index.js"), "module.exports = {};\n");

        expect(fs.realpathSync(resolveConsumerRuntimePackage(packageDir, packageName))).toBe(
          fs.realpathSync(runtimeDir),
        );
      }
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("offline child processes explicitly enable Node's environment proxy support", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "akm-semantic-offline-env-"));
    try {
      await withEnv({ HF_HOME: path.join(fixture, "hf-cache") }, () => {
        expect(seedRuntime(fixture).NODE_USE_ENV_PROXY).toBe("1");
      });
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!ENABLED)("packed semantic runtime consumer acceptance", () => {
  test("local consumer installs are rooted in their declared prefixes", () => {
    const npm = Bun.which("npm") as string;
    for (const consumerDir of [state.externalDir, state.omittedDir] as string[]) {
      const prefix = run(npm, ["prefix"], { cwd: consumerDir }).stdout.trim();
      expect(prefix).toBe(consumerDir);
      expectPathInside(localLauncher(consumerDir), consumerDir);
    }
    expectPathInside(state.globalLauncher as string, state.globalPrefix as string);
  });

  test("a rooted Bun package-manager consumer contains the audited runtime", () => {
    expect(state.bunDir).toBeString();
    expect(state.bunPackageDir).toBeString();
    expect(state.bunLauncher).toBeString();
    expectPathInside(state.bunLauncher as string, state.bunDir as string);
  });

  test("normal npm/global and Bun installs resolve one safe, platform-neutral dependency tree", () => {
    const npm = Bun.which("npm") as string;
    expect(state.installLogs).toHaveLength(3);

    const externalInventory = parseTree(npm, ["ls", "--all", "--json"], state.externalDir as string);
    const globalInventory = parseTree(
      npm,
      ["ls", "--global", "--all", "--json", "--prefix", state.globalPrefix as string],
      state.root as string,
    );
    const bunInventory = physicalInventory(path.join(state.bunDir as string, "node_modules"));
    expectSafeInventory(externalInventory);
    expectSafeInventory(globalInventory);
    expectSafeInventory(bunInventory.versions);
    for (const dependency of ["onnxruntime-common", "onnxruntime-node", "sharp"]) {
      expectOnePhysicalInstance(npm, ["ls", "--parseable", "--all", dependency], state.externalDir as string);
      expectOnePhysicalInstance(
        npm,
        ["ls", "--global", "--prefix", state.globalPrefix as string, "--parseable", "--all", dependency],
        state.root as string,
      );
      expect(bunInventory.paths.get(dependency)?.size).toBe(1);
    }

    const consumers = [
      { packageDir: state.externalPackageDir as string, prefix: state.externalDir as string },
      { packageDir: state.globalPackageDir as string, prefix: state.globalPrefix as string },
      { packageDir: state.bunPackageDir as string, prefix: state.bunDir as string },
    ];
    for (const { packageDir, prefix } of consumers) {
      const runtime = path.join(packageDir, "dist", "vendor", "huggingface-transformers", "transformers.node.mjs");
      expect(sha256(runtime)).toBe(TRANSFORMERS_RUNTIME_SHA256);
      expect(fs.existsSync(path.join(packageDir, "dist", "vendor", "huggingface-transformers", "LICENSE"))).toBe(true);
      const runtimePackageDirs = Object.fromEntries(
        (Object.keys(RUNTIME_PACKAGE_MANIFEST_NAMES) as RuntimePackageName[]).map((packageName) => [
          packageName,
          resolveConsumerRuntimePackage(packageDir, packageName),
        ]),
      ) as Record<RuntimePackageName, string>;
      for (const packageName of Object.keys(RUNTIME_PACKAGE_MANIFEST_NAMES) as RuntimePackageName[]) {
        expectPathInside(runtimePackageDirs[packageName], prefix);
      }
      const ortDir = runtimePackageDirs["onnxruntime-node"];
      expect(fs.existsSync(path.join(ortDir, "package.json"))).toBe(true);
      const ortPackage = JSON.parse(fs.readFileSync(path.join(ortDir, "package.json"), "utf8")) as {
        name?: string;
        os?: string[];
        scripts?: { postinstall?: string };
        version?: string;
      };
      expect(ortPackage).toMatchObject({ name: "onnxruntime-web", version: ORT_VERSION });
      expect(ortPackage.os).toBeUndefined();
      expect(ortPackage.scripts?.postinstall).toBeUndefined();
      const wasm = path.join(ortDir, "dist", "ort-wasm-simd-threaded.wasm");
      expect(sha256(wasm)).toBe(ORT_WASM_SHA256);
      expect(fs.existsSync(path.join(ortDir, "dist", "ort-wasm-simd-threaded.mjs"))).toBe(true);
      expect(fs.existsSync(path.join(ortDir, "bin"))).toBe(false);
    }

    const auditResult = run(npm, ["audit", "--omit=dev", "--json"], {
      allowFailure: true,
      cwd: state.externalDir as string,
    });
    const audit = JSON.parse(auditResult.stdout) as AuditReport;
    for (const name of ["@huggingface/transformers", "adm-zip", "onnxruntime-node", "onnxruntime-web", "sharp"]) {
      expect(audit.vulnerabilities).not.toHaveProperty(name);
    }
    expect(audit.metadata?.vulnerabilities?.high ?? 0).toBe(0);
    expect(audit.metadata?.vulnerabilities?.critical ?? 0).toBe(0);
    expect(auditResult.status).toBe(0);
  });

  test(
    "the installed launcher executes genuine local semantic inference under Node and Bun",
    () => {
      const nodePath = isolatedPath(state.root as string, false);
      const bunPath = isolatedPath(state.root as string, true);
      proveRealSemanticRoundTrip(state.externalLauncher as string, "Node", nodePath);
      proveRealSemanticRoundTrip(state.bunLauncher as string, "Bun", bunPath);
    },
    15 * 60_000,
  );

  test("omitting optional dependencies keeps the Bun CLI usable and reports semantic search as blocked", () => {
    const npm = Bun.which("npm") as string;
    const inventory = parseTree(npm, ["ls", "--all", "--json"], state.omittedDir as string);
    for (const dependency of ["onnxruntime-common", "onnxruntime-node", "sharp"]) {
      expect(inventory.has(dependency)).toBe(false);
    }

    const runtimeRoot = path.join(state.root as string, "round-trip-optionals-omitted");
    const env = { ...seedRuntime(runtimeRoot), PATH: isolatedPath(path.join(state.root as string, "omit"), true) };
    const indexed = run(state.omittedLauncher as string, ["index", "--full", "--format=json"], {
      cwd: runtimeRoot,
      env,
    });
    const result = JSON.parse(indexed.stdout) as {
      verification?: { embeddingCount?: number; message?: string; ok?: boolean; semanticStatus?: string };
    };
    expect(result.verification).toMatchObject({ embeddingCount: 0, ok: false, semanticStatus: "blocked" });
    expect(result.verification?.message).toContain("local embedding runtime");
    expect(result.verification?.message).not.toContain("prebuilt akm binary");

    const nodeRoot = path.join(state.root as string, "round-trip-optionals-omitted-node");
    const nodeEnv = {
      ...seedRuntime(nodeRoot),
      PATH: isolatedPath(path.join(state.root as string, "omit-node"), false),
    };
    const nodeResult = run(state.omittedLauncher as string, ["index", "--full", "--format=json"], {
      allowFailure: true,
      cwd: nodeRoot,
      env: nodeEnv,
    });
    expect(nodeResult.status).toBe(70);
    expect(nodeResult.stderr).toContain("better-sqlite3");
    expect(nodeResult.stderr).toContain("run akm under Bun");
  });
});
