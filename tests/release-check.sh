#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CANDIDATE_DIR="$(mktemp -d)"
PACKAGE_CANDIDATE=""
trap 'rm -rf "$CANDIDATE_DIR"' EXIT

SKIP_DOCKER=false

for arg in "$@"; do
	case "$arg" in
	--skip-docker)
		SKIP_DOCKER=true
		;;
	--help | -h)
		echo "Usage: $0 [--skip-docker]"
		exit 0
		;;
	*)
		echo "Unknown argument: $arg" >&2
		exit 1
		;;
	esac
done

run_step() {
	local label="$1"
	shift
	echo "=== $label ==="
	"$@"
	echo ""
}

pack_package_candidate() {
	npm pack --ignore-scripts --pack-destination "$CANDIDATE_DIR"
	shopt -s nullglob
	local tarballs=("$CANDIDATE_DIR"/*.tgz)
	if [ "${#tarballs[@]}" -ne 1 ]; then
		echo "Expected one package candidate, found ${#tarballs[@]}" >&2
		return 1
	fi
	PACKAGE_CANDIDATE="${tarballs[0]}"
}

validate_workflow_syntax() {
	if command -v actionlint >/dev/null 2>&1; then
		actionlint "$PROJECT_ROOT"/.github/workflows/*.yml
		return
	fi

	local version="1.7.12"
	local platform arch archive checksum
	case "$(uname -s):$(uname -m)" in
	Linux:x86_64)
		platform="linux"
		arch="amd64"
		checksum="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
		;;
	Linux:aarch64 | Linux:arm64)
		platform="linux"
		arch="arm64"
		checksum="325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6"
		;;
	Darwin:x86_64)
		platform="darwin"
		arch="amd64"
		checksum="5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644"
		;;
	Darwin:arm64 | Darwin:aarch64)
		platform="darwin"
		arch="arm64"
		checksum="aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f"
		;;
	*)
		echo "No pinned actionlint binary for $(uname -s) $(uname -m)" >&2
		return 1
		;;
	esac

	archive="$CANDIDATE_DIR/actionlint_${version}_${platform}_${arch}.tar.gz"
	curl -fsSL "https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_${platform}_${arch}.tar.gz" -o "$archive"
	if [ "$platform" = "darwin" ]; then
		printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 -c -
	else
		printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
	fi
	mkdir -p "$CANDIDATE_DIR/actionlint"
	tar -xzf "$archive" -C "$CANDIDATE_DIR/actionlint" actionlint
	"$CANDIDATE_DIR/actionlint/actionlint" "$PROJECT_ROOT"/.github/workflows/*.yml
}

# Timeout policy: every `bun test` invocation below uses --timeout=120000,
# the same policy scripts/test-unit.sh and scripts/test-integration.sh use for
# their shards (see those scripts' headers for why: heavy tests can
# legitimately run 3-4x their solo duration under process contention, and the
# timeout exists to catch hangs, not to police performance). This used to
# diverge (no --timeout on most steps, --timeout=30000 on the old "Full Test
# Suite" step) which meant the same test could be given three different
# deadlines depending on which entry point ran it.
run_step "Workflow Syntax" validate_workflow_syntax
run_step "Workflow Release Contract" bun test --timeout=120000 tests/integration/workflow-release.test.ts
# Verify-only: must match what CI runs via `bun run lint`, not a write pass.
# `bun run lint` is `bunx biome check src/ tests/ scripts/` (no --write) plus
# 10 custom lint scripts (isolation, license headers, runtime boundary, write-
# source chokepoint, process.argv, repository SQL, goldens presence, test-ref
# literals, shipped assets, and the config-schema --check). A bare
# `bunx biome check --write src/ tests/` step here (a) mutated files during a
# pass that is supposed to only verify, and (b) skipped scripts/ plus all 10
# custom scripts, so it could pass while `bun run lint` — the thing CI
# actually gates on — would fail.
run_step "Lint" bun run lint
run_step "Type Check" bunx tsc --noEmit
run_step "Build Package" bun run build
run_step \
	"Verify npm bin target" \
	node -e 'const fs = require("node:fs"); const pkg = require("./package.json"); const bins = [["akm", "dist/akm", "cli.js", "cli-node.mjs"], ["akm-migrate", "dist/akm-migrate", "scripts/akm-migrate.js"]]; for (const [name, expected, bunEntry, nodeEntry] of bins) { const actual = pkg.bin?.[name]; if (actual !== expected) { console.error(`npm bin ${name} must point at ${expected}, got ${actual ?? "<undefined>"}`); process.exit(1); } if (!fs.existsSync(actual)) { console.error(`Missing npm bin target: ${actual}`); process.exit(1); } if (!fs.existsSync(`dist/${bunEntry}`)) { console.error(`Missing bundled entry: dist/${bunEntry}`); process.exit(1); } const entry = fs.readFileSync(actual, "utf8"); if (!entry.startsWith("#!/usr/bin/env node")) { console.error(`npm bin ${name} must expose Node to npm platform shims`); process.exit(1); } if (!entry.includes(`new URL("./${bunEntry}", import.meta.url)`)) { console.error(`npm bin ${name} must select its Bun entry`); process.exit(1); } if (nodeEntry && !entry.includes(`await import("./${nodeEntry}")`)) { console.error(`npm bin ${name} must retain its Node fallback`); process.exit(1); } if (!nodeEntry && entry.includes("migrate-storage-node.mjs")) { console.error(`npm bin ${name} must not retain the removed Node fallback`); process.exit(1); } } if (!fs.existsSync("dist/cli-node.mjs")) { console.error("Missing Node wrapper: dist/cli-node.mjs"); process.exit(1); } if (pkg.bin?.["akm-migrate-storage"] !== undefined) { console.error("Removed akm-migrate-storage bin is still declared"); process.exit(1); } for (const removed of ["dist/akm-migrate-storage", "dist/migrate-storage-node.mjs", "dist/scripts/migrate-storage.js"]) { if (fs.existsSync(removed)) { console.error(`Removed migration artifact still exists: ${removed}`); process.exit(1); } } if (pkg.engines?.node !== ">=22") { console.error(`package engines.node must be >=22, got ${pkg.engines?.node ?? "<undefined>"}`); process.exit(1); } if (fs.existsSync("dist/tests")) { console.error("Publish build should not emit dist/tests"); process.exit(1); }'
run_step \
	"Verify migration bundle" \
	node -e 'const { spawnSync } = require("node:child_process"); const os = require("node:os"); const path = require("node:path"); const root = path.join(os.tmpdir(), `akm-migrate-release-${process.pid}`); const result = spawnSync("./dist/akm-migrate", ["storage", "--list"], { encoding: "utf8", env: { ...process.env, AKM_CONFIG_DIR: path.join(root, "config"), AKM_CACHE_DIR: path.join(root, "cache"), AKM_DATA_DIR: path.join(root, "data"), AKM_STATE_DIR: path.join(root, "state") } }); if (result.error || result.status !== 0) { console.error(result.error?.message ?? result.stderr); process.exit(1); } const occurrences = result.stdout.split("akm storage migrations (in execution order):").length - 1; if (occurrences !== 1) { console.error(`Expected one storage migration listing, got ${occurrences}`); process.exit(1); }'
run_step "Package Acceptance" bun scripts/package-install.ts test-package --skip-build
run_step "Pack Package Candidate" pack_package_candidate
run_step \
  "Install and Setup Regression Suite" \
  bun test --timeout=120000 tests/setup/ ./tests/integration/setup-run.test.ts tests/integration/install-script.test.ts tests/setup-wizard.test.ts tests/setup-scheduled-tasks.test.ts
run_step \
  "Published 0.8 Task Upgrade" \
  env AKM_PUBLISHED_UPGRADE_TESTS=1 AKM_PUBLISHED_UPGRADE_TARBALL="$PACKAGE_CANDIDATE" AKM_CANDIDATE_VERSION="$(node -p "require('./package.json').version")" bun test --timeout=120000 tests/integration/published-task-upgrade.test.ts
if [ "$(uname -s)" = "Linux" ]; then
	run_step \
		"Build Linux Standalone Scheduler Artifact" \
		bun build ./scripts/akm-standalone.ts --compile --external @huggingface/transformers --outfile "$CANDIDATE_DIR/akm-linux-x64" --define "AKM_VERSION='$(node -p "require('./package.json').version")'"
	run_step \
		"Linux Standalone Outside PATH" \
		env AKM_STANDALONE_SCHEDULER_TESTS=1 AKM_STANDALONE_TEST_BIN="$CANDIDATE_DIR/akm-linux-x64" AKM_CANDIDATE_ARCH="$(node -p 'process.arch')" AKM_CANDIDATE_VERSION="$(node -p "require('./package.json').version")" bun test --timeout=120000 tests/integration/linux-standalone-scheduler.test.ts
fi
# Run the same two sharded, timeout-unified targets everything else in the
# repo (AGENTS.md, docs/architecture/testing/testing-workflow.md, CI) uses —
# not a bare, unsharded, whole-tree `bun test`. The old bare invocation ran
# every *.test.ts in the repo (unit AND integration) in a single process with
# a --timeout=30000 that matched neither runner's --timeout=120000 policy.
run_step "Full Test Suite (unit)" bash scripts/test-unit.sh
run_step "Full Test Suite (integration)" bash scripts/test-integration.sh

if [ "$SKIP_DOCKER" = false ]; then
	run_step "Docker Install Matrix" "$SCRIPT_DIR/docker/run-docker-tests.sh"
fi

echo "Release validation passed."
