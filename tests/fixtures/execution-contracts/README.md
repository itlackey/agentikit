# Execution contract characterization fixtures

These fixtures are the 0.9.2 WP0 inputs for issue #803. They are deliberately
separate from the format-family conformance trees: those trees describe index,
lint, and presentation behavior, while this tree describes execution inputs.

The fixtures have three different jobs:

- `native/` contains representative AKM, Claude, and OpenCode agent and command
  sources. Tests snapshot the exact configured or installed roots as bytes
  before indexing/exercising them, then compare those same roots afterward.
  Claude and OpenCode are also indexed in place as explicitly read-only native
  roots. Native files are authoritative inputs; a test must never update or
  synchronize them.
- `tasks/v2/` catalogs inputs for the future fail-closed v2-to-v3 migrator.
  `deterministic/` contains cases whose intended translation is fixed by the
  approved design; its manifest records the exact current parse projection so
  false/zero values, nested overrides, bounds, and redaction names cannot be
  lost unnoticed. `blocked/` contains currently valid v2 inputs whose meaning
  cannot be preserved by an automatic conversion. WP0 does not implement or
  simulate the migrator.
- `workflows/` contains one intentionally small Markdown/GitHub-shaped YAML
  equivalence pair and isolated rejection cases. The YAML files are fixtures
  for the future adapter, not a claim that the 0.9.1 runtime can load them.

`current-gaps.json` records observations that characterize the 0.9.1 baseline
without making those observations normative. A later work package is expected
to remove an entry when it closes that gap; tests must not cite an entry in that
file as the approved 0.9.2 behavior.

The normalized request and boundary captures live only under `tests/`. Direct
agent capture runs in a short-lived process so its injected runner module cannot
leak into another test. It records the real `akmAgentDispatch` runner, prompt,
and options rather than reconstructing them from config in the assertion.
