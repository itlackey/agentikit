# Architecture Review: Runtime secret resolution for in-process source fetchers

**Repo:** `/home/user/akm` (read-only review)
**Subject:** How the X snapshot fetcher (`src/sources/snapshot-fetchers/x.ts`) — and, more generally, the provider `sync()` / bundle-update path — should read a bearer token from akm's secret store at runtime, given a ref like `secrets/x-bearer-token`, without (a) leaking the value into agent/LLM/log context or (b) forming a static or dynamic import cycle.
**Date:** 2026-08-02

---

## 1. Executive summary

The root cause is a **Dependency Inversion violation**: the secret-store reader (`src/core/env-secret-ref.ts`) transitively imports the entire source-provider → fetcher-registry → fetcher subgraph (via `indexer/search/search-source.ts`), so any module inside that subgraph that reaches back to the store closes an import cycle the repo's ratchet forbids. The already-shipped fix is the right shape — a `resolveSecret?: (ref) => string | null` capability injected onto `FetcherContext` from callers positioned *above* the cycle (`src/sources/snapshot-fetchers/types.ts:43`) — but it is only wired in from the two command-layer entry points, leaving the provider-registry `sync()` / bundle-update path (`src/sources/providers/website.ts:26-32`) environment-variable-only. The recommended solution is to **formalize that existing seam as a first-class `SecretResolver` capability and thread it through the `sync()` path the same way it is already threaded through the `fetch()` path** — construct it once in `secret-seam.ts` (the sole sanctioned `env-secret-ref` importer, already outside the cycle) and pass it as data through `ensureSourceCaches → provider.sync → ensureWebsiteMirror`. This extends the shipped idiom rather than inventing a parallel one, adds no `env-secret-ref` import inside the cycle, and preserves the `secret run` value-containment discipline (same-frame header set, never returned upward, swallow-to-null).

---

## 2. Current architecture

### 2.1 How a ref resolves to a value

A "ref" (`secrets/x-bearer-token`, `env/FOO`) is resolved to an **absolute path** — never to bytes — inside `src/core/env-secret-ref.ts`:

1. `parseSecretRef` / `parseEnvRef` parse the ref into an `AssetRef` (`{type, name, origin}`); bare names auto-qualify to `env/` or `secrets/`, and legacy `vault:` / colon spellings are rejected loudly, not translated. (`src/core/env-secret-ref.ts:75-153`)
2. `findEnvSource` locates which configured bundle source holds the ref by `fs.existsSync` probing candidate source paths, using `resolveSourceEntries(undefined, loadConfig())` + `resolveSourcesForOrigin`. (`src/core/env-secret-ref.ts:85-106`)
3. `resolveSecretPath` / `resolveEnvPath` compute the absolute path via `assetPathForName` + an `isWithin` traversal guard and return `{name, absPath, source}` only — they never open the file. (`src/core/env-secret-ref.ts:121-145,168-195`)

The **only** place raw secret bytes are read is `readValue` (`src/commands/env/secret.ts:102-108`), an `fs.readFileSync` wrapper with a documented no-log / no-stdout contract; `loadEnv` (`src/commands/env/env.ts:89-100`) is the analogous whole-file reader for `.env`.

For fetchers specifically, the read path is `resolveSecretFromStore(ref)` in `src/sources/snapshot-fetchers/secret-seam.ts:23-31`: it calls `resolveSecretPath`, `fs.existsSync`, `fs.readFileSync(...).trim()`, and returns `null` for *any* failure — the underlying error (which can embed filesystem paths) is deliberately swallowed.

### 2.2 How values are kept out of context

akm keeps secret/env values out of agent/LLM/log surfaces with two layers:

- **Structural boundary.** The only sanctioned "use the value" path is `secret run`, which reads the file and injects it as `$VAR` into a `spawnSync` child's env — the read string never appears in a return value, in `output()`, or in the audit event (`src/commands/env/secret-cli.ts:213-231`; the `secret_access` event records ref + var name only, "never the value", `:221-226`). `env run` does the identical thing for whole `.env` files (`src/commands/env/env-cli.ts:280-301`). `env export` is the one path that writes a raw value, to a mode-`0600` file, never stdout (`src/commands/env/env-cli.ts:211-237`). `format-exempt.ts:53-67` formally classifies these as non-envelope commands so `--format` can't leak a value.
- **Defense-in-depth scrubber.** `src/core/redaction.ts` provides `collectSensitiveValues` / `redactSensitiveText` / `redactSensitiveValue` (`:193-398`) plus a pattern-based `redactCredentialPatterns` (`:307-341`, catches `Bearer` tokens, `sk-`/`key-` keys) invoked at every real output boundary — LLM error bodies (`src/llm/client.ts`), workflow reports (`src/workflows/exec/report.ts`), agent dispatch (`src/integrations/agent/runner-dispatch.ts`), proposal/improve output.

