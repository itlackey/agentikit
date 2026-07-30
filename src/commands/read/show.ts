// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm show` — entry point.
 *
 * Spec §6.2:
 *
 *   show(ref) → indexer.lookup(ref) → readFile(entry.filePath)
 *
 * The richer presentation logic (matchers, renderers, edit-hints,
 * summary-detail truncation) lives below in this file. The flow:
 *
 *   1. Auto-index when stale so the index is current.
 *   2. Ask `indexer.lookup(ref)` for the row in the FTS index.
 *   3. Render the file via the matcher/renderer pipeline.
 */

import fs from "node:fs";
import path from "node:path";
import { recognizeMatch } from "../../core/adapter/recognize-match";
import { makeBundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { extractSection, markdownFragmentSlugs } from "../../core/asset/markdown";
import { displayRef, typeNameFromConceptId } from "../../core/asset/resolve-ref";
import { META_DIR, type MetaRef, parseMetaRef, resolveMetaFilePath } from "../../core/asset/stash-meta";
import { asNonEmptyString } from "../../core/common";
import { getIndexPassConfig, loadConfig } from "../../core/config/config";
import { NotFoundError, rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { appendEvent, readEvents } from "../../core/events";
import { withStateDbTelemetry } from "../../core/state-db";
import { presentationFor } from "../../core/type-presentation";
import { hasGraphData } from "../../indexer/db/graph-db";
import { listRelatedPathsForFile } from "../../indexer/graph/graph-boost";
import { extractGraphForSingleFile } from "../../indexer/graph/graph-extraction";
import { lookupBundleRef } from "../../indexer/indexer";
import type { StashEntryScope } from "../../indexer/passes/metadata";
import { ensurePrimaryIndexForRead, resolveReadSources } from "../../indexer/read-preflight";
import { usageEventAttributionMetadata } from "../../indexer/search/search-attribution";
import { buildEditHint, findSourceForPath, isEditable, resolveSourceEntries } from "../../indexer/search/search-source";
import { insertUsageEvent, type UsageEventSource } from "../../indexer/usage/usage-events";
import {
  buildFileContext,
  buildRenderContext,
  type FileContext,
  getRenderer,
  type MatchResult,
} from "../../indexer/walk/file-context";
import { resolveAssetPath } from "../../indexer/walk/path-resolver";
import { resolveIndexPassLLM } from "../../llm/index-passes";
import { resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { resolveStorageLocations } from "../../storage/locations";
import { closeDatabase, openExistingDatabase } from "../../storage/repositories/index-connection";
import { TELEMETRY_BUSY_TIMEOUT_MS, withIndexDb } from "../../storage/repositories/index-db";
import {
  findEntryIdByRef,
  getEntryById,
  getEntryIdByFilePath,
  getItemRefById,
} from "../../storage/repositories/index-entries-repository";
import { computeBodyHash } from "../../storage/repositories/index-llm-cache-repository";
// Eagerly import source providers to trigger self-registration.
import "../../sources/providers/index";
import type { ShowDetailLevel, ShowResponse } from "../../sources/types";
import { getCurrentWorkflowScopeKey } from "../../workflows/authoring/scope-key";
import { buildWorkflowAction } from "../../workflows/renderer";
import { getActiveWorkflowRun } from "../../workflows/runtime/runs";

/**
 * Unified show: queries the local FTS5 index, then falls back to on-disk
 * type-dir resolution if the index has no row. Spec §6.2; no remote provider
 * fallback.
 *
 * When `detail` is `"brief"` or `"summary"`, the response omits
 * content/template/prompt and returns compact metadata.
 */
export async function akmShowUnified(input: {
  ref: string;
  detail?: ShowDetailLevel;
  /**
   * Optional scope filter. When supplied, the resolved asset's frontmatter
   * `scope_user`/`scope_agent`/`scope_run`/`scope_channel` keys must match
   * every supplied filter value. A mismatch (or no scope on disk) raises a
   * {@link NotFoundError} so callers can distinguish "asset exists but is
   * out of scope" from "asset truly absent" via the standard error envelope.
   */
  scope?: StashEntryScope;
  /**
   * Event source for usage logging. Defaults to `"user"`. Set to
   * `"improve"` when called from improve's reflect/distill agents
   * so events can be filtered out of user-facing history.
   */
  eventSource?: UsageEventSource;
  /** Internal nested reads can render without recording a second user consumption row. */
  skipLogging?: boolean;
}): Promise<ShowResponse> {
  const ref = input.ref.trim();

  // 0a. Stash `.meta/` convention: `[origin//]meta[:name]` direct-reads a
  //     human-authored orientation doc from the stash's `.meta/` directory.
  //     These files are not indexed (the walker skips dot-dirs), so they are
  //     resolved here before the index lookup; meta docs are not asset refs.
  {
    const metaRef = parseMetaRef(ref);
    if (metaRef) return showStashMeta(metaRef);
  }

  // Auto-index when stale so the index is current before lookup.
  const { primarySource } = resolveReadSources();
  await ensurePrimaryIndexForRead(primarySource);

  // Try local filesystem (FTS5 index lookup)
  const result = await showLocal(input);
  // Scope filter narrows resolution: if a scope filter was supplied, the
  // asset's frontmatter scope must satisfy every supplied key. We re-read the
  // file (cheap — already on the show hot path) so we don't have to thread
  // scope through the renderer chain just for one verification step.
  if (input.scope && hasAnyScopeKey(input.scope) && result.path) {
    enforceScopeOrThrow(result.path, ref, input.scope);
  }
  // Count prior shows of this ref before logging the current one.
  if (!input.skipLogging) {
    const consumedRef = result.ref ?? makeBundleRef(undefined, parseBundleRef(ref).conceptId);
    const priorShowCount = recentShowCount(consumedRef);
    logShowEvent(consumedRef, result.type, result.name, input.eventSource, result.path);
    if (priorShowCount >= 2) {
      // Agent has shown this same asset 3+ times — inject a loop-break hint.
      (result as unknown as Record<string, unknown>).showLoopWarning = priorShowCount + 1;
    }
  }
  return result;
}

/**
 * Resolve a stash `.meta/` doc and return it as a lightweight ShowResponse.
 *
 * With no origin the working stash (and other configured sources, in order)
 * is searched and the first hit wins. With an origin the lookup is narrowed
 * to that stash; an uninstalled origin yields an actionable "not installed"
 * error. The file is read directly from disk — `.meta/` is never indexed.
 */
async function showStashMeta(metaRef: MetaRef): Promise<ShowResponse> {
  const allSources = resolveSourceEntries();
  const sources = resolveSourcesForOrigin(metaRef.origin, allSources);

  if (metaRef.origin && sources.length === 0) {
    throw new NotFoundError(
      `Stash "${metaRef.origin}" is not installed, so its ${META_DIR}/ docs are unavailable. ` +
        `Run: akm bundle add ${metaRef.origin}`,
    );
  }

  const config = loadConfig();
  for (const source of sources) {
    const filePath = resolveMetaFilePath(source.path, metaRef.name);
    if (!filePath) continue;
    const content = fs.readFileSync(filePath, "utf8");
    const editable = isEditable(filePath, config, allSources);
    appendEvent({ eventType: "show", ref: `meta:${metaRef.name}`, metadata: { type: "meta", name: metaRef.name } });
    return {
      type: "meta",
      name: metaRef.name,
      path: filePath,
      ref: `meta:${metaRef.name}`,
      content,
      origin: source.registryId ?? null,
      editable,
    } as ShowResponse;
  }

  throw new NotFoundError(
    `No ${META_DIR}/${metaRef.name} doc found${metaRef.origin ? ` in "${metaRef.origin}"` : ""}. ` +
      `Stash maintainers can create ${META_DIR}/${metaRef.name}.md to describe this stash ` +
      `(purpose, key assets, conventions, maintainer).`,
  );
}

function hasAnyScopeKey(scope: StashEntryScope): boolean {
  return Boolean(scope.user || scope.agent || scope.run || scope.channel);
}

/**
 * Read the asset file's frontmatter and verify its `scope_*` keys satisfy
 * every supplied filter. Throws a {@link NotFoundError} on mismatch so the
 * caller surfaces a uniform "not found in this scope" envelope rather than
 * leaking out-of-scope content.
 */
function enforceScopeOrThrow(filePath: string, ref: string, scope: StashEntryScope): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    // The file path was just resolved by the indexer/disk-walk — a read
    // failure here means the on-disk state moved out from under us. Treat
    // that as "not found in this scope" so the caller does not learn the
    // file's prior contents.
    throw new NotFoundError(`Asset not found for scope filter: ${ref}`);
  }
  const fm = parseFrontmatter(raw).data;
  const expected: Array<[keyof StashEntryScope, string | undefined]> = [
    ["user", scope.user],
    ["agent", scope.agent],
    ["run", scope.run],
    ["channel", scope.channel],
  ];
  for (const [key, expectedValue] of expected) {
    if (expectedValue === undefined) continue;
    const actual = asNonEmptyString(fm[`scope_${key}`]);
    if (actual !== expectedValue) {
      throw new NotFoundError(`Asset "${ref}" exists but is out of scope (expected scope_${key}="${expectedValue}").`);
    }
  }
}

/**
 * Count how many times `ref` has been shown in the current session by reading
 * recent events. Returns the count BEFORE the current invocation.
 */
function recentShowCount(ref: string): number {
  try {
    const { events } = readEvents({
      type: "show",
      ref,
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    return events.length;
  } catch {
    return 0;
  }
}

function logShowEvent(
  ref: string,
  type: string,
  name: string,
  eventSource: UsageEventSource = "user",
  filePath?: string,
): void {
  // Emit a structured event to events.jsonl so workflow-trace consumers
  // detect akm show invocations without relying on stdout scraping.
  const eventRef = makeBundleRef(parseBundleRef(ref).bundle, parseBundleRef(ref).conceptId);
  appendEvent({ eventType: "show", ref: eventRef, metadata: { type, name } });

  // Detect if this show is a selection from a recent search result.
  try {
    // D7: bound the query to the last 60 s so we never scan unbounded history
    const { events: recentSearches } = readEvents({
      type: "search",
      since: new Date(Date.now() - 60_000).toISOString(),
    });
    const cutoffMs = Date.now() - 60_000;
    const matchingSearch = [...recentSearches].reverse().find((e) => {
      if (!e.ts || new Date(e.ts).getTime() < cutoffMs) return false;
      const refs = (e.metadata?.resultRefs as string[] | undefined) ?? [];
      return refs.includes(ref);
    });
    if (matchingSearch) {
      appendEvent({
        eventType: "select",
        ref,
        metadata: {
          query: matchingSearch.metadata?.query as string | undefined,
          searchTs: matchingSearch.ts,
          rankPosition: ((matchingSearch.metadata?.resultRefs as string[] | undefined) ?? []).indexOf(ref),
        },
      });
    }
  } catch {
    /* fire-and-forget — select is best-effort */
  }

  try {
    withIndexDb(
      (db) => {
        const entryId = filePath ? getEntryIdByFilePath(db, filePath) : findEntryIdByRef(db, eventRef);
        if (entryId === undefined) return;
        // Usage events carry only the resolved row's fully-qualified item_ref.
        // A disk-only show has no durable indexed identity yet, so it does not
        // create a per-entry usage row.
        const entryRef = getItemRefById(db, entryId);
        if (!entryRef) return;
        const entry = getEntryById(db, entryId);
        withStateDbTelemetry((stateDb) => {
          insertUsageEvent(stateDb, {
            event_type: "show",
            entry_ref: entryRef,
            entry_id: entryId,
            metadata: usageEventAttributionMetadata(
              entry?.entry.derivedFrom ? { memoryInference: { exposure: "direct" } } : undefined,
              entryRef,
            ),
            source: eventSource,
          });
        }, TELEMETRY_BUSY_TIMEOUT_MS);
      },
      { busyTimeoutMs: TELEMETRY_BUSY_TIMEOUT_MS },
    );
  } catch (err) {
    rethrowIfTestIsolationError(err);
    /* fire-and-forget */
  }
}

/** @internal Use akmShowUnified() for all external callers. */
export async function showLocal(input: {
  ref: string;
  detail?: ShowDetailLevel;
  stashDir?: string;
}): Promise<ShowResponse> {
  const parsed = parseBundleRef(input.ref);
  const assetParts = typeNameFromConceptId(parsed.conceptId);
  const config = loadConfig();
  const allSources = resolveSourceEntries(input.stashDir);
  const searchSources = resolveSourcesForOrigin(parsed.bundle, allSources);

  const allSourceDirs = searchSources.map((s) => s.path);

  let indexedEntry: Awaited<ReturnType<typeof lookupBundleRef>> = null;
  try {
    indexedEntry = await lookupBundleRef(parsed);
  } catch (err) {
    rethrowIfTestIsolationError(err);
    indexedEntry = null;
  }
  const resolvedAssetPath =
    indexedEntry?.filePath ??
    (assetParts
      ? await resolveAssetPath(
          { type: assetParts.type, name: assetParts.name, origin: parsed.bundle },
          {
            stashDir: input.stashDir,
            mode: "disk-only",
          },
        )
      : null);
  const assetPath = resolvedAssetPath ?? undefined;
  const displayType = indexedEntry?.type ?? assetParts?.type ?? "asset";
  const displayName = indexedEntry?.name ?? assetParts?.name ?? parsed.conceptId;

  if (!assetPath && parsed.bundle && searchSources.length === 0) {
    const installCmd = `akm bundle add ${parsed.bundle}`;
    throw new NotFoundError(
      `Stash asset not found for ref: ${makeBundleRef(parsed.bundle, parsed.conceptId)}. ` +
        `Stash "${parsed.bundle}" is not installed. Run: ${installCmd}`,
    );
  }

  if (!assetPath) {
    throw new NotFoundError(
      `Stash asset not found for ref: ${makeBundleRef(parsed.bundle, parsed.conceptId)}. ` +
        "Check the name with `akm search` or verify the asset exists in your stash.",
    );
  }

  if (indexedEntry) {
    try {
      fs.accessSync(assetPath, fs.constants.R_OK);
    } catch (error) {
      throwIndexedPathNotFound(error, input.ref);
    }
  }

  const source = findSourceForPath(assetPath, allSources);
  const sourceStashDir = source?.path ?? allSourceDirs[0];

  if (!sourceStashDir) {
    throw new UsageError(
      `Could not determine stash root for asset: ${makeBundleRef(parsed.bundle, parsed.conceptId)}. ` +
        "Run `akm bundle create` to create the stash directory, or check `akm bundle list` for configured paths.",
    );
  }

  const fileCtx = buildFileContext(sourceStashDir, assetPath);
  const indexedRenderer = indexedEntry ? rendererForIndexedEntry(indexedEntry, fileCtx) : undefined;
  let response: ShowResponse;
  try {
    if (indexedEntry && indexedRenderer === null) {
      response = buildIndexedProjectionResponse(indexedEntry, assetPath, parsed.fragment);
    } else {
      const match =
        indexedEntry && typeof indexedRenderer === "string"
          ? indexedMatch(indexedEntry, indexedRenderer)
          : recognizeMatch(fileCtx);
      if (!match) {
        throw new UsageError(
          `Could not display asset "${makeBundleRef(parsed.bundle, parsed.conceptId)}" — unsupported file type or unrecognized layout`,
        );
      }

      match.meta = { ...match.meta, name: displayName };
      const renderer = await getRenderer(match.renderer);
      if (!renderer) {
        throw new UsageError(
          `Renderer "${match.renderer}" not found for asset: ${makeBundleRef(parsed.bundle, parsed.conceptId)}`,
        );
      }

      const renderBundle = indexedEntry ? indexedEntry.bundleId : source?.registryId;
      const renderDefaultBundle =
        config.defaultBundle ?? (source?.path === allSources[0]?.path ? renderBundle : undefined);
      const renderCtx = buildRenderContext(fileCtx, match, allSourceDirs, renderBundle, renderDefaultBundle);
      response = renderer.buildShowResponse(renderCtx);
      if (parsed.fragment !== undefined) {
        if (!match.renderer.endsWith("-md")) {
          throw new UsageError(
            `Fragments are not supported for ${makeBundleRef(parsed.bundle, parsed.conceptId)}. Only Markdown documents support heading fragments.`,
            "INVALID_FLAG_VALUE",
          );
        }
        applyMarkdownFragment(response, fileCtx.content(), parsed.fragment, displayName);
      }
    }
  } catch (error) {
    if (indexedEntry) throwIndexedPathNotFound(error, input.ref);
    throw error;
  }
  if (indexedEntry) {
    response.type = indexedEntry.type;
    response.name = indexedEntry.name;
  }
  const isPrimaryStash = source !== undefined && source.path === allSources[0]?.path;
  const canonicalRef = displayRef(
    {
      type: displayType,
      name: displayName,
      conceptId: indexedEntry?.conceptId,
      bundleId: indexedEntry ? indexedEntry.bundleId : source?.registryId,
    },
    config.defaultBundle ?? (isPrimaryStash ? indexedEntry?.bundleId : undefined),
  );
  if (response.type === "workflow") response.action = buildWorkflowAction(canonicalRef);
  // 07 P1-D: provenance-aware toolPolicy CEILING. An agent's self-declared
  // `tools` frontmatter is honoured ONLY for the operator's own PRIMARY stash —
  // the assets they authored. Every other source is content pulled from
  // elsewhere and must not name its own tool grant: registry-installed packs, a
  // configured secondary source, and even a git source the operator marked
  // `--writable` to contribute edits upstream (writability is "can I push", not
  // "do I trust this content to grant itself tools"). Drop the policy so dispatch
  // falls back to the parent/default grant. Keys off primary-stash identity —
  // `allSources[0]` is always the primary (search-source.ts) — not a
  // name-derived registryId or the orthogonal `writable` bit. `source` undefined
  // (unresolved path) also fails closed.
  if (response.toolPolicy !== undefined && !isPrimaryStash) {
    delete (response as { toolPolicy?: unknown }).toolPolicy;
  }
  const editable = isEditable(assetPath, config, allSources);
  const fullResponse: ShowResponse = {
    ...response,
    ref: canonicalRef,
    origin: source?.registryId ?? null,
    editable,
    ...(!editable ? { editHint: buildEditHint(canonicalRef) } : {}),
    related: (() => {
      try {
        return withIndexDb((db) => {
          const related = listRelatedPathsForFile(sourceStashDir, assetPath, 5, db);
          return { total: related.length, hits: related };
        });
      } catch (err) {
        rethrowIfTestIsolationError(err);
        return { total: 0, hits: [] };
      }
    })(),
  };

  const activeRun = await getActiveWorkflowRun(getCurrentWorkflowScopeKey());
  if (activeRun) {
    (fullResponse as unknown as Record<string, unknown>).activeRun = activeRun;
  }

  // #624-P3: opt-in inline graph extraction. Default OFF — when the flag is
  // unset this whole block is skipped (no hasGraphData check, no LLM call), so
  // behavior is byte-identical to today. When ON, it extracts graph data for an
  // ungraphed asset, but ONLY when a model is configured (model-available
  // guard) and ALWAYS bounded by a 30s timeout so `show` can never hang. Any
  // timeout/model-unavailable/error path returns the response unchanged.
  if (getIndexPassConfig(config.index, "graph")?.lazyGraphExtraction === true) {
    await maybeExtractGraphInline(config, sourceStashDir, assetPath);
  }

  if (input.detail === "brief") {
    return buildBriefResponse(fullResponse, assetPath);
  }

  if (input.detail === "summary") {
    return buildSummaryResponse(fullResponse, assetPath);
  }

  return fullResponse;
}

/**
 * #624-P3 — opt-in inline graph extraction for `akm show`. Best-effort and
 * timeout-bounded: never throws, never hangs, never mutates the response.
 *
 * Preconditions (caller already checked the flag): a model must be configured
 * (model-available guard via {@link resolveIndexPassLLM}) and the asset must be
 * ungraphed ({@link hasGraphData}). Extraction races a 30s timeout so `show`
 * cannot block on a slow provider; any timeout/error/missing-model path is
 * swallowed and `show` returns its already-assembled response unchanged.
 */
async function maybeExtractGraphInline(
  config: ReturnType<typeof loadConfig>,
  sourceStashDir: string,
  assetPath: string,
): Promise<void> {
  try {
    // Model-available guard — no provider configured ⇒ silent skip, no LLM call.
    if (!resolveIndexPassLLM("graph", config)) return;

    let alreadyGraphed = false;
    let bodyHash: string | undefined;
    try {
      const raw = fs.readFileSync(assetPath, "utf8");
      bodyHash = computeBodyHash(parseFrontmatter(raw).content.trim());
    } catch {
      return; // file gone/unreadable ⇒ nothing to extract
    }

    withIndexDb(
      (db) => {
        alreadyGraphed = hasGraphData(db, sourceStashDir, assetPath);
      },
      { busyTimeoutMs: TELEMETRY_BUSY_TIMEOUT_MS },
    );
    if (alreadyGraphed) return;

    // Open the db for the async extraction ourselves: `withIndexDb` is
    // synchronous and would close the connection the instant the async fn
    // returns its Promise (before extraction completes). Close it explicitly
    // after the race settles instead.
    const db = openExistingDatabase(resolveStorageLocations().indexDb);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 30_000);
    });
    try {
      await Promise.race([extractGraphForSingleFile(db, sourceStashDir, assetPath, bodyHash, { config }), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      closeDatabase(db);
    }
  } catch (err) {
    rethrowIfTestIsolationError(err);
    // Any other failure: silently return the unchanged show response.
  }
}

/**
 * Minimal `show`: ref → indexer lookup → file contents. Used by callers that
 * just need the raw file (e.g. clone, write-source) and don't want the full
 * renderer graph. Spec §6.2's literal flow.
 */
export async function showByRef(ref: string): Promise<{ filePath: string; body: string }> {
  const parsed = parseBundleRef(ref);
  if (parsed.fragment !== undefined) {
    throw new UsageError(`Fragments are not accepted by raw show: ${ref}`, "INVALID_FLAG_VALUE");
  }
  const entry = await lookupBundleRef(parsed);
  if (!entry) {
    throw new NotFoundError(`Asset not found for ref: ${makeBundleRef(parsed.bundle, parsed.conceptId)}`);
  }
  let body: string;
  try {
    body = await fs.promises.readFile(entry.filePath, "utf8");
  } catch (error) {
    throwIndexedPathNotFound(error, ref);
  }
  return { filePath: entry.filePath, body };
}

function throwIndexedPathNotFound(error: unknown, ref: string): never {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
    throw new NotFoundError(
      `The indexed file for ${ref} is missing or unreadable. The search index may be stale.`,
      "ASSET_NOT_FOUND",
      "Run `akm index` to reconcile indexed paths, then retry `akm show`.",
    );
  }
  throw error;
}

type IndexedEntry = NonNullable<Awaited<ReturnType<typeof lookupBundleRef>>>;

/** `null` selects adapter-owned projection; a string selects a core renderer. */
function rendererForIndexedEntry(entry: IndexedEntry, _file: FileContext): string | null | undefined {
  if (entry.document?.ownsPresentation === true) return null;
  switch (entry.adapterId) {
    case null:
    case undefined:
    case "akm":
      return undefined;
    case "akm-workflow":
      return "workflow-md";
    default:
      return presentationFor(entry.type).renderer;
  }
}

function indexedMatch(entry: IndexedEntry, renderer: string): MatchResult {
  return { type: entry.type, specificity: Number.MAX_SAFE_INTEGER, renderer, meta: { name: entry.name } };
}

function buildIndexedProjectionResponse(
  entry: IndexedEntry,
  assetPath: string,
  fragment: string | undefined,
): ShowResponse {
  if (fragment !== undefined && path.extname(assetPath).toLowerCase() !== ".md") {
    throw new UsageError(
      `Fragments are not supported for ${entry.conceptId}. Only Markdown documents support heading fragments.`,
      "INVALID_FLAG_VALUE",
    );
  }
  const raw = fs.readFileSync(assetPath, "utf8");
  const parsed = parseFrontmatter(raw);
  const content = fragment ? requireMarkdownSection(parsed.content, fragment, entry.name).content : parsed.content;
  const description = entry.document?.description ?? asNonEmptyString(parsed.data.description);
  const tags =
    entry.document?.tags ??
    (Array.isArray(parsed.data.tags)
      ? parsed.data.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
      : undefined);
  return {
    type: entry.type,
    name: entry.name,
    path: assetPath,
    action: "Read the content below.",
    content,
    ...(description ? { description } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
  };
}

function applyMarkdownFragment(response: ShowResponse, raw: string, fragment: string, name: string): void {
  const section = requireMarkdownSection(parseFrontmatter(raw).content, fragment, name).content;
  if (response.template !== undefined) response.template = section;
  else if (response.prompt !== undefined) response.prompt = section;
  else response.content = section;
}

function requireMarkdownSection(
  content: string,
  fragment: string,
  name: string,
): NonNullable<ReturnType<typeof extractSection>> {
  const section = extractSection(content, fragment);
  if (section) return section;
  const available = markdownFragmentSlugs(content);
  throw new NotFoundError(
    `Fragment "#${fragment}" not found in ${name}.` +
      (available.length > 0 ? ` Available fragments: ${available.map((slug) => `#${slug}`).join(", ")}.` : ""),
  );
}

/**
 * Build a reduced brief response from a full ShowResponse.
 *
 * Keeps routing/identification fields while omitting content/template/prompt.
 */
function buildBriefResponse(full: ShowResponse, assetPath?: string): ShowResponse {
  const summary = buildSummaryResponse(full, assetPath);
  return {
    type: summary.type,
    name: summary.name,
    path: summary.path,
    ...(summary.ref ? { ref: summary.ref } : {}),
    ...(summary.description ? { description: summary.description } : {}),
    ...(summary.action ? { action: summary.action } : {}),
    ...(summary.run ? { run: summary.run } : {}),
    ...(summary.origin !== undefined ? { origin: summary.origin } : {}),
    ...(full.editable !== undefined ? { editable: full.editable } : {}),
    ...(full.editHint ? { editHint: full.editHint } : {}),
  };
}

/**
 * Build a compact summary response from a full ShowResponse.
 *
 * Strips content/template/prompt and returns only metadata fields:
 * type, name, path, description, tags, parameters, action.
 * Enriches description and tags from rendered content when available.
 *
 * The resulting JSON should be under 200 tokens.
 */
function buildSummaryResponse(full: ShowResponse, assetPath?: string): ShowResponse {
  let description = full.description;
  const tags = full.tags;

  if (assetPath) {
    const textContent = full.content ?? full.template ?? full.prompt;
    if (textContent && !description) {
      const parsed = parseFrontmatter(textContent);
      description = asNonEmptyString(parsed.data.description);
    }
  }

  const summary: ShowResponse = {
    type: full.type,
    name: full.name,
    path: full.path,
    ...(full.ref ? { ref: full.ref } : {}),
    ...(description ? { description } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(full.parameters ? { parameters: full.parameters } : {}),
    ...(full.workflowTitle ? { workflowTitle: full.workflowTitle } : {}),
    ...(full.action ? { action: full.action } : {}),
    ...(full.run ? { run: full.run } : {}),
    ...(full.origin !== undefined ? { origin: full.origin } : {}),
    ...(full.editable !== undefined ? { editable: full.editable } : {}),
    ...(full.editHint ? { editHint: full.editHint } : {}),
  };

  return summary;
}
