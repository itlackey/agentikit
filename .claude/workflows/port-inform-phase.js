export const meta = {
  name: 'port-inform-phase',
  description: 'Run one phase of the inform→akm port under the plan\'s test-first review cycle',
  whenToUse: 'Invoke with args {phase: "P1".."P5"} to drive a single phase from spec to gate. See docs/plans/port-inform-capabilities.md.',
  phases: [
    { title: 'Spec', detail: 'Opus writes the phase behavior spec', model: 'opus' },
    { title: 'Tests', detail: 'Sonnet writes failing tests' },
    { title: 'Test review', detail: 'Sonnet verifies the tests pin the spec' },
    { title: 'Implement', detail: 'Sonnet makes the tests pass' },
    { title: 'Code review', detail: 'Opus adversarial review of the phase diff', model: 'opus' },
    { title: 'Gate', detail: 'bun run check and acceptance criteria' },
  ],
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// The runtime may hand us `args` as a real object or as a JSON-encoded string,
// depending on how the tool call was serialized. A string has no `.phase`
// property, so reading it directly yields undefined and looks identical to
// "no args passed at all" — normalize before use and keep the distinction
// visible in the error below.
function normalizeArgs(raw) {
  if (raw == null) return {}
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return {}
    try {
      const parsed = JSON.parse(trimmed)
      return typeof parsed === 'object' && parsed !== null ? parsed : { phase: String(parsed) }
    } catch {
      return { phase: trimmed } // bare "P1"
    }
  }
  return raw
}

const input = normalizeArgs(args)

const REPO = input.repo ?? '/home/user/akm'
const BRANCH = 'claude/inform-akm-porting-nk81wa'
const PLAN = 'docs/plans/port-inform-capabilities.md'

// Bounded fix loops: a review that keeps finding CONFIRMED issues after this
// many rounds is a signal to stop and escalate, not to keep grinding.
const MAX_REVIEW_ROUNDS = 3

// Each phase points at exactly ONE plan section. Agents are told to read that
// heading plus the two shared sections — never the whole plan, never another
// phase's section. This is what keeps per-agent context small.
const PHASES = {
  P1: {
    title: 'robots.txt compliance',
    heading: '### P1 — robots.txt compliance (highest value, most isolated)',
    spec: 'docs/plans/specs/p1-robots.md',
    touches: 'src/sources/snapshot-fetchers/robots.ts (new), src/sources/snapshot-fetchers/website-ingest.ts',
  },
  P2: {
    title: 'main-content extraction',
    heading: '### P2 — main-content extraction',
    spec: 'docs/plans/specs/p2-content-extract.md',
    touches: 'src/sources/snapshot-fetchers/content-extract.ts (new), src/sources/snapshot-fetchers/website-ingest.ts, package.json',
  },
  P3: {
    title: 'RSS/Atom/RDF fetcher',
    heading: '### P3 — RSS/Atom/RDF fetcher',
    spec: 'docs/plans/specs/p3-rss.md',
    touches: 'src/sources/snapshot-fetchers/rss.ts (new), src/sources/snapshot-fetchers/registry.ts, package.json',
  },
  P4: {
    title: 'Bluesky fetcher',
    heading: '### P4 — Bluesky fetcher',
    spec: 'docs/plans/specs/p4-bluesky.md',
    touches: 'src/sources/snapshot-fetchers/bluesky.ts (new), src/sources/snapshot-fetchers/registry.ts',
  },
  P5: {
    title: 'X/Twitter fetcher',
    heading: '### P5 — X/Twitter fetcher',
    spec: 'docs/plans/specs/p5-x.md',
    touches: 'src/sources/snapshot-fetchers/x.ts (new), src/sources/snapshot-fetchers/registry.ts',
  },
}

