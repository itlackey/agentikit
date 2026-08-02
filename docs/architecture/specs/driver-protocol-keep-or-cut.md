# The External Driver Protocol: Keep, Cut, or Cheapen

Status: PROPOSAL — decision requested. Three options, evidence for each.
Date: 2026-08-02
Baseline: `origin/main` @ `17a0dca`
Subject: `akm workflow brief` / `akm workflow report` (+ `report --settle`)
Related: [`workflow-engine-buy-vs-build.md`](./workflow-engine-buy-vs-build.md)
(which flagged this surface as the subsystem's largest removable block),
[`task-workflow-format-unification.md`](./task-workflow-format-unification.md)

---

## 1. The question

The driver protocol is 2,690 LOC of source — **31% of the workflow
engine** — plus a test surface of comparable size. It is Experimental,
opt-in behind `experimental.workflowEngine`, and has exactly three
non-test callers (all CLI handlers in `src/commands/workflow-cli.ts`). It
is a leaf.

Is the capability worth its cost, now that `akm workflow run` is the
canonical, Stable, ungated orchestrator?

## 2. What it actually is

`brief` (713 LOC) is **read-only**: resolve a run, project the active
step's work-list, emit JSON. Most of its length is the published contract
— seven exported interfaces external harnesses code against.

`report` (1,977 LOC) is the **mutating** half, and the weight is not
duplicated engine logic. Its header states a "no duplicated semantics
(the cardinal rule)" and it imports 19 shared functions from
`step-work.ts` — the same `computeStepWorkList`, `reduceStepOutcomes`,
`finalizeExecutedStep` the native executor calls. `driver-parity.test.ts`
asserts the R4 contract: an engine-driven run and a driver-driven run of
the same frozen plan produce **byte-identical unit graphs**.

The lines are the cost of exposing the engine's step transitions to an
external actor safely:

| Concern | ~LOC |
|---|---|
| Transactional phases (load → resolve → write → finalize) | ~605 |
| Step finalization (reducers, gates, spine advance) | ~491 |
| Claim + hash-divergence guards | ~212 |
| Helpers incl. returned-text redaction | ~216 |
| The `settle` verb (route-only/empty steps) | ~168 |
| Published contract interfaces | ~106 |

It must assume a hostile or buggy caller, tolerate two drivers racing
plus a possibly-live engine lease, treat a re-report with a matching hash
as idempotent and a differing hash as replay divergence, enforce budgets,
and redact text the driver hands back. The engine skips nearly all of
this because it trusts its own call stack.

**This is a fixed floor, not bloat.** Slimming it is not the lever;
scoping it is.

## 3. Two corrections to the case for keeping

Both were assumptions I had asserted and have since verified false or
overstated. They materially narrow the keep-argument, so they lead.

**(a) "Harness coverage collapses" — largely false.** Native dispatch is
not limited to claude/opencode. `HARNESS_ID_TABLE`
(`src/integrations/harnesses/ids.ts:34-45`) lists **ten** harnesses, all
`agentDispatch: true`: opencode, claude, opencode-sdk, codex, copilot,
pi, gemini, aider, amazonq, openhands.

**(b) The protocol's own documented users are, with one exception,
natively dispatchable.** `docs/reference/workflows.md:418` names them:
*"any agent session — Claude Code, opencode, Codex, or a human at a
shell."* Three of those four are in the table above.

## 4. What genuinely survives as unique value

Not harness neutrality — **in-session execution**. `run` with
`defaults.engine: claude` spawns a fresh `claude -p` subprocess. The
driver protocol lets the session you are *already in* do the work. Even
for a natively-dispatchable harness these differ:

- **Tooling.** A spawned subprocess does not inherit the calling
  session's MCP servers or loaded tools. Work requiring them can only run
  in-session.
- **Engine-free operation.** `run` hard-fails without a configured engine
  (`freeze.ts:54`, `INVALID_CONFIG_FILE`, exit 78). In a bare container
  or CI image where the operator *is* an agent but no agent CLI is
  configured, the driver protocol works and `run` does not.
- **Harnesses outside the ten** — Cursor, Zed, Windsurf — and a human at
  a shell.

Counter-consideration, stated fairly: fresh context per unit is often a
*feature* (the subagent argument), so "nested agent" is not by itself a
cost.

## 5. The cost of keeping

- **~2,690 LOC of the highest-risk code in the subsystem.** Untrusted
  mutation, claim races, lease contention, crash-mid-finalize.
- **It constrains engine evolution.** `report` is built on the
  `WorkflowRunUnitRow` shape via `withWorkflowRunsRepo` (no raw SQL — the
  coupling is through the repository layer, which is the good case, but
  it is still a second consumer). The R4 parity contract additionally
  requires `step-work.ts` to stay provably identical across two callers.
  The companion spec's IR v4 / hashVersion 5 work must keep both working.
- **A whole stability tier**: the `experimental.workflowEngine` gate, its
  refusal envelopes, `task doctor` reporting, and doc surface across five
  files.

## 6. The cost of cutting — measured, not estimated

**Fully deletable test files (4,013 LOC):** `brief.test.ts` (850),
`report.test.ts` (1,844), `conformance/driver-parity.test.ts` (1,319).

**Not deletable — rewrite required.** Five suites use the protocol as a
*test harness* for unrelated invariants and would need porting to `run`:

| Suite | LOC | Protocol call-sites |
|---|---|---|
| `chaos.test.ts` | 1,175 | 11 |
| `step-work.test.ts` | 1,127 | 4 |
| `run-lease.test.ts` | 841 | 5 |
| `frozen-plan.test.ts` | 342 | 5 |
| `params-validation.test.ts` | 159 | 5 |

That is ~3,644 LOC of coverage that must be **preserved through a
rewrite**, not deleted — and `chaos.test.ts` in particular uses `report`
to inject precisely the interleavings that make crash-safety testable
from outside the engine. Losing the ability to drive a run step-by-step
from a test is a real, under-appreciated cost of cutting.

**Documentation.** `docs/guides/claude-code-vs-akm-workflows.md:288`
calls the protocol *"the sharpest point of contact between the two
systems in this whole comparison."* Cutting means rewriting a
positioning guide, not just deleting code.

**It is the last external-driving mechanism.** `start`/`next`/`complete`
— the cheap manual-stepping loop that served the same need — were removed
when `run` became canonical. This is not "cut the expensive one, keep the
cheap one." Cut it and native dispatch is the only execution model,
permanently.

## 7. The three options

### Option A — Keep as-is
Accept ~2,690 LOC and the R4 constraint as the price of in-session
execution and test-harness driving. Reasonable if akm intends execution
neutrality as a product property.
*Cost:* the engine's hardest surface stays, and every IR change carries a
second consumer.

### Option B — Cut both verbs
Delete `brief`, `report`, `--settle`, the experimental gate, and 4,013
LOC of tests; port ~3,644 LOC of chaos/lease/frozen-plan coverage to
`run`; rewrite the positioning guide; accept that only the ten
natively-dispatchable harnesses can execute workflows and that a
configured engine becomes mandatory.
*Gain:* the largest single simplification available to the subsystem —
~4× more code than the best third-party adoption would have removed, with
no new dependency.
*Risk:* irreversible in practice, and it forecloses in-session execution.

### Option C — Cheapen: single-driver mode *(recommended for evaluation)*
Keep the capability, shed the concurrency machinery it no longer needs.

When the protocol was designed, `start`/`next`/`complete` still existed
and multiple actors could touch a run. Today the **run lease already
arbitrates exclusivity** — `run` takes it, and `report` already refuses
while a live engine lease is held. If the protocol declares
*one driver at a time, enforced by a driver lease*, then per-unit claim
ownership, contention resolution, and the contended-finalize paths become
redundant with a guard already in place.

What must stay regardless: **hash-divergence detection** (the replay
contract), budget enforcement, redaction of returned text, and the shared
`step-work.ts` semantics that make R4 hold.

What plausibly goes: `assertClaimHeldByOrFree`, the contended-finalize
result paths, and parts of the barrier decomposition — the ~212-LOC guard
block plus a share of the phase machinery. **I am not putting a number on
the saving without a design pass**; the honest claim is that the
machinery targeted was built for a concurrency model the current
architecture no longer permits.

*Gain:* keeps in-session execution and the chaos-test harness; removes
the hardest correctness surface.
*Cost:* one design pass; concurrent drivers become an explicit refusal
rather than a resolved race.

## 8. Recommendation

**Evaluate C first, decide between A and B only if C fails.** The
strongest argument for cutting was never code size — it was that the
protocol carries concurrency machinery for a world that no longer exists.
If C confirms that, akm keeps a genuine capability at a fraction of the
maintenance cost, and the R4 constraint is the only thing left to weigh.

If C does not hold up, the tiebreaker is a product question rather than
an engineering one: **is executing akm workflows from inside an arbitrary
agent session a property akm wants to guarantee?**

- **Yes → A.** Then stop treating ~2,690 LOC as a liability; it is close
  to the floor for a safe mutating protocol, and §2 shows the weight is
  structural.
- **No → B.** Native dispatch covers ten harnesses; take the largest
  simplification available and budget the test-port work honestly.

What should *not* happen is the status quo by default: an Experimental,
opt-in surface holding 31% of the engine and a parity constraint on every
future IR change, with no decision recorded either way.

## 9. Sequencing note

If B is chosen, it should land **before** the task/workflow unification
work, not after. That change is already an IR v4 + hashVersion 5 + schema
migration; doing it with one consumer of `workflow_run_units` and no R4
parity obligation is materially cheaper than doing it with two. If A or C
is chosen, the unification spec's existing accounting already covers the
second consumer and needs no revision.
