# Transformers.js runtime provenance

AKM ships the unmodified Node ESM distribution from
`@huggingface/transformers@4.2.0` as a runtime asset for local semantic search.
It is licensed under Apache-2.0; the upstream `LICENSE` is included beside this
file.

The Git source keeps one public model-vocabulary value as two adjacent string
literals because its upstream spelling matches a hosted secret-scanning
pattern. `scripts/copy-assets.ts` rejoins that one audited value when producing
`dist/`, and the package contract verifies the materialized file against the
upstream SHA-256 below. This source-only spelling change is semantics-neutral;
the published runtime remains byte-for-byte upstream.

- Source tarball: <https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz>
- npm integrity: `sha512-8BRCoBMH0XsWaEIamuR0LrJGAfftgHAfb2Vrffy0VKlSAE/MnUJ5/h/zTfEP3fDIft+nk7TqB8xXEyABGitBjQ==`
- Tarball SHA-256: `0874b37bbeed0441d37e4445f8a543ab37b41c2ba6bb89f37c5474074b34deee`
- `dist/transformers.node.mjs` SHA-256: `4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d`
- `LICENSE` SHA-256: `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`

The distribution has three non-built-in imports: `onnxruntime-node`,
`onnxruntime-common`, and `sharp`. AKM owns exact optional dependency versions
for all three. The `onnxruntime-node` name intentionally resolves through an
npm alias to the official `onnxruntime-web@1.24.3` Node/WASM distribution. This
keeps the upstream Transformers file unmodified, avoids the vulnerable native
ONNX archive installer, and preserves macOS x64 alongside the other supported
platforms. AKM configures that runtime to load its WASM factory and binary only
from the installed package.