const key = String(input.phase ?? '').toUpperCase()
const phaseDef = PHASES[key]
if (!phaseDef) {
  throw new Error(
    `Unknown phase ${JSON.stringify(input.phase)}. ` +
      `Received args as typeof=${typeof args}, raw=${JSON.stringify(args)}. ` +
      `Pass args {phase: "P1".."P5"}.`,
  )
}

// ---------------------------------------------------------------------------
// Schemas — structured returns keep agent output compact and machine-checkable
// ---------------------------------------------------------------------------

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['findings', 'verdict'],
  properties: {
    verdict: { type: 'string', enum: ['CLEAN', 'CHANGES_REQUIRED'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file', 'summary', 'requiredChange'],
        properties: {
          severity: { type: 'string', enum: ['CONFIRMED', 'ADVISORY'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          summary: { type: 'string' },
          requiredChange: { type: 'string' },
        },
      },
    },
  },
}

const TEST_REVIEW_SCHEMA = {
  type: 'object',
  required: ['findings', 'verdict', 'nullImplementationWouldPass'],
  properties: {
    verdict: { type: 'string', enum: ['CLEAN', 'CHANGES_REQUIRED'] },
    // The plan's explicit gate question: if a do-nothing implementation passes,
    // the tests are worthless regardless of how many findings came back.
    nullImplementationWouldPass: { type: 'boolean' },
    nullImplementationRationale: { type: 'string' },
    findings: REVIEW_SCHEMA.properties.findings,
  },
}

const WORK_SCHEMA = {
  type: 'object',
  required: ['filesChanged', 'summary'],
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    commit: { type: 'string' },
    notes: { type: 'string' },
  },
}

