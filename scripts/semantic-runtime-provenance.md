# Transformers.js runtime provenance

AKM materializes the unmodified Node ESM distribution from the exact external
build input `@huggingface/transformers@4.2.0`. The upstream package is not
vendored under `src`, is not a published dependency, and is not installed in
consumer projects. Only the audited runtime file and Apache-2.0 license are
copied into AKM's published `dist/vendor` directory.

- Source tarball: <https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz>
- npm integrity: `sha512-8BRCoBMH0XsWaEIamuR0LrJGAfftgHAfb2Vrffy0VKlSAE/MnUJ5/h/zTfEP3fDIft+nk7TqB8xXEyABGitBjQ==`
- Tarball SHA-256: `0874b37bbeed0441d37e4445f8a543ab37b41c2ba6bb89f37c5474074b34deee`
- `dist/transformers.node.mjs` SHA-256: `4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d`
- `LICENSE` SHA-256: `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`

The runtime imports `onnxruntime-node`, `onnxruntime-common`, and `sharp`. AKM
owns exact optional dependency versions for those runtime imports. The
`onnxruntime-node` name resolves through an npm alias to the official
platform-neutral `onnxruntime-web@1.24.3` Node/WASM distribution.
