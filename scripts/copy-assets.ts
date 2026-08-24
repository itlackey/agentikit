#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
// Build-time asset step:
//   1. Mirror src/assets/ → dist/assets/ after tsc.
//      All runtime assets (profiles, task templates, backend templates,
//      prompts, hints, wiki templates) live under src/assets/ with
//      predictable subfolders. Output is always dist/assets/<subfolder>/<file>.
//      To add a new embedded asset: put it in src/assets/, update the
//      importing .ts file's path, done — no glob changes needed.
//   2. Mirror module-local YAML templates next to compiler outputs in `dist/`.
//      The files are imported `with { type: "text" }` from nearby TypeScript
//      modules, so this keeps runtime-compatible paths intact.
//   3. Bundle runtime-specific migration tools into dist/scripts/ so
//      globally-installed npm users can run them without
//      `../src/...` import paths breaking (#469). Bun and Node must never run
//      each other's target because their runtime dependencies differ.
//   4. Materialize audited third-party runtime assets from exact external
//      build inputs into dist/vendor/. They are build inputs, not source code
//      or consumer dependencies.
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import semanticRuntimeProvenance from "./semantic-runtime-provenance.md" with { type: "text" };

const TRANSFORMERS_VERSION = "4.2.0";
const TRANSFORMERS_RUNTIME_SHA256 = "4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d";
const TRANSFORMERS_LICENSE_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

const assetGlob = new Bun.Glob("src/assets/**/*");
for await (const src of assetGlob.scan(".")) {
  const dest = src.replace(/^src\/assets\//, "dist/assets/");
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
}

const transformersRuntime = fileURLToPath(import.meta.resolve("@huggingface/transformers"));
const transformersPackageDir = dirname(dirname(transformersRuntime));
const transformersLicense = `${transformersPackageDir}/LICENSE`;
const transformersManifest = JSON.parse(await Bun.file(`${transformersPackageDir}/package.json`).text()) as {
  license?: string;
  name?: string;
  version?: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifyExternalBuildInput(file: string, expectedSha256: string): Promise<Uint8Array> {
  const bytes = await readFile(file);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`External semantic build input hash mismatch for ${basename(file)}: ${actualSha256}`);
  }
  return bytes;
}

if (
  transformersManifest.name !== "@huggingface/transformers" ||
  transformersManifest.version !== TRANSFORMERS_VERSION ||
  transformersManifest.license !== "Apache-2.0"
) {
  throw new Error(`Unexpected external semantic build input: ${JSON.stringify(transformersManifest)}`);
}

const transformersDest = "dist/vendor/huggingface-transformers";
await mkdir(transformersDest, { recursive: true });
await Bun.write(
  `${transformersDest}/transformers.node.mjs`,
  await verifyExternalBuildInput(transformersRuntime, TRANSFORMERS_RUNTIME_SHA256),
);
await Bun.write(
  `${transformersDest}/LICENSE`,
  await verifyExternalBuildInput(transformersLicense, TRANSFORMERS_LICENSE_SHA256),
);
await Bun.write(`${transformersDest}/README.akm.md`, semanticRuntimeProvenance);

// Module-local YAML templates may be imported `with { type: "text" }` and
// live NEXT TO the module that uses them rather than under src/assets/.
// tsc only emits .ts sources, so mirror them into dist/ at the same relative
// path the compiled importer expects.
const yamlTemplateGlob = new Bun.Glob("src/**/*.{yaml,yml}");
for await (const src of yamlTemplateGlob.scan(".")) {
  if (src.startsWith("src/assets/")) continue; // already mirrored above
  const dest = src.replace(/^src\//, "dist/");
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
}

// 5. Copy the published launchers plus the core CLI's Node-runtime entry
//    wrapper and text-import loader hook into dist/. Both launchers prefer Bun
//    and fall back to Node.
const runtimeFiles = [
  "scripts/node-runtime/akm",
  "scripts/node-runtime/akm-migrate",
  "scripts/node-runtime/cli-node.mjs",
  "scripts/node-runtime/text-import-hook.mjs",
];
for (const src of runtimeFiles) {
  const dest = src.replace(/^scripts\/node-runtime\//, "dist/");
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
  chmodSync(dest, 0o755);
}

const migrationBuilds = [
  { entry: "scripts/akm-migrate.ts", outfile: "dist/scripts/akm-migrate.js", target: "bun" as const },
  { entry: "scripts/akm-migrate.ts", outfile: "dist/scripts/akm-migrate-node.js", target: "node" as const },
];

for (const { entry, outfile, target } of migrationBuilds) {
  await mkdir(dirname(outfile), { recursive: true });
  const result = await Bun.build({
    entrypoints: [entry],
    target,
    outdir: dirname(outfile),
    naming: basename(outfile),
    minify: false,
    // Bun.build preserves the source file's shebang; no banner needed.
  });
  if (!result.success) {
    console.error(`copy-assets: failed to bundle ${entry} for ${target}:`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  // Bundled scripts are invoked via bin entries; make them executable.
  chmodSync(outfile, 0o755);
}
