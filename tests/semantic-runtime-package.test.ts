// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { gte, valid } from "semver";
import { materializeVendoredTransformers, sanitizeVendoredTransformers } from "../scripts/vendor-transformers";

const ROOT = path.resolve(import.meta.dir, "..");
const RUNTIME_DIR = path.join(ROOT, "src", "vendor", "huggingface-transformers");
const RUNTIME_FILE = path.join(RUNTIME_DIR, "transformers.node.mjs");
const LICENSE_FILE = path.join(RUNTIME_DIR, "LICENSE");
const PROVENANCE_FILE = path.join(RUNTIME_DIR, "README.akm.md");

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

describe("published local-semantic runtime contract", () => {
  test("owns exact cross-platform runtime dependencies instead of publishing the vulnerable Transformers manifest", () => {
    const pkg = packageJson();
    const optional = pkg.optionalDependencies ?? {};

    for (const section of [pkg.dependencies, pkg.devDependencies, optional]) {
      expect(section).not.toHaveProperty("@huggingface/transformers");
    }

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

  test("stores a push-safe source and materializes the byte-exact upstream Transformers distribution", () => {
    expect(fs.existsSync(RUNTIME_FILE)).toBe(true);
    expect(fs.existsSync(LICENSE_FILE)).toBe(true);
    expect(fs.existsSync(PROVENANCE_FILE)).toBe(true);
    const source = fs.readFileSync(RUNTIME_FILE, "utf8");
    expect(source).toMatch(/\["mistral3", "[A-Za-z0-9_-]{16}" \+ "[A-Za-z0-9_-]{16}"\]/);
    expect(source).not.toMatch(/\["mistral3", "[A-Za-z0-9_-]{32}"\]/);
    const materialized = materializeVendoredTransformers(source);
    expect(createHash("sha256").update(materialized).digest("hex")).toBe(TRANSFORMERS_RUNTIME_SHA256);
    expect(sanitizeVendoredTransformers(materialized)).toBe(source);
    expect(sha256(LICENSE_FILE)).toBe(TRANSFORMERS_LICENSE_SHA256);

    const provenance = fs.readFileSync(PROVENANCE_FILE, "utf8");
    expect(provenance).toContain(`@huggingface/transformers@${TRANSFORMERS_VERSION}`);
    expect(provenance).toContain(TRANSFORMERS_RUNTIME_SHA256);
    expect(provenance).toContain("Apache-2.0");
    expect(provenance).toContain("unmodified");
    expect(provenance).toContain("https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz");
  });

  test("the vendored Node distribution has only the exact external runtime dependencies AKM owns", () => {
    const source = fs.readFileSync(RUNTIME_FILE, "utf8");
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

  test("the development lock no longer retains vulnerable Transformers, native ORT, adm-zip, or sharp ranges", () => {
    const lock = fs.readFileSync(path.join(ROOT, "bun.lock"), "utf8");
    expect(lock).not.toContain('"@huggingface/transformers"');
    expect(lock).not.toContain('"onnxruntime-node": ["onnxruntime-node@');
    expect(lock).not.toContain("adm-zip@");
    expect(lock).not.toContain("sharp@0.34.");
    expect(lock).toContain('"onnxruntime-node": "npm:onnxruntime-web@1.24.3"');
    expect(lock).toContain('"onnxruntime-node": ["onnxruntime-web@1.24.3"');
  });
});