Today `x.ts` obeys the structural rule: `resolveXBearerToken` (`src/sources/snapshot-fetchers/x.ts:79-87`) returns the token to `fetch()`, which passes it straight into an `Authorization: Bearer` header inside `xApiJson`'s call frame (`x.ts:111-118`) and never onto a `FetcherContext` field, a `WikiSnapshotResult`, or an event.

### 2.3 The import cycle

```
src/core/env-secret-ref.ts
        │  import { resolveSourceEntries }        (env-secret-ref.ts:18)
        ▼
src/indexer/search/search-source.ts
        │  import { resolveSourceProviderFactory } (search-source.ts:13)
        │  import "../../sources/providers/index"  (search-source.ts:16, side-effect)
        ▼
src/sources/providers/index.ts
        │  imports ./website (and ./filesystem, ./git-provider, ./npm)
        ▼
src/sources/providers/website.ts
        │  import { ensureWebsiteMirror } from ../snapshot-fetchers/website-ingest
        ▼
src/sources/snapshot-fetchers/website-ingest.ts
        │  import { loadWikiSnapshotFetchers } from ./registry
        ▼
src/sources/snapshot-fetchers/registry.ts ──▶ x.ts, rss.ts, …  (the fetchers)

        ╭──────────────────── THE FORBIDDEN BACK-EDGE ────────────────────╮
        │  If x.ts (or website.ts) imports core/env-secret-ref — directly, │
        │  or via secret-seam.ts, or via a dynamic import() — the arrow    │
        │  closes back to the top and the cycle-ratchet rejects it.        │
        ╰──────────────────────────────────────────────────────────────────╯
```

`origin-resolve.ts` (`src/registry/origin-resolve.ts:5-9`) and `mutation-target.ts` (`src/core/mutation-target.ts:5-11`), both imported by `env-secret-ref.ts`, also reach `search-source.ts` — they reinforce the same vector rather than adding a second one. The pure helpers `env-secret-ref` imports (`config/config.ts`, `asset/*`) carry no provider/fetcher edges and are not part of the cycle.

---

## 3. Why it's hard

### 3.1 The precise SOLID violation

`core/env-secret-ref.ts` is a low-level detail (how akm reads a secret file) that has been made to **depend on** a high-level policy module graph (the whole source-resolution / provider / fetcher subsystem) through the single edge at `env-secret-ref.ts:18`. A fetcher (`x.ts`) is a high-level consumer whose policy is "authorize this outbound request." Because the concrete store sits *upstream* of the fetcher in the import graph, the fetcher cannot depend on the concrete store without a cycle. This is a textbook **DIP** situation: the fix must make both the consumer and the store depend on an **abstraction** (a leaf type), with the concrete store **injected** from a composition root above the cycle.

### 3.2 Why each naive fix fails

| Attempt | Why it fails |
|---|---|
| **Static import** of `env-secret-ref` from `x.ts` | Closes the back-edge directly. Ratchet rejects. |
| **Lazy `import()`** of `env-secret-ref` (or `secret-seam`) from inside the cycle | Same cycle; the ratchet treats dynamic `import()` as **"cycle-laundering"** and rejects it too. (`x.ts:73-74` documents this.) |
| **Relocated reader module** | Moving the reader still leaves a module *inside* the subgraph importing something that transitively reaches `env-secret-ref` — the *importer edge* is what closes the cycle, so relocation-without-severing keeps the back-edge. |
| **Shipped `FetcherContext.resolveSecret` seam** (`types.ts:43`) | Architecturally correct — injected, not imported. But populated **only** by the two command-layer callers (`src/commands/read/knowledge.ts:145`, `src/commands/sources/source-add.ts:173`) via `resolveSecretFromStore`. |

### 3.3 The `sync()` gap

