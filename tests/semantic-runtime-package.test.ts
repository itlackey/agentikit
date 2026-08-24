// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gte, valid } from "semver";

const ROOT = path.resolve(import.meta.dir, "..");
const REMOVED_VENDOR_DIR = path.join(ROOT, "src", "vendor", "huggingface-transformers");

const TRANSFORMERS_VERSION = "4.2.0";
const TRANSFORMERS_RUNTIME_SHA256 = "4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d";
const TRANSFORMERS_LICENSE_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
const ORT_WASM_SHA256 = "be0e129949062ad50290ef94683fac8be5bb6156f709e030b7a5f1661a2f6c17";
const ORT_WEB_ALIAS = "npm:onnxruntime-web@1.24.3";
const ORT_COMMON_VERSION = "1.24.3";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function packageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as PackageJson;
}

function upstreamRuntime(): { runtime: string; license: string; manifest: string } {
  const runtime = fileURLToPath(import.meta.resolve("@huggingface/transformers"));
  const packageRoot = path.resolve(path.dirname(runtime), "..");
  return {
    runtime,
    license: path.join(packageRoot, "LICENSE"),
    manifest: path.join(packageRoot, "package.json"),
  };
}

describe("published local-semantic runtime contract", () => {
  test("uses Transformers only as an exact external build input and owns published runtime dependencies", () => {
    const pkg = packageJson();
    const optional = pkg.optionalDependencies ?? {};

    for (const section of [pkg.dependencies, optional]) {
      expect(section).not.toHaveProperty("@huggingface/transformers");
    }
    expect(pkg.devDependencies?.["@huggingface/transformers"]).toBe(TRANSFORMERS_VERSION);

    // The unmodified Transformers Node distribution imports the bare name
    // `onnxruntime-node`. Resolve that name to the official, platform-neutral
    // WebAssembly package so macOS x64 remains supported without adm-zip or a
    // native postinstall downloader.
    expect(optional["onnxruntime-node"]).toBe(ORT_WEB_ALIAS);
    expect(optional["onnxruntime-common"]).toBe(ORT_COMMON_VERSION);
    const sharpVersion = optional.sharp;
    expect(sharpVersion).toBeDefined();
    if (!sharpVersion) throw new Error("sharp must be an exact optional dependency");
    expect(valid(sharpVersion)).toBe(sharpVersion);
    expect(gte(sharpVersion, "0.35.0")).toBe(true);
  });

  test("keeps upstream Transformers outside src and verifies the exact external package bytes", () => {
    expect(fs.existsSync(REMOVED_VENDOR_DIR)).toBe(false);
    const upstream = upstreamRuntime();
    expect(path.basename(upstream.runtime)).toBe("transformers.node.mjs");
    expect(sha256(upstream.runtime)).toBe(TRANSFORMERS_RUNTIME_SHA256);
    expect(sha256(upstream.license)).toBe(TRANSFORMERS_LICENSE_SHA256);
    expect(JSON.parse(fs.readFileSync(upstream.manifest, "utf8"))).toMatchObject({
      name: "@huggingface/transformers",
      version: TRANSFORMERS_VERSION,
      license: "Apache-2.0",
    });
  });

  test("the external Node build input has only the exact published runtime dependencies AKM owns", () => {
    const source = fs.readFileSync(upstreamRuntime().runtime, "utf8");
    const imports = [...source.matchAll(/^import\s+.+?\s+from\s+["']([^"']+)["'];?$/gm)].map(
      (match) => match[1] as string,
    );
    const externalPackages = [...new Set(imports.filter((specifier) => !isBuiltin(specifier)))].sort();

    expect(externalPackages).toEqual(["onnxruntime-common", "onnxruntime-node", "sharp"]);
    expect(Object.keys(packageJson().optionalDependencies ?? {}).sort()).toEqual([
      "better-sqlite3",
      "onnxruntime-common",
      "onnxruntime-node",
      "sharp",
      "sqlite-vec",
    ]);
  });

  test("the aliased ONNX runtime is platform-neutral and sharp retains its published platform matrix", () => {
    const ortDir = path.join(ROOT, "node_modules", "onnxruntime-node");
    const ort = JSON.parse(fs.readFileSync(path.join(ortDir, "package.json"), "utf8")) as {
      cpu?: string[];
      name?: string;
      os?: string[];
      scripts?: { postinstall?: string };
      version?: string;
    };
    expect(ort).toMatchObject({ name: "onnxruntime-web", version: ORT_COMMON_VERSION });
    expect(ort.os).toBeUndefined();
    expect(ort.cpu).toBeUndefined();
    expect(ort.scripts?.postinstall).toBeUndefined();
    expect(sha256(path.join(ortDir, "dist", "ort-wasm-simd-threaded.wasm"))).toBe(ORT_WASM_SHA256);

    const sharp = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "sharp", "package.json"), "utf8")) as {
      optionalDependencies?: Record<string, string>;
    };
    expect(Object.keys(sharp.optionalDependencies ?? {})).toEqual(
      expect.arrayContaining([
        "@img/sharp-darwin-arm64",
        "@img/sharp-darwin-x64",
        "@img/sharp-linux-arm64",
        "@img/sharp-linux-x64",
        "@img/sharp-win32-arm64",
        "@img/sharp-win32-x64",
      ]),
    );
  });

  test("the lock pins the external build input while consumer runtime dependencies remain controlled", () => {
    const lock = fs.readFileSync(path.join(ROOT, "bun.lock"), "utf8");
    expect(lock).toContain(`"@huggingface/transformers": "${TRANSFORMERS_VERSION}"`);
    expect(lock).toContain(`"@huggingface/transformers": ["@huggingface/transformers@${TRANSFORMERS_VERSION}"`);
    expect(lock).not.toContain('"onnxruntime-node": ["onnxruntime-node@');
    expect(lock).toContain('"onnxruntime-node": "npm:onnxruntime-web@1.24.3"');
    expect(lock).toContain('"onnxruntime-node": ["onnxruntime-web@1.24.3"');
  });
});
