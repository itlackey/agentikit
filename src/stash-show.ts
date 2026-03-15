import { loadConfig } from "./config";
import { NotFoundError, UsageError } from "./errors";
import { buildFileContext, buildRenderContext, getRenderer, runMatchers } from "./file-context";
import { resolveSourcesForOrigin } from "./origin-resolve";
import type { StashProvider } from "./stash-provider";
import { resolveStashProviderFactory } from "./stash-provider-registry";
import { parseAssetRef } from "./stash-ref";
import { resolveAssetPath } from "./stash-resolve";
import { buildEditHint, findSourceForPath, isEditable, resolveStashSources } from "./stash-source";
import type { KnowledgeView, ShowResponse } from "./stash-types";

// Eagerly import stash providers to trigger self-registration
import "./stash-providers/openviking";

/**
 * Unified show: routes to the first stash provider that can handle the ref.
 * viking:// refs are handled by OpenViking provider; everything else by filesystem show.
 */
export async function agentikitShowUnified(input: { ref: string; view?: KnowledgeView }): Promise<ShowResponse> {
  const ref = input.ref.trim();

  // Try stash providers first (e.g. OpenViking for viking:// URIs)
  const provider = resolveShowProvider(ref);
  if (provider) {
    return provider.show(ref, input.view);
  }

  // Default: local filesystem show
  return agentikitShow(input);
}

/**
 * Check if any registered stash provider can handle this ref.
 */
function resolveShowProvider(ref: string): StashProvider | null {
  const config = loadConfig();

  // Check stashes config
  if (config.stashes) {
    for (const entry of config.stashes) {
      if (entry.enabled === false) continue;
      const factory = resolveStashProviderFactory(entry.type);
      if (factory) {
        const provider = factory(entry);
        if (provider.canShow(ref)) return provider;
      }
    }
  }

  // Legacy: check remoteStashSources
  if (!config.stashes && config.remoteStashSources) {
    for (const entry of config.remoteStashSources) {
      if (entry.enabled === false) continue;
      const providerType = entry.provider ?? "openviking";
      const factory = resolveStashProviderFactory(providerType);
      if (factory) {
        const provider = factory({
          type: providerType,
          url: entry.url,
          name: entry.name,
          enabled: entry.enabled,
          options: entry.options,
        });
        if (provider.canShow(ref)) return provider;
      }
    }
  }

  return null;
}

export async function agentikitShow(input: { ref: string; view?: KnowledgeView }): Promise<ShowResponse> {
  const parsed = parseAssetRef(input.ref);
  const displayType = parsed.type;
  const config = loadConfig();
  const allSources = resolveStashSources();
  const searchSources = resolveSourcesForOrigin(parsed.origin, allSources);

  const allStashDirs = searchSources.map((s) => s.path);

  let assetPath: string | undefined;
  let lastError: Error | undefined;
  for (const dir of allStashDirs) {
    try {
      assetPath = resolveAssetPath(dir, parsed.type, parsed.name);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (!assetPath && parsed.origin && searchSources.length === 0) {
    const installCmd = `akm add ${parsed.origin}`;
    throw new NotFoundError(
      `Stash asset not found for ref: ${displayType}:${parsed.name}. ` +
        `Kit "${parsed.origin}" is not installed. Run: ${installCmd}`,
    );
  }

  if (!assetPath) {
    throw lastError ?? new NotFoundError(`Stash asset not found for ref: ${displayType}:${parsed.name}`);
  }

  const source = findSourceForPath(assetPath, allSources);
  const sourceStashDir = source?.path ?? allStashDirs[0];

  if (!sourceStashDir) {
    throw new UsageError(`Could not determine stash root for asset: ${displayType}:${parsed.name}`);
  }

  const fileCtx = buildFileContext(sourceStashDir, assetPath);
  const match = runMatchers(fileCtx);
  if (!match) {
    throw new UsageError(
      `Could not display asset "${displayType}:${parsed.name}" — unsupported file type or unrecognized layout`,
    );
  }

  match.meta = { ...match.meta, name: parsed.name, view: input.view };
  const renderer = getRenderer(match.renderer);
  if (!renderer) {
    throw new UsageError(`Renderer "${match.renderer}" not found for asset: ${displayType}:${parsed.name}`);
  }

  const renderCtx = buildRenderContext(fileCtx, match, allStashDirs);
  const response = renderer.buildShowResponse(renderCtx);
  const editable = isEditable(assetPath, config);
  return {
    ...response,
    origin: source?.registryId ?? null,
    editable,
    ...(!editable ? { editHint: buildEditHint(assetPath, parsed.type, parsed.name, source?.registryId) } : {}),
  };
}