The provider-registry refresh path never populates the seam. `website.ts`'s registered factory closure calls `ensureWebsiteMirror(config, { requireStashDir, force, ...allowPrivateHosts })` with **no `resolveSecret` key** (`src/sources/providers/website.ts:26-32`), and structurally *cannot* import one: `website.ts` is itself inside the cycle. The full downstream plumbing already exists — `ensureWebsiteMirror` → `scrapeWebsiteToStash` → `fetchSnapshotViaRegistry` → `FetcherContext.resolveSecret` all thread an optional `resolveSecret` (`website-ingest.ts:194-233,273-290,374-385`) — the *only* missing piece is that nothing inside the providers/registry subgraph can construct or receive a real resolver to hand in as that option's value. `ensureSourceCaches` calls `provider.sync({ force })` with no secret parameter (`search-source.ts:383`), and its sole materializing caller `indexer.ts:688-689` passes only `{ force, materialize }`. So the bundle-update path is `X_BEARER_TOKEN`-env-only.

---

## 4. Options considered

Four proposals were developed and adversarially critiqued. All four break the cycle correctly against the real edge list; they differ on idiom-fit, blast radius, and risk. Critic ranking: **P4 > P2 > P3 > P1**.

### 4.1 Proposal 1 — Secret-resolver runtime-registration port (service locator)

A zero-import leaf `src/core/secret-resolver-port.ts` holds a single registrable `SecretResolver` slot; a registration module (importing `secret-seam`) self-registers it, side-effect-imported from `cli.ts`; in-cycle consumers call `resolveRegisteredSecret(ref)`.

- **SOLID:** DIP inversion is real; SRP clean. But it introduces a **global mutable singleton / service locator** — an ambient dependency invisible in signatures — which is *not* a house idiom (akm uses context-object injection, not service location). Creates **two parallel seams** for one capability, which the subsystem map explicitly warned against.
- **Critic verdict: VIABLE, score 5 (lowest).** The "mirrors `registerSourceProvider`" framing is misleading: `registerSourceProvider` is safe because `search-source.ts` *eagerly* side-effect-imports `providers/index`, guaranteeing registration before any `sync()`. P1's registration module imports `env-secret-ref`, so `search-source` **cannot** import it — registration hangs off `cli.ts` alone with **no load-order guarantee**. Any entry that reaches `ensureSourceCaches` without going through `cli.ts` (tests, library embedding, a second binary, a workflow executor importing `search-source` directly) silently degrades to env-var-only. Requires a test-reset hook to avoid cross-test leakage.

### 4.2 Proposal 2 — `CredentialProvider` capability (opaque, replaces the field)

A pure-type leaf `src/sources/credential-provider.ts` defines `CredentialProvider { has(ref): boolean; authorizeBearer(ref, headers): void }` and `SourceProviderContext { credentials? }`. `FetcherContext.resolveSecret` is **replaced** by `credentials?`; `SourceProviderFactory` gains a 2nd `context?` arg; the value is injected from above.

- **SOLID:** Strongest value-containment of the four — `authorizeBearer` returns `void`, `has` returns `boolean`, so **there is no value to return upward**; the token never enters consumer scope as a standalone variable. Clean ISP (two focused methods) and DIP. **But** it deliberately violates the map's "extend not replace / reuse the field name" guidance: it renames the shipped field and changes factory arity, forcing lockstep migration of `x.ts`, `website-ingest` plumbing, two command sites, and all test doubles.
- **Critic verdict: VIABLE, score 7.** Compiles; cycle-break is real (leaf type is a graph sink). Principled long-term target *if* a breaking contract change is ever acceptable — today the replace-the-field churn is unjustified when P4 reaches the same consumers additively.

### 4.3 Proposal 3 — Leaf secret-read module with a provider-free enumerator

Split `env-secret-ref.ts` into a WRITE module and a new **leaf** `src/core/env-secret-read.ts` whose source enumeration (`secretSourceRoots`) is rebuilt from `bundlesToSourceEntries` + `lockContentRootFor` + `resolveStashDir` instead of `resolveSourceEntries` — **deleting** the `env-secret-ref → search-source` edge entirely.

