# Fixture: `akm-task` bundle (SPECIFICATION goldens)

A standalone task bundle of `.yml` tasks (AKM-native, not OKF markdown). Emits
`type=task`.

- **Adapter:** `akm-task`, validating strict task-v3 `.yml` through the
  canonical production source parser.
- **Goldens:** `tests/fixtures/format-family-goldens/akm-task/{recognition,placement,lint,renderer}.json`
- **Spec:** `docs/architecture/specs/akm-0.9.0-bundle-adapter-spec.md` §7 (akm-task row),
  §6 (task row).

Files:
- `nightly-index.yml` — **conformant task v3** (`akm/command` plus
  `akm.schedule`).
- `two-targets.yml` — **`invalid-task-yaml` violation** (declares both `uses`
  and `run`).