const GATE_SCHEMA = {
  type: 'object',
  required: ['lint', 'typecheck', 'unit', 'integration', 'allGreen'],
  properties: {
    lint: { type: 'boolean' },
    typecheck: { type: 'boolean' },
    unit: { type: 'boolean' },
    integration: { type: 'boolean' },
    allGreen: { type: 'boolean' },
    failureDetail: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
// Shared prompt preamble — pointers, not pasted plan text
// ---------------------------------------------------------------------------

const CONTEXT = `Repo: ${REPO} (already on branch ${BRANCH}). Work only in that repo.

Read these, and ONLY these, for plan context — do not read the whole plan file,
and do not read any other phase's section:
  - ${PLAN}, section "## 1. Goal and scope" through "### Licensing note"
    (this includes "### Approved dependencies" and "### 1.1 Decisions on record")
  - ${PLAN}, section "## 2. Architectural constraints" (includes "### Test conventions")
  - ${PLAN}, section "${phaseDef.heading}"

Also read ${REPO}/AGENTS.md. Do not read other phases' specs or source files
beyond what this phase touches: ${phaseDef.touches}

Keep your context small: open the specific files named above, grep for the exact
symbols you need, and do not walk the source tree.`

const RULES = `Non-negotiables (from plan section 2):
  - MPL-2.0 header on every new src/ and tests/ file.
  - No raw fetch(). All network goes through fetchWithRetry + assertWebsiteRequestUrl
    + assertResolvedHostAllowed + readBodyWithByteCap, and must thread the
    allowPrivateHosts test escape hatch.
  - UsageError/ConfigError from src/core/errors.ts on user-input paths; warn()
    from src/core/warn.ts for diagnostics. Never console.*.
  - Tests use tests/_helpers/sandbox.ts (withMockedFetch, sandboxStashDir).
    Never assign globalThis.fetch, mutate process.env.HOME, or process.chdir.
  - Only the dependencies listed under "### Approved dependencies" may be added.`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const confirmedOf = (review) =>
  (review?.findings ?? []).filter((f) => f.severity === 'CONFIRMED')

const renderFindings = (findings) =>
  findings
    .map((f, i) => `${i + 1}. [${f.file}${f.line ? `:${f.line}` : ''}] ${f.summary}\n   Required: ${f.requiredChange}`)
    .join('\n')

/**
 * Run a review→fix cycle until the reviewer returns no CONFIRMED findings or we
 * exhaust the round budget. Each review agent is a fresh subagent, so it never
 * inherits the authoring agent's reasoning — that is the plan's independence
 * requirement, enforced structurally rather than by instruction.
 */
async function reviewUntilClean({ label, phaseName, model, schema, buildReview, buildFix }) {
  const history = []
  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round += 1) {
    const review = await agent(buildReview(round), {
      label: `${label}:r${round}`,
      phase: phaseName,
      model,
      schema,
      effort: 'high',
    })
    const confirmed = confirmedOf(review)
    history.push({ round, verdict: review?.verdict ?? 'UNKNOWN', confirmed: confirmed.length })

    if (review && confirmed.length === 0) {
      log(`${label}: clean after ${round} round(s)`)
      return { clean: true, review, history }
    }

    log(`${label}: ${confirmed.length} CONFIRMED finding(s) in round ${round} — dispatching fix`)
    await agent(buildFix(confirmed, round), {
      label: `fix:${label}:r${round}`,
      phase: phaseName,
      model: 'sonnet',
    })
  }
  return { clean: false, history }
}

// ---------------------------------------------------------------------------
// Step 1 — SPEC (Opus)
// ---------------------------------------------------------------------------

phase('Spec')
log(`${key} (${phaseDef.title}): writing spec`)

const spec = await agent(
  `${CONTEXT}

Write the behavior spec for phase ${key} (${phaseDef.title}) and save it to ${phaseDef.spec}.

The spec is the single source of truth for the test author and implementer, who
will NOT read the plan's phase section themselves — they read your spec. So it
must stand alone. Include:
  1. Behavior table: input -> expected output, including edge cases.
  2. Inform-parity notes: where we deliberately diverge from inform and why.
  3. Security requirements specific to this phase.
  4. Config surface and defaults (call out any behavior change to existing users).
  5. Exact list of files to create/modify.
  6. Acceptance criteria as a checkbox list.
  7. An empty "## Review log" section for later rounds.

${RULES}

Read the inform reference implementation at /home/user/inform for behavior only —
it is CC-BY-4.0 and we are writing a clean TypeScript rewrite, not copying.

Commit the spec with message: docs(${key.toLowerCase()}): behavior spec for ${phaseDef.title}`,
  { label: `spec:${key}`, phase: 'Spec', model: 'opus', effort: 'high', schema: WORK_SCHEMA },
)

// ---------------------------------------------------------------------------
// Step 2 — TESTS (Sonnet) + Step 3 — TEST REVIEW (Sonnet)
// ---------------------------------------------------------------------------

phase('Tests')
log(`${key}: writing failing tests`)

await agent(
  `${CONTEXT}

Write the FAILING tests for phase ${key} (${phaseDef.title}).

Your spec is ${phaseDef.spec} — read it in full; it is authoritative. You do not
need to re-derive anything from the plan beyond the sections listed above.

Requirements:
  - Tests must fail against the current code and pass only once the spec is
    implemented. Verify this: run them and confirm red for the right reason
    (assertion failure, not import error).
  - Pre-existing tests must stay green.
  - Follow tests/_helpers/sandbox.ts conventions exactly. No real network.
  - Study tests/integration/add-website-source.test.ts and
    tests/integration/website-ssrf.test.ts for the established fixture patterns.

${RULES}

Commit with message: test(${key.toLowerCase()}): failing tests for ${phaseDef.title}`,
  { label: `tests:${key}`, phase: 'Tests', model: 'sonnet', schema: WORK_SCHEMA },
)

phase('Test review')

const testReview = await reviewUntilClean({
  label: `test-review:${key}`,
  phaseName: 'Test review',
  model: 'sonnet',
  schema: TEST_REVIEW_SCHEMA,
  buildReview: () => `${CONTEXT}

You are an INDEPENDENT test reviewer for phase ${key} (${phaseDef.title}). You did
not write these tests and must not assume the author's intent.

Read ${phaseDef.spec} and the test files added in the most recent commit
(git show --stat HEAD, then read those test files).

Answer, in order:
  1. Do the tests actually pin every row of the spec's behavior table?
  2. Are the spec's edge cases and security requirements covered?
  3. Are the tests hermetic (sandbox helpers, no globalThis.fetch assignment,
     no env/cwd mutation, no real network)?
  4. THE GATE QUESTION: would a trivially wrong implementation pass these tests
     — one that returns empty, ignores the new rule entirely, or echoes its
     input? Set nullImplementationWouldPass accordingly and justify it.
  5. Do the tests over-fit an anticipated implementation, asserting on internal
     structure rather than observable behavior?

Mark a finding CONFIRMED only if it must be fixed before implementation starts.
Style preferences are ADVISORY.`,
  buildFix: (confirmed) => `${CONTEXT}

An independent reviewer found CONFIRMED problems with the phase ${key} tests.
Fix each one, then re-run the tests to confirm they still fail for the right
reason (assertion failure against unimplemented behavior).

${renderFindings(confirmed)}

Spec: ${phaseDef.spec}. Amend or add to the existing test commit.`,
})

if (!testReview.clean) {
  log(`${key}: ABORTING — test review still has CONFIRMED findings after ${MAX_REVIEW_ROUNDS} rounds`)
  return {
    phase: key,
    status: 'blocked',
    blockedAt: 'test-review',
    history: testReview.history,
    message: 'Tests could not be brought to a reviewable state. Human decision needed.',
  }
}

// The plan's hard stop: insufficient tests make the rest of the phase theatre.
if (testReview.review?.nullImplementationWouldPass === true) {
  log(`${key}: ABORTING — reviewer says a null implementation would pass these tests`)
  return {
    phase: key,
    status: 'blocked',
    blockedAt: 'test-review:null-implementation',
    rationale: testReview.review?.nullImplementationRationale,
    message: 'Tests do not discriminate a correct implementation. Rewrite required.',
  }
}

// ---------------------------------------------------------------------------
// Step 4 — IMPLEMENT (Sonnet) + Step 5 — CODE REVIEW (Opus, final gate)
// ---------------------------------------------------------------------------

phase('Implement')
log(`${key}: implementing`)

const implStart = await agent(
  `Print the current git HEAD sha in ${REPO} and nothing else.`,
  { label: `mark:${key}`, phase: 'Implement', model: 'sonnet', effort: 'low' },
)

await agent(
  `${CONTEXT}

Implement phase ${key} (${phaseDef.title}) so the tests written for it pass.

Spec: ${phaseDef.spec} — authoritative, read it in full.

Rules:
  - Do NOT modify the tests. If you believe a test is wrong, leave it failing
    and say so in your summary with a written justification; the code reviewer
    must countersign any test change.
  - Green means: the phase tests pass AND bun run lint AND bunx tsc --noEmit
    AND bun run test:unit AND bun run test:integration all pass.
  - Run bunx biome check --write src/ tests/ before committing.

${RULES}

Commit with message: feat(${key.toLowerCase()}): ${phaseDef.title}`,
  { label: `impl:${key}`, phase: 'Implement', model: 'sonnet', schema: WORK_SCHEMA },
)

phase('Code review')

const codeReview = await reviewUntilClean({
  label: `code-review:${key}`,
  phaseName: 'Code review',
  model: 'opus',
  schema: REVIEW_SCHEMA,
  buildReview: () => `${CONTEXT}

You are the INDEPENDENT adversarial reviewer for phase ${key} (${phaseDef.title}).
This is the phase's final quality gate. You did not write this code.

Review the full phase diff: git diff ${implStart ?? 'HEAD~2'}..HEAD in ${REPO}.
Read ${phaseDef.spec} for what was supposed to happen.

Hunt specifically for:
  - Convention violations against plan section 2 (MPL headers, raw fetch,
    console.*, bare Error on user paths, test-isolation breaches).
  - SSRF gaps: any new network path missing the guard chain, missing on a
    redirect hop, or dropping allowPrivateHosts.
  - Silent behavior changes to existing users beyond what the spec authorizes.
  - Missing error paths and unhandled failure modes.
  - Secrets or tokens reachable in output, logs, fixtures, or frontmatter.
  - Tests weakened or deleted to make the build green.
${key === 'P2' ? '  - GOLDEN FILE CHURN: walk the website-snapshot golden diff file by file. Do not accept it wholesale. Confirm script/style stripping and http/https-only link safety survived the turndown migration.\n' : ''}${key === 'P3' ? '  - XML hardening: entity expansion behavior and the byte cap before parsing.\n' : ''}
Mark CONFIRMED only for things that must change before this phase can close.
Everything else is ADVISORY and goes in the spec's review log.`,
  buildFix: (confirmed) => `${CONTEXT}

The phase ${key} code review returned CONFIRMED findings. Fix each one, then
re-run: bunx biome check --write src/ tests/ && bun run lint && bunx tsc --noEmit
&& bun run test:unit && bun run test:integration.

${renderFindings(confirmed)}

Spec: ${phaseDef.spec}. Commit as: fix(${key.toLowerCase()}): address review findings`,
})

if (!codeReview.clean) {
  log(`${key}: ABORTING — code review still has CONFIRMED findings after ${MAX_REVIEW_ROUNDS} rounds`)
  return {
    phase: key,
    status: 'blocked',
    blockedAt: 'code-review',
    history: codeReview.history,
    message: 'Implementation could not pass adversarial review. Human decision needed.',
  }
}

// ---------------------------------------------------------------------------
// Step 6 — GATE
// ---------------------------------------------------------------------------

phase('Gate')

const gate = await agent(
  `In ${REPO}, run the full verification gate and report results honestly.
Run: bun run lint, then bunx tsc --noEmit, then bun run test:unit, then
bun run test:integration.
${key === 'P2' || key === 'P3' ? 'This phase adds a dependency, so ALSO run bun run build and confirm it produces working standalone binaries.\n' : ''}
Report which passed and which failed. If anything fails, include the failing
output in failureDetail. Do not fix anything — just report.`,
  { label: `gate:${key}`, phase: 'Gate', model: 'sonnet', schema: GATE_SCHEMA },
)

if (!gate?.allGreen) {
  log(`${key}: GATE FAILED`)
  return {
    phase: key,
    status: 'gate-failed',
    gate,
    message: 'Reviews closed but the verification gate is red.',
  }
}

await agent(
  `${CONTEXT}

Phase ${key} passed its gate. Close it out:
  1. Append the review log to ${phaseDef.spec}: every ADVISORY finding from the
     test review and the code review, with its disposition.
  2. Tick the acceptance-criteria checkboxes in ${phaseDef.spec} that are now met.
     Leave unmet ones unticked and note why.
  3. Add a CHANGELOG.md entry for this phase.${key === 'P1' ? ' P1 changes default behavior — the entry MUST document that robots.txt is now honored by default and name the respectRobots opt-out.' : ''}
  4. Commit, then: git push -u origin ${BRANCH}

Advisory findings to record:
${renderFindings((codeReview.review?.findings ?? []).filter((f) => f.severity === 'ADVISORY')) || '(none)'}`,
  { label: `close:${key}`, phase: 'Gate', model: 'sonnet', schema: WORK_SCHEMA },
)

log(`${key} (${phaseDef.title}): closed and pushed`)

return {
  phase: key,
  title: phaseDef.title,
  status: 'complete',
  spec: phaseDef.spec,
  specSummary: spec?.summary,
  testReviewRounds: testReview.history,
  codeReviewRounds: codeReview.history,
  advisories: (codeReview.review?.findings ?? []).filter((f) => f.severity === 'ADVISORY').length,
  gate,
}