- **SOLID:** Best SRP (separates read-resolution from write/mutation) and the only proposal that *removes* the load-bearing edge rather than routing a value around it. Verified the leaf's dependency set (`config/config`, `integrations/lockfile`, `core/common`, `asset-placement`, `resolve-ref`) has zero path to `search-source` or the providers subgraph. This is genuinely *not* the failed relocated-reader attempt, because it deletes the `resolveSourceEntries` call rather than moving it.
- **Critic verdict: VIABLE, score 6.** The decisive risk is an **OCP smell / second source-of-truth**: `secretSourceRoots` reimplements a slice of `resolveSourceEntries`, drops `deriveInstallations` origin matching (registryId-equality only), drops the `provider.path()` fallback for legacy/unlocked git-npm bundles, and skips website caches — so it can silently resolve a **different file** than the CLI would. That is exactly the resolver-mismatch class that got `secret path` / `secret remove` amputated (R-027 / D-49). Only safe if `secretSourceRoots` delegates to a shared lock-first helper also used by `resolveEntryContentDir`. Keep as a **future** structural cleanup, not the primary fix.

### 4.4 Proposal 4 — Threaded `SecretResolver` capability (recommended)

Promote the ad-hoc `resolveSecret?:(ref)=>string|null` into a first-class `SecretResolver` object, constructed once in `secret-seam.ts` (the sole sanctioned `env-secret-ref` importer, already outside the cycle) and threaded as an explicit **call-time parameter** through the `sync()` path (`ensureSourceCaches → provider.sync options → website.ts`) exactly as it is already threaded through the `fetch()` path. Closes the gap with **no registry, no dynamic import, no reader relocation, no new global**, and **extends** the shipped seam rather than replacing it.

- **SOLID:** SRP — the capability has one responsibility (`ref → value | null`); `secret-seam.ts` stays the single place that knows about `env-secret-ref`. OCP — a future provider kind (private git remote, authed npm registry) reads `options.secrets` in its own `sync()` with zero contract change. LSP — every `SecretResolver` substitute (store-backed, env-only stub, fixed-token fake) is interchangeable; `secrets?` stays optional (absent = documented env-var-only). ISP — single-method interface. DIP — this is the crux and the mechanism: in-cycle modules (`search-source`, `website.ts`, `x.ts`) depend on the `SecretResolver` **abstraction** (a leaf type in `provider.ts`), and the concrete binding is injected from composition roots above the cycle.
- **Critic verdict: RECOMMEND, score 8 (highest).** Compiles, cycle-break is real: `SecretResolver` goes in `src/sources/provider.ts`, a verified graph **sink** (it imports only type-only `config/config` and `sources/types`), so `search-source`/`website` importing a type creates no runtime back-edge; the concrete `storeSecretResolver` lives in `secret-seam.ts` (imported by nothing in the subgraph) and reaches `website.ts` as **plain data** on the sync options object handed down from `indexer.ts` (confirmed above the cycle). Value containment matches the `secret-cli.ts` bar.
- **One real weakness:** the `secrets` option is optional and *not* compiler-enforced, so a future call site that forgets to forward it silently degrades to env-var-only — the same failure class that produced today's gap, closed here but not eliminated for future callers. (Mitigated by the hybrid grafts below.)

---

## 5. Recommendation

**Adopt Proposal 4 (Threaded `SecretResolver` capability), with two cheap hardening grafts.** It is the minimal, additive, idiom-faithful fix: it extends the already-shipped `FetcherContext.resolveSecret` capability-injection seam down the `sync()` path instead of inventing a parallel mechanism, reaches both fetchers **and** provider `sync()`, and keeps the ratchet green because no `env-secret-ref` import lands inside the providers/registry/fetchers subgraph.

### 5.1 The abstraction (leaf type, a graph sink)

In `src/sources/provider.ts` (alongside `SourceProvider`; this module imports only type-only `config/config` and `sources/types`, so it stays a sink):

```ts
export interface SecretResolver {
  /** Resolve a store ref → value or null. Never logs, never throws upward. */
  resolveSecret(ref: string): string | null;
}

export interface SyncOptions {
  force?: boolean;
  secrets?: SecretResolver;
}

export interface SourceProvider {
  readonly name: string;
  readonly kind: SourceKind;
  path(): string;
  sync?(options?: SyncOptions): Promise<void>;   // was: sync?(options?: { force?: boolean })
}
```

`SourceProviderFactory` is unchanged (`(config: SourceConfigEntry) => SourceProvider`) — no factory arity change, unlike P2.

### 5.2 The single composition root (already outside the cycle)

In `src/sources/snapshot-fetchers/secret-seam.ts` (already the ONLY module importing `core/env-secret-ref`, and imported by nothing in the providers/registry/fetchers subgraph — verified: only `commands/read/knowledge.ts` and `commands/sources/source-add.ts` import it today):

```ts
export const storeSecretResolver: SecretResolver = { resolveSecret: resolveSecretFromStore };
```

**Graft (a) — belt-and-suspenders containment (from P2/`llm/client.ts`):** have this resolver register any resolved token into `redactSensitiveText` / `redactSensitiveValue`'s `sensitiveValues` set (`src/core/redaction.ts:193-398`), so that if a request-header ever reaches a serialized error/log surface the token is scrubbed. The structural never-returned-upward guarantee holds independently; this covers the residual transient `headers.Authorization` exposure that all four proposals share.

### 5.3 Threading through the `sync()` path (data, not imports)

`src/indexer/search/search-source.ts` — import the **type only**:

```ts
export async function ensureSourceCaches(
  config?: AkmConfig,
  options?: { force?: boolean; materialize?: boolean; secrets?: SecretResolver },
): Promise<void> {
  // …
  await provider.sync({ force, secrets: options?.secrets });   // was: provider.sync({ force })  (search-source.ts:383)
}
```

`src/sources/providers/website.ts` sync() — the one missing line (imports the `SecretResolver` **type** only; the resolver arrives as data):

```ts
async sync(options?: SyncOptions) {
  await ensureWebsiteMirror(config, {
    requireStashDir: true,
    force: options?.force,
    resolveSecret: options?.secrets?.resolveSecret,   // ← closes the gap; feeds the EXISTING plumbing
    ...(allowPrivateHosts ? { allowPrivateHosts: true } : {}),
  });
}
```

`FetcherContext.resolveSecret` (`types.ts:43`) and the entire `website-ingest.ts` `resolveSecret` plumbing (`:194-233,273-290,374-385`) are **unchanged** — the capability's `.resolveSecret` method feeds the existing field.

### 5.4 Wiring at the entry surfaces (all verified above the cycle)

- `src/indexer/indexer.ts:688-689` (full-index / hydrate — the env-var-only path today): pass `secrets: storeSecretResolver` into the existing `ensureSourceCaches(config, { force: full, materialize: …, secrets: storeSecretResolver })`. This is the step that actually closes the `sync()` gap. (`indexer.ts` reaches `search-source` via dynamic `import(...)`, confirming it is above the cycle.)
- `src/commands/sources/source-add.ts:173` and `src/commands/read/knowledge.ts:145`: optionally normalize the inline `resolveSecret: resolveSecretFromStore` to `resolveSecret: storeSecretResolver.resolveSecret` — behavior-identical; leaving them untouched still compiles.

### 5.5 How it serves fetchers AND provider `sync()`

- **Fetchers:** `x.ts` continues to read `context.resolveSecret` via `resolveXBearerToken` (`x.ts:79-87`) — no change to the fetcher. The value now arrives on the `sync()` path too, so `secrets/x-bearer-token` resolves during bundle update, not just from command-layer URL ingest.
- **Provider `sync()`:** any provider kind that later needs credentials reads `options.secrets` in its own `sync()` — the seam is on the shared `SourceProvider`/`SyncOptions` contract, so it generalizes beyond `website.ts`'s previously-ad-hoc plumbing.

**Graft (b) — anti-regression lint:** add a boundary lint (precedent: `scripts/lint-runtime-boundary.ts`, `scripts/lint-write-source-chokepoint.ts`) asserting that `materialize=true` callers of `ensureSourceCaches` supply a `SecretResolver`, neutralizing P4's one weakness (the optional, non-compiler-enforced threading).

---

## 6. Migration plan (each step keeps the ratchet green; each is independently provable)

1. **Add the leaf abstraction.** Add `SecretResolver` + `SyncOptions` to `src/sources/provider.ts` and widen `sync?()` to `SyncOptions`. Type-only, no behavior change — all four provider kinds' `sync` bodies still typecheck.
   *Proves:* `tsc`/build green; import-cycle ratchet green (no new runtime edge; `provider.ts` remains a sink).
2. **Add the composition root.** Add `export const storeSecretResolver` to `secret-seam.ts`. Include graft (a): register resolved tokens into `redactSensitiveText`'s `sensitiveValues`.
   *Proves:* unit test that `storeSecretResolver.resolveSecret("secrets/x-bearer-token")` returns the file value for a fixture store and `null` on missing/unreadable; a redaction test asserting the token is scrubbed from a synthesized header-bearing error string.
3. **Thread the option through `ensureSourceCaches`.** Add `secrets?: SecretResolver` to its options and forward it into `provider.sync(...)` (`search-source.ts:383`). Type-only import of `SecretResolver`.
   *Proves:* ratchet green (no `env-secret-ref` import added to the subgraph); existing `ensureSourceCaches` tests unchanged (option is optional).
4. **Populate `website.ts` sync().** Add `resolveSecret: options?.secrets?.resolveSecret` to the `ensureWebsiteMirror` call. Type-only import.
   *Proves:* ratchet green; a website-provider `sync()` test with a stub `SecretResolver` asserts the stub is invoked with `secrets/x-bearer-token` (previously never called).
5. **Wire the entry surface.** Pass `secrets: storeSecretResolver` at `indexer.ts:688-689`.
   *Proves:* integration test — run bundle update / full index on a website source whose X fetcher needs `secrets/x-bearer-token` with `X_BEARER_TOKEN` **unset**; assert the store value is used (previously env-only), AND assert the token never appears in `output()`, in `appendEvent`/`logs.db`, or in any structured surface.
6. **Normalize command call sites (optional, cosmetic).** Swap `source-add.ts:173` / `knowledge.ts:145` to `storeSecretResolver.resolveSecret`.
   *Proves:* existing command-layer fetcher tests remain green (behavior-identical).
7. **Add the anti-regression lint (graft b).** Assert `materialize=true` callers of `ensureSourceCaches` pass a `SecretResolver`.
   *Proves:* the lint fails on a deliberately-omitted call site and passes on the wired one.

Each step is additive and green in isolation, so the cycle ratchet never goes red and the change can land incrementally.

---

## 7. Risks and non-goals

**Risks**

- **Optional-threading regression (accepted, mitigated).** `secrets?` is optional and not compiler-enforced; a future `ensureSourceCaches`/`provider.sync` call site that forgets it silently reverts to env-var-only — the exact failure class being fixed, relocated to "did every caller pass it?". Graft (b)'s lint is the guard.
- **New value-materialization location.** The bundle-update / `sync()` path now reads a secret into memory where it previously did not. It stays confined to the `fetch()` call frame (`x.ts:111-118`), but it is a new location to audit against the never-in-context bar; graft (a) covers the residual serialized-header case.
- **Shared-contract widening.** `SourceProvider.sync`'s option type widens for a concern only `website` needs today. This is intentional future-proofing (OCP), and all existing `sync` bodies still typecheck, but it does touch a semi-public interface.
- **Underlying coupling remains.** P4 does **not** delete the `env-secret-ref → search-source` edge; it only guarantees the store stays on the outer side of it. The architectural smell (the store resolver transitively importing the whole source-resolution machinery) persists — see non-goals.

**Non-goals**

- **No new command surface / return path.** Do not add an `x-bearer-token path`-style command; the precedent (`secret path` / `secret remove` removal, R-027 / D-49) is that akm removes a surface rather than risk a resolver mismatch or accidental exposure.
- **Do not rely on `--format` / `output()` exemption as the safety mechanism.** The new path must be structurally value-free on its own (same-frame header set, never returned upward), not depend on CLI-level formatting exemptions.
- **Do not ship Proposal 3's independent enumerator now.** Deleting the `env-secret-ref → search-source` edge (P3) is the correct *eventual* structural cleanup, but only if `secretSourceRoots` **delegates to a shared lock-first helper** also used by `resolveEntryContentDir`; the as-written second-source-of-truth reintroduces the resolver-mismatch class that already cost `secret path` / `secret remove`. Track it as a separate, later refactor.
- **Do not adopt Proposal 2's breaking field rename now.** The opaque `CredentialProvider` (void/boolean methods, strongest containment) is the principled long-term target if a breaking contract change ever becomes acceptable; today its lockstep churn is unjustified when P4 reaches the same consumers additively.
